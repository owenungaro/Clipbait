import { screen } from 'electron'
import { spawn } from 'node:child_process'
import type { DisplayInfo } from '@shared/types'
import { ffmpegPath } from './ffmpeg'

/**
 * ddagrab addresses monitors by DXGI output index, which Electron does not
 * expose. DXGI enumerates outputs in desktop layout order, so ordering by
 * position left-to-right then top-to-bottom matches it on every normal setup.
 * Where it does not, `grabPreviewFrame` lets the UI show what an index really
 * sees, so the user can pick by eye instead of trusting the guess.
 */
export function listDisplays(): DisplayInfo[] {
  const displays = screen.getAllDisplays()
  const primaryId = screen.getPrimaryDisplay().id

  const ordered = [...displays].sort(
    (a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y
  )

  return ordered.map((d, captureIndex) => {
    const width = Math.round(d.bounds.width * d.scaleFactor)
    const height = Math.round(d.bounds.height * d.scaleFactor)
    const isPrimary = d.id === primaryId
    return {
      id: String(d.id),
      label: `${isPrimary ? 'Primary' : `Display ${captureIndex + 1}`} · ${width}×${height}`,
      width,
      height,
      scaleFactor: d.scaleFactor,
      isPrimary,
      captureIndex,
      bounds: { ...d.bounds }
    }
  })
}

/** Resolve the configured display setting to a concrete monitor. */
export function resolveDisplay(displayId: string): DisplayInfo {
  const all = listDisplays()
  if (displayId !== 'primary') {
    const found = all.find((d) => d.id === displayId)
    if (found) return found
  }
  return all.find((d) => d.isPrimary) ?? all[0]
}

export function secondaryDisplay(): DisplayInfo | null {
  const all = listDisplays()
  return all.find((d) => !d.isPrimary) ?? null
}

/**
 * Capture one frame from a given ddagrab output index and return it as a
 * data URL, so the settings screen can prove which monitor an index maps to.
 */
export function grabPreviewFrame(captureIndex: number): Promise<string | null> {
  return new Promise((resolve) => {
    let bin: string
    try {
      bin = ffmpegPath()
    } catch {
      return resolve(null)
    }

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-init_hw_device', 'd3d11va',
      '-filter_complex',
      `ddagrab=output_idx=${captureIndex}:framerate=5:draw_mouse=0,hwdownload,format=bgra,scale=480:-2`,
      '-frames:v', '1',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '6',
      'pipe:1'
    ]

    const child = spawn(bin, args, { windowsHide: true })
    const chunks: Buffer[] = []
    let settled = false
    const done = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done(null)
    }, 8_000)

    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.resume()
    child.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const buf = Buffer.concat(chunks)
      done(buf.length > 0 ? `data:image/jpeg;base64,${buf.toString('base64')}` : null)
    })
  })
}
