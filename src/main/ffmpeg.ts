import { app } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { unzipSync } from 'fflate'
import type { EncoderInfo, FfmpegStatus } from '@shared/types'

const SOURCES = [
  {
    label: 'BtbN FFmpeg-Builds',
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
  },
  {
    label: 'gyan.dev',
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
  }
]

let status: FfmpegStatus = {
  state: 'missing',
  path: null,
  version: null,
  progress: 0,
  message: null
}
const listeners = new Set<(s: FfmpegStatus) => void>()

export function onFfmpegStatus(fn: (s: FfmpegStatus) => void): () => void {
  listeners.add(fn)
  fn(status)
  return () => listeners.delete(fn)
}

export function getFfmpegStatus(): FfmpegStatus {
  return status
}

function setStatus(patch: Partial<FfmpegStatus>): void {
  status = { ...status, ...patch }
  for (const fn of listeners) fn(status)
}

function binDir(): string {
  return path.join(app.getPath('userData'), 'ffmpeg')
}

function candidatePaths(name: 'ffmpeg' | 'ffprobe'): string[] {
  const exe = `${name}.exe`
  return [
    // Shipped alongside a packaged build, if the installer ever bundles it.
    path.join(process.resourcesPath ?? '', 'ffmpeg', exe),
    path.join(binDir(), exe)
  ]
}

/** Resolve a binary we manage, or fall back to one already on PATH. */
export function resolveBinary(name: 'ffmpeg' | 'ffprobe'): string | null {
  for (const p of candidatePaths(name)) {
    if (p && existsSync(p)) return p
  }
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8'
  })
  if (probe.status === 0) {
    const first = probe.stdout.split(/\r?\n/).find((l) => l.trim().length > 0)
    if (first && existsSync(first.trim())) return first.trim()
  }
  return null
}

export function ffmpegPath(): string {
  const p = resolveBinary('ffmpeg')
  if (!p) throw new Error('ffmpeg is not available yet')
  return p
}

export function ffprobePath(): string | null {
  return resolveBinary('ffprobe')
}

function readVersion(bin: string): string | null {
  const out = spawnSync(bin, ['-version'], { encoding: 'utf8' })
  const line = out.stdout?.split(/\r?\n/)[0] ?? ''
  const m = line.match(/ffmpeg version (\S+)/)
  return m ? m[1] : null
}

function download(url: string, dest: string, onProgress: (frac: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = (target: string, redirects = 0): void => {
      if (redirects > 6) return reject(new Error('too many redirects'))
      https
        .get(target, { headers: { 'user-agent': 'clipbait' } }, (res) => {
          const code = res.statusCode ?? 0
          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume()
            return req(new URL(res.headers.location, target).toString(), redirects + 1)
          }
          if (code !== 200) {
            res.resume()
            return reject(new Error(`HTTP ${code} from ${target}`))
          }
          const total = Number(res.headers['content-length'] ?? 0)
          let seen = 0
          const file = createWriteStream(dest)
          res.on('data', (chunk: Buffer) => {
            seen += chunk.length
            if (total > 0) onProgress(seen / total)
          })
          res.pipe(file)
          file.on('finish', () => file.close(() => resolve()))
          file.on('error', reject)
          res.on('error', reject)
        })
        .on('error', reject)
    }
    req(url)
  })
}

/**
 * Windows 10+ ships bsdtar, which reads zip and is the fast native path. The
 * fallback used to shell out to PowerShell's Expand-Archive, but a hidden
 * powershell.exe in the capture path is exactly what heuristic antivirus
 * objects to, so extraction now falls back to an in-process unzip instead.
 */
async function unzip(zip: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const tar = spawnSync('tar', ['-xf', zip, '-C', dest], { encoding: 'utf8' })
  if (tar.status === 0) return

  try {
    const archive = new Uint8Array(await fs.readFile(zip))
    // Only ffmpeg.exe is needed; skipping the rest avoids inflating the ~150 MB
    // ffprobe.exe into memory for nothing.
    const entries = unzipSync(archive, { filter: (f) => /(^|\/)ffmpeg\.exe$/i.test(f.name) })
    const root = path.resolve(dest)
    let wrote = false
    for (const [name, bytes] of Object.entries(entries)) {
      const out = path.resolve(root, name)
      // Refuse any entry that would escape the destination (zip-slip).
      if (out !== root && !out.startsWith(root + path.sep)) continue
      await fs.mkdir(path.dirname(out), { recursive: true })
      await fs.writeFile(out, bytes)
      wrote = true
    }
    if (!wrote) throw new Error('archive did not contain ffmpeg.exe')
  } catch (err) {
    const detail = tar.stderr || (err instanceof Error ? err.message : String(err))
    throw new Error(`could not extract archive: ${detail || 'unknown error'}`)
  }
}

async function findExe(root: string, name: string): Promise<string | null> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      const nested = await findExe(full, name)
      if (nested) return nested
    } else if (e.name.toLowerCase() === name.toLowerCase()) {
      return full
    }
  }
  return null
}

let ensuring: Promise<void> | null = null

/** Make sure ffmpeg + ffprobe exist, downloading them on first launch. */
export function ensureFfmpeg(): Promise<void> {
  if (ensuring) return ensuring
  ensuring = (async () => {
    const existing = resolveBinary('ffmpeg')
    if (existing) {
      setStatus({
        state: 'ready',
        path: existing,
        version: readVersion(existing),
        progress: 1,
        message: null
      })
      return
    }

    const tmp = path.join(app.getPath('temp'), `clipbait-ffmpeg-${process.pid}`)
    await fs.mkdir(tmp, { recursive: true })
    const zip = path.join(tmp, 'ffmpeg.zip')

    let lastError: unknown = null
    for (const source of SOURCES) {
      try {
        setStatus({
          state: 'downloading',
          progress: 0,
          message: `Downloading FFmpeg from ${source.label}`
        })
        await download(source.url, zip, (frac) =>
          setStatus({ progress: Math.min(0.9, frac * 0.9) })
        )
        setStatus({ progress: 0.92, message: 'Extracting FFmpeg' })
        const extractTo = path.join(tmp, 'x')
        await unzip(zip, extractTo)

        const ffmpeg = await findExe(extractTo, 'ffmpeg.exe')
        if (!ffmpeg) throw new Error('archive did not contain ffmpeg.exe')

        await fs.mkdir(binDir(), { recursive: true })
        await fs.copyFile(ffmpeg, path.join(binDir(), 'ffmpeg.exe'))
        // ffprobe is deliberately not kept: it is another 145 MB and every
        // question we would ask it, ffmpeg can answer.

        const final = path.join(binDir(), 'ffmpeg.exe')
        setStatus({
          state: 'ready',
          path: final,
          version: readVersion(final),
          progress: 1,
          message: null
        })
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
        return
      } catch (err) {
        lastError = err
      }
    }

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    setStatus({
      state: 'error',
      progress: 0,
      message:
        lastError instanceof Error
          ? lastError.message
          : 'Could not download FFmpeg. Check your connection, or install FFmpeg and put it on PATH.'
    })
    throw lastError ?? new Error('ffmpeg unavailable')
  })().finally(() => {
    ensuring = null
  })
  return ensuring
}

/* ---------------------------------------------------------------- encoders */

const ENCODER_TABLE: Omit<EncoderInfo, 'available'>[] = [
  {
    id: 'nvenc',
    ffmpegName: 'h264_nvenc',
    label: 'NVIDIA NVENC',
    detail: 'Dedicated encoder on GeForce and RTX cards. Near-zero game impact.',
    hardware: true
  },
  {
    id: 'qsv',
    ffmpegName: 'h264_qsv',
    label: 'Intel Quick Sync',
    detail: 'Dedicated encoder on Intel integrated graphics and Arc.',
    hardware: true
  },
  {
    id: 'amf',
    ffmpegName: 'h264_amf',
    label: 'AMD AMF',
    detail: 'Dedicated encoder on Radeon cards.',
    hardware: true
  },
  {
    id: 'x264',
    ffmpegName: 'libx264',
    label: 'x264 software',
    detail: 'Runs on the CPU. Always works, but costs frames in demanding games.',
    hardware: false
  }
]

function tryEncode(bin: string, encoder: string): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'testsrc2=size=640x360:rate=30',
      '-frames:v', '12',
      '-c:v', encoder,
      '-f', 'null',
      '-'
    ]
    const child = spawn(bin, args, { windowsHide: true })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

let encoderCache: EncoderInfo[] | null = null

export async function probeEncoders(force = false): Promise<EncoderInfo[]> {
  if (encoderCache && !force) return encoderCache
  const bin = resolveBinary('ffmpeg')
  if (!bin) return ENCODER_TABLE.map((e) => ({ ...e, available: false }))

  // The build has to expose the encoder before it is worth actually running it.
  const listed = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? ''

  const results: EncoderInfo[] = []
  for (const entry of ENCODER_TABLE) {
    const compiledIn = listed.includes(entry.ffmpegName)
    const available = compiledIn ? await tryEncode(bin, entry.ffmpegName) : false
    results.push({ ...entry, available })
  }
  encoderCache = results
  return results
}

/** Pick the best working encoder, honouring an explicit user choice when it works. */
export async function selectEncoder(
  preference: 'auto' | 'nvenc' | 'qsv' | 'amf' | 'x264'
): Promise<EncoderInfo> {
  const encoders = await probeEncoders()
  if (preference !== 'auto') {
    const wanted = encoders.find((e) => e.id === preference)
    if (wanted?.available) return wanted
  }
  const best = encoders.find((e) => e.available && e.hardware) ?? encoders.find((e) => e.available)
  if (best) return best
  // Nothing probed clean; libx264 is the least-bad guess so the user sees a real error later.
  return { ...ENCODER_TABLE[3], available: false }
}

/** True when this machine can use Desktop Duplication capture (fast path). */
let ddagrabCache: boolean | null = null
export async function supportsDdagrab(): Promise<boolean> {
  if (ddagrabCache !== null) return ddagrabCache
  const bin = resolveBinary('ffmpeg')
  if (!bin) return false
  const filters = spawnSync(bin, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? ''
  if (!filters.includes('ddagrab')) {
    ddagrabCache = false
    return false
  }
  ddagrabCache = await new Promise<boolean>((resolve) => {
    const child = spawn(
      bin,
      [
        '-hide_banner', '-loglevel', 'error',
        '-init_hw_device', 'd3d11va',
        '-filter_complex', 'ddagrab=output_idx=0:framerate=30,hwdownload,format=bgra',
        '-frames:v', '4',
        '-f', 'null', '-'
      ],
      { windowsHide: true }
    )
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
  return ddagrabCache
}
