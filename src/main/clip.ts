import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Clip, Settings } from '@shared/types'
import { cacheDir } from './config'
import { ffmpegPath, ffprobePath } from './ffmpeg'
import type { Recorder } from './recorder'
import { foregroundApp, foregroundExe } from './foreground'
import { classify } from './classify'

function run(
  bin: string,
  args: string[],
  opts: { capture?: 'stdout' | 'none'; timeoutMs?: number } = {}
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    const out: Buffer[] = []
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000)

    if (opts.capture === 'stdout') child.stdout.on('data', (c: Buffer) => out.push(c))
    else child.stdout.resume()

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (t: string) => {
      err += t
      if (err.length > 8000) err = err.slice(-8000)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err })
    })
  })
}

/** Strip characters Windows will not accept, and collapse the leftovers. */
function sanitize(part: string): string {
  return part
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '')
    .trim()
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function renderFilename(template: string, ctx: { app: string | null; display: string }): string {
  const now = new Date()
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`

  const replaced = template
    .replace(/\{date\}/gi, date)
    .replace(/\{time\}/gi, time)
    .replace(/\{datetime\}/gi, `${date} ${time}`)
    .replace(/\{app\}/gi, ctx.app ?? 'Clip')
    .replace(/\{display\}/gi, ctx.display)
    .replace(/\{n\}/gi, '')

  const cleaned = sanitize(replaced)
  return cleaned.length > 0 ? cleaned : `Clip ${date} ${time}`
}

/** Add ` (2)`, ` (3)` … until the name is free. */
async function uniquePath(folder: string, base: string, ext: string): Promise<string> {
  let candidate = path.join(folder, `${base}${ext}`)
  let n = 2
  while (true) {
    try {
      await fs.access(candidate)
      candidate = path.join(folder, `${base} (${n})${ext}`)
      n += 1
    } catch {
      return candidate
    }
  }
}

interface ProbeResult {
  duration: number
  width: number
  height: number
}

/**
 * Read duration and dimensions without ffprobe.
 *
 * `ffmpeg -i file` with no output prints the stream summary to stderr and
 * exits non-zero without decoding anything. Parsing that saves shipping a
 * second 145 MB binary purely to read three numbers.
 */
async function probeWithFfmpeg(file: string): Promise<ProbeResult> {
  const fallback = { duration: 0, width: 0, height: 0 }
  try {
    const { stderr } = await run(ffmpegPath(), ['-hide_banner', '-i', file], {
      timeoutMs: 20_000
    })
    const time = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
    const size = stderr.match(/Stream #\d+:\d+.*?Video:.*?,\s*(\d{2,5})x(\d{2,5})/)
    return {
      duration: time
        ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])
        : 0,
      width: size ? Number(size[1]) : 0,
      height: size ? Number(size[2]) : 0
    }
  } catch {
    return fallback
  }
}

async function probe(file: string): Promise<ProbeResult> {
  const bin = ffprobePath()
  // ffprobe is used when the user already has one on PATH; otherwise ffmpeg
  // answers the same question and is the only binary we ship.
  if (!bin) return probeWithFfmpeg(file)
  const fallback = { duration: 0, width: 0, height: 0 }
  try {
    const { code, stdout } = await run(
      bin,
      [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        file
      ],
      { capture: 'stdout', timeoutMs: 20_000 }
    )
    if (code !== 0) return probeWithFfmpeg(file)
    const json = JSON.parse(stdout.toString('utf8')) as {
      format?: { duration?: string }
      streams?: { codec_type?: string; width?: number; height?: number }[]
    }
    const video = json.streams?.find((s) => s.codec_type === 'video')
    return {
      duration: Number.parseFloat(json.format?.duration ?? '0') || 0,
      width: video?.width ?? 0,
      height: video?.height ?? 0
    }
  } catch {
    return fallback
  }
}

async function thumbnail(file: string, atSeconds: number): Promise<string | null> {
  try {
    const { code, stdout } = await run(
      ffmpegPath(),
      [
        '-hide_banner', '-loglevel', 'error',
        '-ss', atSeconds.toFixed(2),
        '-i', file,
        '-frames:v', '1',
        // Kept small on purpose: thumbnails live inside the clip library JSON
        // and travel over IPC, so every kilobyte is paid for repeatedly.
        '-vf', 'scale=420:-2',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', '6',
        'pipe:1'
      ],
      { capture: 'stdout', timeoutMs: 25_000 }
    )
    if (code !== 0 || stdout.length === 0) return null
    return `data:image/jpeg;base64,${stdout.toString('base64')}`
  } catch {
    return null
  }
}

export class NoFootageError extends Error {
  constructor() {
    super('Nothing in the buffer yet. Give it a few seconds after arming.')
    this.name = 'NoFootageError'
  }
}

/**
 * Cut the last `bufferSeconds` out of the ring and write it as an mp4.
 *
 * Every segment starts on a keyframe, so this is a stream copy: a 60 second
 * clip is written in well under a second regardless of length or resolution.
 */
export async function saveClip(recorder: Recorder, settings: Settings): Promise<Clip> {
  const wanted = settings.capture.bufferSeconds
  const { segments, coveredSeconds } = recorder.snapshot(wanted)
  const usable = segments.filter((s) => s.bytes > 0)
  if (usable.length === 0) throw new NoFootageError()

  await fs.mkdir(settings.output.folder, { recursive: true })
  await fs.mkdir(cacheDir(), { recursive: true })

  const listPath = path.join(cacheDir(), `concat-${randomUUID()}.txt`)
  const body = usable
    .map((s) => `file '${s.path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n')
  await fs.writeFile(listPath, `${body}\n`, 'utf8')

  const status = recorder.getStatus()
  const source = foregroundApp()
  const category = classify(source, foregroundExe(), settings.library.categoryOverrides)
  const base = renderFilename(settings.output.filenameTemplate, {
    app: source,
    display: status.display?.label.split(' · ')[0] ?? 'Display'
  })
  const outPath = await uniquePath(settings.output.folder, base, '.mp4')

  // Trim the lead-in so the clip is the requested length rather than a whole
  // number of segments. Seeking lands on a segment boundary, which is a
  // keyframe, so this stays a copy.
  const lead = Math.max(0, coveredSeconds - wanted)

  const copyArgs = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'concat',
    '-safe', '0',
    ...(lead > 0.25 ? ['-ss', lead.toFixed(3)] : []),
    '-i', listPath,
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    '-y', outPath
  ]

  let result = await run(ffmpegPath(), copyArgs, { timeoutMs: 120_000 })

  if (result.code !== 0) {
    // Stream copy can refuse a ragged tail segment. Re-encoding is slower but
    // always produces a playable file.
    result = await run(
      ffmpegPath(),
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-f', 'concat',
        '-safe', '0',
        ...(lead > 0.25 ? ['-ss', lead.toFixed(3)] : []),
        '-i', listPath,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '192k',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y', outPath
      ],
      { timeoutMs: 300_000 }
    )
  }

  await fs.rm(listPath, { force: true }).catch(() => {})

  if (result.code !== 0) {
    throw new Error(result.stderr.split('\n').slice(-4).join('\n') || 'FFmpeg could not write the clip')
  }

  const [info, stat] = await Promise.all([probe(outPath), fs.stat(outPath)])
  const duration = info.duration || Math.min(wanted, coveredSeconds)
  const thumb = await thumbnail(outPath, Math.max(0, duration * 0.5))

  return {
    id: randomUUID(),
    path: outPath,
    filename: path.basename(outPath),
    source,
    category,
    thumbnailDataUrl: thumb,
    durationSeconds: duration,
    bytes: stat.size,
    width: info.width,
    height: info.height,
    createdAt: Date.now(),
    share: { status: 'none' }
  }
}
