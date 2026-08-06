import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DisplayInfo, EncoderInfo, EngineState, EngineStatus, Settings } from '@shared/types'
import { segmentDir } from './config'
import { ffmpegPath, selectEncoder, supportsDdagrab } from './ffmpeg'
import { resolveDisplay } from './displays'
import { foregroundApp, startForegroundTracking, stopForegroundTracking } from './foreground'

/** Each ring slot is this long. Short enough to keep clip edges tight, long
 *  enough that we are not churning thousands of files an hour. */
const SEGMENT_SECONDS = 2
/** Keyframe cadence is pinned to the segment length so every segment starts
 *  with an I-frame — that is what lets clips be cut without re-encoding. */
const AUDIO_SAMPLE_RATE = 48_000
const AUDIO_CHANNELS = 2

export interface RingSegment {
  path: string
  index: number
  startedAt: number
  durationSeconds: number
  bytes: number
  /** False while ffmpeg is still appending to this file. */
  complete: boolean
}

const RES_HEIGHTS: Record<string, number | null> = {
  native: null,
  '1440p': 1440,
  '1080p': 1080,
  '720p': 720
}

function even(n: number): number {
  return n % 2 === 0 ? n : n - 1
}

/** Work out the encode resolution, preserving aspect ratio. */
function targetSize(display: DisplayInfo, choice: string): { w: number; h: number } | null {
  const cap = RES_HEIGHTS[choice] ?? null
  if (cap === null || display.height <= cap) return null
  const scale = cap / display.height
  return { w: even(Math.round(display.width * scale)), h: even(cap) }
}

function encoderArgs(enc: EncoderInfo, s: Settings, fps: number): string[] {
  const gop = String(Math.max(2, Math.round(fps * SEGMENT_SECONDS)))
  const byQuality = s.capture.rateControl === 'quality'
  const q = s.capture.quality
  const kbps = Math.round(s.capture.bitrateMbps * 1000)

  switch (enc.id) {
    case 'nvenc':
      return [
        '-c:v', 'h264_nvenc',
        '-preset', 'p5',
        '-tune', 'hq',
        '-profile:v', 'high',
        '-rc', byQuality ? 'constqp' : 'cbr',
        ...(byQuality
          ? ['-qp', String(q)]
          : ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`]),
        '-bf', '2',
        '-g', gop
      ]
    case 'qsv':
      return [
        '-c:v', 'h264_qsv',
        '-preset', 'veryfast',
        '-profile:v', 'high',
        ...(byQuality
          ? ['-global_quality', String(q), '-look_ahead', '0']
          : ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`]),
        '-g', gop
      ]
    case 'amf':
      return [
        '-c:v', 'h264_amf',
        '-quality', 'balanced',
        '-profile:v', 'high',
        ...(byQuality
          ? ['-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q)]
          : ['-rc', 'cbr', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`]),
        '-g', gop
      ]
    default:
      return [
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-profile:v', 'high',
        ...(byQuality ? ['-crf', String(q)] : ['-b:v', `${kbps}k`, '-maxrate', `${kbps}k`]),
        '-pix_fmt', 'yuv420p',
        '-g', gop
      ]
  }
}

export class Recorder extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private state: EngineState = 'idle'
  private stateSince: number | null = null
  private ring: RingSegment[] = []
  private nextIndex = 0
  private pollTimer: NodeJS.Timeout | null = null
  private errorText: string | null = null
  private stderrTail: string[] = []
  private useDdagrab = true
  private startedAt = 0
  private settings: Settings
  private display: DisplayInfo | null = null
  private encoder: EncoderInfo | null = null
  private telemetry = { fps: 0, bitrateKbps: 0, dropped: 0 }
  private audioLevel = 0
  private audioActive = false
  private restarting = false
  private lastAudioAt = 0
  private silenceTimer: NodeJS.Timeout | null = null

  constructor(settings: Settings) {
    super()
    this.settings = settings
  }

  setSettings(next: Settings): void {
    this.settings = next
  }

  isArmed(): boolean {
    return this.state === 'armed' || this.state === 'preparing'
  }

  getStatus(): EngineStatus {
    const buffered = this.ring.reduce((sum, s) => sum + s.durationSeconds, 0)

    // The segment muxer often reports bitrate as N/A, so measure it from what
    // actually landed on disk instead. Bytes in the ring are ground truth.
    const ringBytes = this.ring.reduce((sum, s) => sum + s.bytes, 0)
    const measuredKbps =
      buffered > 1 ? Math.round((ringBytes * 8) / buffered / 1000) : 0
    const bitrateKbps = measuredKbps > 0 ? measuredKbps : this.telemetry.bitrateKbps

    return {
      state: this.state,
      since: this.stateSince,
      encoder: this.encoder?.ffmpegName ?? null,
      encoderLabel: this.encoder?.label ?? null,
      display: this.display
        ? {
            id: this.display.id,
            label: this.display.label,
            width: this.display.width,
            height: this.display.height
          }
        : null,
      fps: this.telemetry.fps,
      targetFps: this.settings.capture.fps,
      bitrateKbps,
      droppedFrames: this.telemetry.dropped,
      bufferedSeconds: Math.min(buffered, this.settings.capture.bufferSeconds),
      bufferCapacitySeconds: this.settings.capture.bufferSeconds,
      segments: this.ring.map((s) => ({
        startedAt: s.startedAt,
        durationSeconds: s.durationSeconds,
        bytes: s.bytes
      })),
      audio: {
        desktop: this.settings.audio.desktopEnabled,
        mic: this.settings.audio.micEnabled,
        // Level reports what is actually arriving, which is how the user can
        // tell a configured source from a working one.
        level: this.audioActive ? this.audioLevel : 0
      },
      foregroundApp: foregroundApp(),
      error: this.errorText
    }
  }

  private setState(state: EngineState, error: string | null = null): void {
    this.state = state
    this.stateSince = Date.now()
    this.errorText = error
    this.emitStatus()
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }

  /** True when the pipeline wants PCM on stdin. */
  wantsAudio(): boolean {
    return this.settings.audio.desktopEnabled || this.settings.audio.micEnabled
  }

  /** Called by the hidden audio window with interleaved s16le frames. */
  writeAudio(chunk: Buffer, level: number): void {
    this.audioLevel = level
    this.audioActive = true
    this.lastAudioAt = Date.now()
    const stdin = this.proc?.stdin
    if (stdin && !stdin.destroyed && stdin.writable) {
      stdin.write(chunk, (err) => {
        // EPIPE just means ffmpeg went away; the close handler deals with it.
        if (err && !/EPIPE|ERR_STREAM_DESTROYED/.test(String(err))) {
          console.error('[recorder] audio write', err)
        }
      })
    }
  }

  /**
   * ffmpeg reads its inputs in lockstep, so a silent audio pipe stalls the
   * muxer and stops video being written at all. If real PCM stops arriving,
   * feed silence instead — a clip with no sound beats no clip.
   */
  private startSilenceWatchdog(): void {
    this.stopSilenceWatchdog()
    if (!this.wantsAudio()) return
    this.lastAudioAt = Date.now()
    this.silenceTimer = setInterval(() => {
      const stdin = this.proc?.stdin
      if (!stdin || stdin.destroyed || !stdin.writable) return

      const gap = Date.now() - this.lastAudioAt
      if (gap < 500) return

      // Cap the catch-up so a long stall cannot dump a huge buffer at once.
      const seconds = Math.min(gap / 1000, 1)
      const frames = Math.floor(seconds * AUDIO_SAMPLE_RATE)
      this.lastAudioAt = Date.now()
      this.audioActive = false
      // A zero-filled buffer is silence in signed 16-bit PCM.
      stdin.write(Buffer.alloc(frames * AUDIO_CHANNELS * 2), () => {})
    }, 250)
  }

  private stopSilenceWatchdog(): void {
    if (this.silenceTimer) clearInterval(this.silenceTimer)
    this.silenceTimer = null
  }

  async arm(): Promise<void> {
    if (this.isArmed()) return
    this.setState('preparing')
    this.errorText = null
    this.stderrTail = []

    try {
      const dir = segmentDir()
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      await fs.mkdir(dir, { recursive: true })

      this.ring = []
      this.nextIndex = 0
      this.display = resolveDisplay(this.settings.capture.displayId)
      this.encoder = await selectEncoder(this.settings.capture.encoder)
      this.useDdagrab = await supportsDdagrab()

      await this.spawnFfmpeg()
      startForegroundTracking()
      this.startPolling()
      this.startSilenceWatchdog()
      this.setState('armed')
      if (this.wantsAudio()) this.emit('audio:start')
    } catch (err) {
      this.setState('error', err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  private buildArgs(): string[] {
    const s = this.settings
    const display = this.display!
    const fps = s.capture.fps
    const size = targetSize(display, s.capture.resolution)
    // Trailing comma so the chain reads the same whether or not it scales.
    // Scaling happens in RGB, before the conversion to nv12.
    const scale = size ? `scale=${size.w}:${size.h}:flags=bicubic,` : ''
    const cursor = s.capture.captureCursor ? 1 : 0
    const wantAudio = this.wantsAudio()

    // -nostdin must not be set when stdin carries the PCM input.
    const args: string[] = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-progress', 'pipe:1',
      '-stats_period', '0.5'
    ]
    if (!wantAudio) args.push('-nostdin')

    if (this.useDdagrab) {
      args.push('-init_hw_device', 'd3d11va')
      args.push(
        '-filter_complex',
        `ddagrab=output_idx=${display.captureIndex}:framerate=${fps}:draw_mouse=${cursor},` +
          `hwdownload,format=bgra,${scale}format=nv12[v]`
      )
    } else {
      // Desktop Duplication unavailable (remote session, unusual driver).
      // GDI capture is slower but keeps the app working.
      args.push(
        '-f', 'gdigrab',
        '-framerate', String(fps),
        '-draw_mouse', String(cursor),
        '-thread_queue_size', '1024',
        '-i', 'desktop',
        '-filter_complex', `[0:v]${scale}format=nv12[v]`
      )
    }

    if (wantAudio) {
      // Raw PCM is self-clocking: ffmpeg derives timestamps from the sample
      // count, which starts at zero and therefore shares video's timeline.
      // Stamping with the wall clock instead put audio ~1.78e9 seconds ahead
      // of video, and the muxer then buffered video without bound waiting for
      // the two to meet — several gigabytes within a minute. The silence
      // watchdog keeps the stream continuous, so sample-count timing is right.
      args.push(
        '-f', 's16le',
        '-ar', String(AUDIO_SAMPLE_RATE),
        '-ac', String(AUDIO_CHANNELS),
        '-thread_queue_size', '512',
        '-i', 'pipe:0'
      )
    }

    args.push('-map', '[v]')
    if (wantAudio) {
      const audioIndex = this.useDdagrab ? 0 : 1
      args.push('-map', `${audioIndex}:a`)
      args.push('-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_SAMPLE_RATE))
      // Gentle drift correction only. A large async window would try to fill
      // any gap with generated silence, which is how small clock differences
      // turn into enormous allocations.
      args.push('-af', 'aresample=async=1:first_pts=0')
      // Hard ceiling on how long the muxer will hold one stream waiting for
      // the other, so an audio fault can never balloon memory again.
      args.push('-max_interleave_delta', '500000')
    }

    args.push(...encoderArgs(this.encoder!, s, fps))

    args.push(
      '-f', 'segment',
      '-segment_time', String(SEGMENT_SECONDS),
      '-segment_format', 'mpegts',
      '-reset_timestamps', '1',
      path.join(segmentDir(), 'seg%06d.ts')
    )

    return args
  }

  private async spawnFfmpeg(): Promise<void> {
    const bin = ffmpegPath()
    const args = this.buildArgs()
    this.startedAt = Date.now()

    const child = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = child

    child.stdout.setEncoding('utf8')
    let progressBuf = ''
    child.stdout.on('data', (text: string) => {
      progressBuf += text
      const lines = progressBuf.split(/\r?\n/)
      progressBuf = lines.pop() ?? ''
      for (const line of lines) this.readProgress(line)
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        this.stderrTail.push(line)
        if (this.stderrTail.length > 40) this.stderrTail.shift()
      }
    })

    child.stdin.on('error', () => {
      /* ffmpeg exited; handled by close */
    })

    child.on('error', (err) => {
      this.setState('error', `Could not start FFmpeg: ${err.message}`)
    })

    child.on('close', (code) => {
      const wasArmed = this.state === 'armed' || this.state === 'preparing'
      this.proc = null
      if (this.restarting) return
      if (wasArmed && code !== 0) {
        const ranBriefly = Date.now() - this.startedAt < 4_000
        // A fast failure on the Desktop Duplication path usually means the
        // session cannot use it at all; drop to GDI once and keep going.
        if (ranBriefly && this.useDdagrab) {
          this.useDdagrab = false
          this.restartQuietly()
          return
        }
        this.stopPolling()
        this.setState(
          'error',
          this.stderrTail.slice(-6).join('\n') || `FFmpeg exited with code ${code}`
        )
        this.emit('audio:stop')
      } else if (wasArmed) {
        this.stopPolling()
        this.setState('idle')
        this.emit('audio:stop')
      }
    })
  }

  private restartQuietly(): void {
    this.restarting = true
    void this.spawnFfmpeg()
      .then(() => {
        this.restarting = false
        this.setState('armed')
      })
      .catch((err) => {
        this.restarting = false
        this.setState('error', err instanceof Error ? err.message : String(err))
      })
  }

  private readProgress(line: string): void {
    const eq = line.indexOf('=')
    if (eq < 0) return
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    switch (key) {
      case 'fps': {
        const n = Number.parseFloat(value)
        if (Number.isFinite(n)) this.telemetry.fps = n
        break
      }
      case 'bitrate': {
        const n = Number.parseFloat(value.replace(/kbits\/s/, ''))
        if (Number.isFinite(n)) this.telemetry.bitrateKbps = n
        break
      }
      case 'drop_frames': {
        const n = Number.parseInt(value, 10)
        if (Number.isFinite(n)) this.telemetry.dropped = n
        break
      }
    }
  }

  /**
   * ffmpeg does not announce segment rollover on a channel we can rely on, so
   * the ring is rebuilt from the directory. It is a handful of stat calls
   * twice a second — cheaper than watching and debouncing rename events.
   */
  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = setInterval(() => {
      void this.syncRing()
    }, 500)
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private async syncRing(): Promise<void> {
    const dir = segmentDir()
    let names: string[]
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.ts'))
    } catch {
      return
    }
    names.sort()

    const known = new Map(this.ring.map((s) => [path.basename(s.path), s]))
    const next: RingSegment[] = []

    for (let i = 0; i < names.length; i++) {
      const name = names[i]
      const full = path.join(dir, name)
      let bytes = 0
      try {
        bytes = (await fs.stat(full)).size
      } catch {
        continue
      }
      const isNewest = i === names.length - 1
      const prior = known.get(name)
      if (prior) {
        prior.bytes = bytes
        prior.complete = !isNewest
        // The live segment grows until it rolls over; estimate its length from
        // wall-clock so the UI meter moves smoothly instead of in 2s jumps.
        prior.durationSeconds = isNewest
          ? Math.min(SEGMENT_SECONDS, (Date.now() - prior.startedAt) / 1000)
          : SEGMENT_SECONDS
        next.push(prior)
      } else {
        const index = Number.parseInt(name.replace(/\D/g, ''), 10) || this.nextIndex++
        next.push({
          path: full,
          index,
          startedAt: Date.now(),
          durationSeconds: isNewest ? 0 : SEGMENT_SECONDS,
          bytes,
          complete: !isNewest
        })
      }
    }

    // Trim the tail: keep the configured window plus a segment of slack so a
    // clip taken right now still has a full buffer behind it.
    const keepSeconds = this.settings.capture.bufferSeconds + SEGMENT_SECONDS * 2
    let total = 0
    const keep: RingSegment[] = []
    for (let i = next.length - 1; i >= 0; i--) {
      if (total >= keepSeconds) {
        void fs.rm(next[i].path, { force: true }).catch(() => {})
      } else {
        total += next[i].durationSeconds
        keep.unshift(next[i])
      }
    }

    this.ring = keep
    this.emitStatus()
  }

  /** Segments covering the most recent `seconds`, oldest first. */
  snapshot(seconds: number): { segments: RingSegment[]; coveredSeconds: number } {
    const chosen: RingSegment[] = []
    let total = 0
    for (let i = this.ring.length - 1; i >= 0; i--) {
      chosen.unshift(this.ring[i])
      total += this.ring[i].durationSeconds
      if (total >= seconds) break
    }
    return { segments: chosen, coveredSeconds: total }
  }

  async disarm(): Promise<void> {
    this.stopSilenceWatchdog()
    if (!this.proc) {
      this.stopPolling()
      stopForegroundTracking()
      this.setState('idle')
      return
    }
    this.setState('stopping')
    this.emit('audio:stop')
    stopForegroundTracking()

    const child = this.proc
    await new Promise<void>((resolve) => {
      const done = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 4_000)
      child.once('close', () => {
        clearTimeout(done)
        resolve()
      })
      // 'q' on stdin is the clean shutdown path, but stdin carries PCM here,
      // so signal instead and let the timeout escalate.
      try {
        child.stdin.end()
      } catch {
        /* already gone */
      }
      child.kill('SIGTERM')
    })

    this.stopPolling()
    this.proc = null
    this.audioActive = false
    this.setState('idle')
  }

  async dispose(): Promise<void> {
    await this.disarm()
    if (!this.settings.output.keepSegments) {
      await fs.rm(segmentDir(), { recursive: true, force: true }).catch(() => {})
    }
  }
}
