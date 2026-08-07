import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  Tray
} from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Clip, ClipCategory, EngineStatus, SettingsPatch, Toast } from '@shared/types'
import { CHANNEL } from '@shared/types'
import { cacheDir, getSettings, resetSettings, updateSettings } from './config'
import { ensureFfmpeg, getFfmpegStatus, onFfmpegStatus, probeEncoders } from './ffmpeg'
import { grabPreviewFrame, listDisplays } from './displays'
import { Recorder } from './recorder'
import { NoFootageError, saveClip } from './clip'
import {
  addClip,
  getClip,
  listClips,
  recategorise,
  removeClip,
  updateClip
} from './library'
import { providerLabel, upload, UploadError } from './upload'
import {
  createAudioWindow,
  createMainWindow,
  createOverlayWindow,
  getAudioWindow,
  getMainWindow,
  getOverlayWindow,
  hideOverlay,
  positionOverlay,
  revealOverlay,
  showMainWindow
} from './windows'
import {
  checkForUpdates,
  getUpdateStatus,
  initUpdater,
  onUpdateStatus,
  quitAndInstall
} from './updater'

let recorder: Recorder
let tray: Tray | null = null
let quitting = false
let savingClip = false
let overlayTimer: NodeJS.Timeout | null = null
let overlayPinned = false
/** Which clip the overlay is currently showing, so deleting it can close it. */
let overlayClipId: string | null = null
const uploads = new Map<string, AbortController>()

/* ------------------------------------------------------------------ assets */

function resourcePath(name: string): string {
  const candidates = [
    path.join(process.resourcesPath ?? '', name),
    path.join(__dirname, '../../resources', name)
  ]
  return candidates.find((p) => p && existsSync(p)) ?? candidates[1]
}

function appIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(resourcePath('icon.png'))
}

/* -------------------------------------------------------------- broadcasts */

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function toast(kind: Toast['kind'], message: string): void {
  broadcast(CHANNEL.toast, { id: randomUUID(), kind, message } satisfies Toast)
}

/* ------------------------------------------------------------ audio bridge */

/** Send to the hidden audio window, waiting for it to finish loading first. */
function sendToAudio(channel: string, payload?: unknown): void {
  const win = createAudioWindow()
  const deliver = (): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver)
  else deliver()
}

function startAudioCapture(): void {
  const s = getSettings()
  sendToAudio(CHANNEL.audioStart, {
    sampleRate: 48_000,
    channels: 2,
    desktopEnabled: s.audio.desktopEnabled,
    desktopGain: s.audio.desktopGain,
    micEnabled: s.audio.micEnabled,
    micDeviceId: s.audio.micDeviceId,
    micGain: s.audio.micGain
  })
}

function stopAudioCapture(): void {
  const win = getAudioWindow()
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    win.webContents.send(CHANNEL.audioStop)
  }
}

/* ----------------------------------------------------------------- engine */

function pushEngineStatus(status: EngineStatus): void {
  broadcast(CHANNEL.engineStatus, status)
  updateTray(status)
}

async function armEngine(): Promise<void> {
  if (getFfmpegStatus().state !== 'ready') {
    toast('info', 'Setting up FFmpeg first…')
    await ensureFfmpeg()
  }
  recorder.setSettings(getSettings())
  await recorder.arm()
}

async function toggleEngine(): Promise<void> {
  try {
    if (recorder.isArmed()) await recorder.disarm()
    else await armEngine()
  } catch (err) {
    toast('error', err instanceof Error ? err.message : String(err))
  }
}

async function handleSaveClip(): Promise<void> {
  if (savingClip) return
  if (!recorder.isArmed()) {
    toast('error', 'The buffer is not armed. Arm it, then clip.')
    return
  }
  savingClip = true
  try {
    const settings = getSettings()
    const clip = await saveClip(recorder, settings)
    addClip(clip)
    broadcast(CHANNEL.clipCreated, clip)
    if (settings.overlay.enabled) showOverlayFor(clip)
    if (settings.sharing.autoUpload) void shareClipById(clip.id)
    toast('success', `Saved ${clip.filename}`)
  } catch (err) {
    if (err instanceof NoFootageError) toast('error', err.message)
    else toast('error', err instanceof Error ? err.message : 'Could not save the clip.')
  } finally {
    savingClip = false
  }
}

/* ---------------------------------------------------------------- overlay */

function showOverlayFor(clip: Clip): void {
  const settings = getSettings()
  overlayPinned = false
  overlayClipId = clip.id
  if (overlayTimer) clearTimeout(overlayTimer)

  revealOverlay(settings.overlay)
  const win = getOverlayWindow()
  if (!win) return

  const deliver = (): void => {
    if (!win.isDestroyed()) win.webContents.send(CHANNEL.overlayClip, clip)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver)
  else deliver()

  scheduleOverlayHide()
}

function scheduleOverlayHide(): void {
  const seconds = getSettings().overlay.autoHideSeconds
  if (overlayTimer) clearTimeout(overlayTimer)
  if (seconds <= 0) return
  overlayTimer = setTimeout(() => {
    if (!overlayPinned) hideOverlay()
  }, seconds * 1000)
}

/* ---------------------------------------------------------------- sharing */

async function shareClipById(id: string): Promise<void> {
  const clip = getClip(id)
  if (!clip) return
  if (uploads.has(id)) return

  const settings = getSettings()
  const controller = new AbortController()
  uploads.set(id, controller)

  const emit = (patch: Partial<Clip>): void => {
    const next = updateClip(id, patch)
    if (next) broadcast(CHANNEL.clipUpdated, next)
  }

  emit({ share: { status: 'uploading', progress: 0 } })

  let lastPush = 0
  try {
    const result = await upload(
      clip.path,
      settings.sharing.provider,
      settings.sharing.litterboxExpiry,
      (fraction) => {
        const now = Date.now()
        // The renderer does not need more than a few updates a second.
        if (now - lastPush < 120 && fraction < 1) return
        lastPush = now
        emit({ share: { status: 'uploading', progress: fraction } })
      },
      controller.signal
    )
    emit({
      share: {
        status: 'ready',
        url: result.url,
        provider: result.provider,
        expiresAt: result.expiresAt
      }
    })
    if (settings.sharing.copyLinkToClipboard) {
      clipboard.writeText(result.url)
      toast('success', `${providerLabel(result.provider)} link copied to clipboard`)
    } else {
      toast('success', `Uploaded to ${providerLabel(result.provider)}`)
    }
  } catch (err) {
    const message =
      err instanceof UploadError || err instanceof Error
        ? err.message
        : 'Upload failed.'
    emit({ share: { status: 'failed', message } })
    toast('error', message)
  } finally {
    uploads.delete(id)
  }
}

/* ---------------------------------------------------------------- updates */

function installUpdate(): void {
  // Flip the guard so the main window is allowed to close instead of folding
  // back into the tray, then let electron-updater swap the install and relaunch.
  quitting = true
  quitAndInstall()
}

/* --------------------------------------------------------------- hotkeys */

let hotkeyCaptureMode = false
let hotkeyResults: Record<string, boolean> = {}

function registerHotkeys(): void {
  globalShortcut.unregisterAll()
  hotkeyResults = {}
  if (hotkeyCaptureMode) return

  const { hotkeys } = getSettings()
  const bind = (accelerator: string, action: () => void): void => {
    if (!accelerator) return
    try {
      hotkeyResults[accelerator] = globalShortcut.register(accelerator, action)
    } catch {
      hotkeyResults[accelerator] = false
    }
  }

  bind(hotkeys.saveClip, () => void handleSaveClip())
  bind(hotkeys.toggleBuffer, () => void toggleEngine())
  bind(hotkeys.openApp, () => showMainWindow())
}

/* ------------------------------------------------------------------- tray */

function updateTray(status?: EngineStatus): void {
  if (!tray) return
  const state = status?.state ?? recorder.getStatus().state
  const armed = state === 'armed'
  const { hotkeys } = getSettings()

  const update = getUpdateStatus()
  const updateReady: Electron.MenuItemConstructorOptions[] =
    update.state === 'downloaded'
      ? [
          {
            label: `Restart to update${update.version ? ` to v${update.version}` : ''}`,
            click: () => installUpdate()
          },
          { type: 'separator' }
        ]
      : []

  tray.setToolTip(armed ? `Clipbait — armed (${hotkeys.saveClip} to clip)` : 'Clipbait — idle')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...updateReady,
      {
        label: armed ? 'Disarm buffer' : 'Arm buffer',
        click: () => void toggleEngine()
      },
      {
        label: `Save clip  (${hotkeys.saveClip})`,
        enabled: armed,
        click: () => void handleSaveClip()
      },
      { type: 'separator' },
      { label: 'Open Clipbait', click: () => showMainWindow() },
      {
        label: 'Open clips folder',
        click: () => void shell.openPath(getSettings().output.folder)
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

function createTray(): void {
  const icon = nativeImage.createFromPath(resourcePath('tray.png'))
  tray = new Tray(icon.isEmpty() ? appIcon() : icon)
  tray.on('click', () => showMainWindow())
  updateTray()
}

/* -------------------------------------------------------------------- ipc */

function registerIpc(): void {
  ipcMain.handle('settings:get', () => getSettings())

  ipcMain.handle('settings:update', (_e, patch: SettingsPatch) => {
    const before = getSettings()
    const next = updateSettings(patch)
    recorder.setSettings(next)
    broadcast(CHANNEL.settingsChanged, next)

    if (patch.hotkeys) registerHotkeys()
    if (patch.overlay) positionOverlay(next.overlay)
    if (patch.general?.launchOnStartup !== undefined) {
      app.setLoginItemSettings({
        openAtLogin: next.general.launchOnStartup,
        args: ['--hidden']
      })
    }

    // Capture and audio changes only take effect on a fresh ffmpeg process.
    const captureChanged =
      patch.capture !== undefined &&
      JSON.stringify(before.capture) !== JSON.stringify(next.capture)
    const audioChanged =
      patch.audio !== undefined && JSON.stringify(before.audio) !== JSON.stringify(next.audio)

    if (recorder.isArmed() && (captureChanged || audioChanged)) {
      void (async () => {
        await recorder.disarm()
        await armEngine().catch((err) =>
          toast('error', err instanceof Error ? err.message : String(err))
        )
      })()
    }
    return next
  })

  ipcMain.handle('settings:reset', () => {
    const next = resetSettings()
    recorder.setSettings(next)
    registerHotkeys()
    broadcast(CHANNEL.settingsChanged, next)
    return next
  })

  ipcMain.handle('engine:get', () => recorder.getStatus())
  ipcMain.handle('engine:arm', () => armEngine())
  ipcMain.handle('engine:disarm', () => recorder.disarm())
  ipcMain.handle('engine:save', () => handleSaveClip())

  ipcMain.handle('ffmpeg:get', () => getFfmpegStatus())
  ipcMain.handle('ffmpeg:install', () => ensureFfmpeg())

  ipcMain.handle('displays:list', () => listDisplays())
  ipcMain.handle('displays:preview', (_e, captureIndex: number) =>
    grabPreviewFrame(captureIndex)
  )
  ipcMain.handle('encoders:list', (_e, force: boolean) => probeEncoders(force))

  ipcMain.handle('clips:list', () => listClips())
  ipcMain.handle('clips:share', (_e, id: string) => shareClipById(id))
  ipcMain.handle('clips:cancelShare', (_e, id: string) => {
    uploads.get(id)?.abort()
  })
  ipcMain.handle('clips:reveal', (_e, id: string) => {
    const clip = getClip(id)
    if (clip) shell.showItemInFolder(clip.path)
  })
  ipcMain.handle('clips:open', (_e, id: string) => {
    const clip = getClip(id)
    if (clip) void shell.openPath(clip.path)
  })
  ipcMain.handle('clips:setCategory', (_e, source: string, category: ClipCategory) => {
    // Remember the correction so future clips from this source land right,
    // then restate every clip already in the library.
    const next = updateSettings({
      library: {
        categoryOverrides: {
          ...getSettings().library.categoryOverrides,
          [source]: category
        }
      }
    })
    recorder.setSettings(next)
    broadcast(CHANNEL.settingsChanged, next)
    broadcast(CHANNEL.clipsReloaded, recategorise(source, category))
  })

  ipcMain.handle('clips:delete', async (_e, id: string) => {
    uploads.get(id)?.abort()
    await removeClip(id, true)
    // Without this the card stays on screen until the window is reopened.
    broadcast(CHANNEL.clipRemoved, id)
    if (overlayClipId === id) hideOverlay()
  })

  ipcMain.on('clips:drag', (event, id: string) => {
    const clip = getClip(id)
    if (!clip) return
    const icon = clip.thumbnailDataUrl
      ? nativeImage.createFromDataURL(clip.thumbnailDataUrl).resize({ width: 160 })
      : appIcon()
    // startDrag needs a non-empty icon or Windows refuses the drag.
    event.sender.startDrag({ file: clip.path, icon: icon.isEmpty() ? appIcon() : icon })
  })

  ipcMain.handle('clipboard:copy', (_e, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.on('overlay:dismiss', () => {
    if (overlayTimer) clearTimeout(overlayTimer)
    hideOverlay()
  })

  ipcMain.handle('overlay:preview', async () => {
    const recent = await listClips()
    if (recent.length > 0) showOverlayFor(recent[0])
  })

  ipcMain.on('overlay:pin', (_e, pinned: boolean) => {
    overlayPinned = pinned
    if (!pinned) scheduleOverlayHide()
    else if (overlayTimer) clearTimeout(overlayTimer)
  })

  ipcMain.on('audio:pcm', (_e, buffer: ArrayBuffer, level: number) => {
    recorder.writeAudio(Buffer.from(buffer), level)
  })

  ipcMain.on('audio:error', (_e, message: string) => {
    toast('error', `Audio capture: ${message}`)
  })

  ipcMain.handle('dialog:folder', async (_e, current: string) => {
    const win = getMainWindow()
    const result = await (win
      ? dialog.showOpenDialog(win, {
          defaultPath: current,
          properties: ['openDirectory', 'createDirectory']
        })
      : dialog.showOpenDialog({
          defaultPath: current,
          properties: ['openDirectory', 'createDirectory']
        }))
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('shell:openPath', (_e, target: string) => shell.openPath(target))
  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))

  ipcMain.handle('hotkeys:capture', (_e, active: boolean) => {
    hotkeyCaptureMode = active
    registerHotkeys()
  })
  ipcMain.handle('hotkeys:conflicts', () => hotkeyResults)

  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.on('app:quit', () => {
    quitting = true
    app.quit()
  })

  ipcMain.handle('update:get', () => getUpdateStatus())
  ipcMain.handle('update:check', () => checkForUpdates(true))
  ipcMain.handle('update:install', () => installUpdate())
}

/* ------------------------------------------------------------- lifecycle */

// The audio host is a hidden window that never receives a click, and Chromium
// refuses to start an AudioContext without user activation by default. Without
// this the loopback graph never renders and no PCM ever reaches ffmpeg.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.clipbait.app')

    // Grant loopback (system) audio to getDisplayMedia calls from the hidden
    // audio window. Windows-only, and the reason desktop sound works at all.
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ['screen'] })
          .then((sources) => {
            if (sources.length === 0) return callback({})
            callback({ video: sources[0], audio: 'loopback' })
          })
          .catch(() => callback({}))
      },
      { useSystemPicker: false }
    )

    // The hidden audio window asks for a microphone; nothing else should.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media')
    })

    // Lock the renderers down in packaged builds. Dev is left alone because
    // Vite's HMR client needs inline scripts and a websocket back to itself.
    if (app.isPackaged) {
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [
              // blob: is required for the AudioWorklet module, which is built
              // in-process and loaded from a blob URL. Without it the audio
              // graph never starts and every clip is silent.
              "default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:; " +
                "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
                "font-src 'self' data:; media-src 'self' data: blob: file:; " +
                "connect-src 'self' blob:; object-src 'none'; frame-src 'none'"
            ]
          }
        })
      })
    }

    // No application menu at all. Beyond being unused in a frameless window,
    // an auto-hidden menu bar grabs focus the moment Alt is pressed, which
    // made Alt-based combinations impossible to bind.
    Menu.setApplicationMenu(null)

    recorder = new Recorder(getSettings())
    recorder.on('status', pushEngineStatus)
    recorder.on('audio:start', startAudioCapture)
    recorder.on('audio:stop', stopAudioCapture)

    onFfmpegStatus((status) => broadcast(CHANNEL.ffmpegStatus, status))

    onUpdateStatus((update) => {
      broadcast(CHANNEL.updateStatus, update)
      updateTray()
      if (update.state === 'downloaded') {
        toast(
          'success',
          `Update${update.version ? ` v${update.version}` : ''} ready — restart Clipbait to install.`
        )
      }
    })

    registerIpc()
    registerHotkeys()
    createTray()
    createAudioWindow()
    createOverlayWindow()
    initUpdater()

    const startHidden =
      process.argv.includes('--hidden') && getSettings().general.minimizeToTray
    const mainWin = createMainWindow()
    if (startHidden) {
      mainWin.once('ready-to-show', () => mainWin.hide())
    }

    mainWin.on('close', (event) => {
      if (!quitting && getSettings().general.closeToTray) {
        event.preventDefault()
        mainWin.hide()
      }
    })

    // Fetch FFmpeg in the background so first launch is not a blank wait.
    ensureFfmpeg()
      .then(async () => {
        await probeEncoders()
        if (getSettings().general.armOnLaunch) {
          await armEngine().catch((err) =>
            toast('error', err instanceof Error ? err.message : String(err))
          )
        }
      })
      .catch(() => {
        /* status is already reported through onFfmpegStatus */
      })
  })

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    void recorder?.dispose()
  })

  app.on('window-all-closed', () => {
    // The tray keeps the app alive; quitting is explicit.
    if (!getSettings().general.minimizeToTray) app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
}

// Keep the scratch directory from growing without bound across sessions.
app.on('ready', () => {
  void import('node:fs').then(({ promises: fsp }) =>
    fsp.rm(cacheDir(), { recursive: true, force: true }).catch(() => {})
  )
})
