import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * clipbait-capture.exe: Windows Graphics Capture + a hardware H.264 encoder,
 * kept fully GPU-resident (see native/capture/). It is built separately by
 * CI (needs real MSVC) and shipped as a resource, the same way ffmpeg is
 * resolved — packaged builds look next to the app, dev builds look in the
 * repo's resources/ directory.
 */
function candidatePaths(): string[] {
  const exe = 'clipbait-capture.exe'
  return [
    path.join(process.resourcesPath ?? '', 'capture', exe),
    path.join(__dirname, '../../resources/capture', exe)
  ]
}

export function captureExePath(): string | null {
  return candidatePaths().find((p) => p && existsSync(p)) ?? null
}

let probeCache: boolean | null = null

/**
 * Whether this machine can actually run the GPU capture pipeline: WGC on
 * this Windows version, plus a hardware H.264 encoder MFT the OS will hand
 * a D3D11 device to. Cached for the process lifetime, same as ddagrab's own
 * capability probe — a monitor swap mid-session does not change the answer.
 */
export function supportsNativeCapture(monitorIndex: number): Promise<boolean> {
  if (probeCache !== null) return Promise.resolve(probeCache)
  const exe = captureExePath()
  if (!exe) return Promise.resolve((probeCache = false))

  return new Promise<boolean>((resolve) => {
    const child = spawn(
      exe,
      ['--probe', '--monitor', String(monitorIndex), '--fps', '30', '--bitrate', '8000'],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }
    )
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve((probeCache = false))
    }, 8_000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve((probeCache = false))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve((probeCache = code === 0))
    })
  })
}
