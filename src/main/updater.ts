/**
 * Auto-update against GitHub releases.
 *
 * electron-builder writes an `app-update.yml` into the packaged resources (from
 * the `publish` block in package.json), which tells electron-updater to poll the
 * project's GitHub releases for a newer `latest.yml`. When one exists the matching
 * NSIS installer is downloaded in the background and run on the next quit.
 *
 * None of this works from `electron-vite dev` — there is no packaged resource and
 * no version to compare — so every entry point is a no-op unless app.isPackaged.
 */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '@shared/types'

type Listener = (status: UpdateStatus) => void

let status: UpdateStatus = {
  state: 'idle',
  version: null,
  progress: 0,
  message: null
}

const listeners = new Set<Listener>()
let wired = false
let checking = false

function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  for (const listener of listeners) listener(status)
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

export function onUpdateStatus(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function wire(): void {
  if (wired) return
  wired = true

  // Pull the installer down as soon as an update is seen, but never restart on
  // our own — the user chooses when, either from Settings or the tray. (NSIS on
  // Windows does not gate unsigned updates, so no signature config is needed.)
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking', message: null }))
  autoUpdater.on('update-available', (info) =>
    setStatus({ state: 'available', version: info.version, message: null })
  )
  autoUpdater.on('update-not-available', () =>
    setStatus({ state: 'not-available', progress: 0, version: null, message: null })
  )
  autoUpdater.on('download-progress', (p) =>
    setStatus({ state: 'downloading', progress: (p.percent ?? 0) / 100 })
  )
  autoUpdater.on('update-downloaded', (info) =>
    setStatus({ state: 'downloaded', version: info.version, progress: 1, message: null })
  )
  autoUpdater.on('error', (err) =>
    setStatus({
      state: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  )
}

/** Wire listeners and run one quiet check a few seconds after launch. */
export function initUpdater(): void {
  if (!app.isPackaged) return
  wire()
  // Let the windows come up first so the initial status push has somewhere to land.
  setTimeout(() => void checkForUpdates(), 4000)
}

export async function checkForUpdates(manual = false): Promise<void> {
  if (!app.isPackaged) {
    if (manual) {
      setStatus({
        state: 'error',
        message: 'Updates are only available in the installed build.'
      })
    }
    return
  }
  if (checking) return
  wire()
  checking = true
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    setStatus({
      state: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  } finally {
    checking = false
  }
}

/** Quit and swap in the downloaded installer. No-op until one is ready. */
export function quitAndInstall(): void {
  if (status.state !== 'downloaded') return
  // isSilent=false shows the NSIS progress window; isForceRunAfter relaunches
  // Clipbait once the new version is in place.
  autoUpdater.quitAndInstall(false, true)
}
