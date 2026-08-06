import { BrowserWindow, screen, shell } from 'electron'
import path from 'node:path'
import type { DisplayInfo, OverlayCorner, OverlaySettings } from '@shared/types'
import { listDisplays, secondaryDisplay } from './displays'

const OVERLAY_WIDTH = 372
const OVERLAY_HEIGHT = 296
const OVERLAY_MARGIN = 24

const isDev = !!process.env['ELECTRON_RENDERER_URL']

function preload(): string {
  return path.join(__dirname, '../preload/index.js')
}

function rendererEntry(page: 'index' | 'overlay' | 'audio'): {
  url?: string
  file?: string
} {
  if (isDev) {
    const base = process.env['ELECTRON_RENDERER_URL']
    return { url: page === 'index' ? `${base}/index.html` : `${base}/${page}.html` }
  }
  return { file: path.join(__dirname, `../renderer/${page}.html`) }
}

function load(win: BrowserWindow, page: 'index' | 'overlay' | 'audio'): void {
  const entry = rendererEntry(page)
  if (entry.url) void win.loadURL(entry.url)
  else void win.loadFile(entry.file!)
}

/* ------------------------------------------------------------- main window */

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow

  // Never open larger than the space actually available. On a scaled display
  // the work area in DIPs can be a lot smaller than the panel suggests, so the
  // minimums have to bend too or Windows will oversize the window.
  const work = screen.getPrimaryDisplay().workAreaSize
  const width = Math.min(1100, Math.round(work.width * 0.94))
  const height = Math.min(780, Math.round(work.height * 0.94))

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(680, width),
    minHeight: Math.min(460, height),
    center: true,
    show: false,
    backgroundColor: '#0E0F13',
    titleBarStyle: 'hidden',
    // Native window controls, painted to match the bone titlebar.
    titleBarOverlay: {
      color: '#14151B',
      symbolColor: '#A7ABBB',
      // Matches the status bar height so the controls sit inside it.
      height: 56
    },
    autoHideMenuBar: true,
    webPreferences: {
      preload: preload(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  load(mainWindow, 'index')
  return mainWindow
}

export function showMainWindow(): void {
  const win = createMainWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/* ------------------------------------------------------------ audio window */

let audioWindow: BrowserWindow | null = null

/**
 * A hidden renderer is the only place with WebAudio access to the loopback
 * capture stream, so it acts as the audio front end for the recorder.
 */
export function createAudioWindow(): BrowserWindow {
  if (audioWindow && !audioWindow.isDestroyed()) return audioWindow

  audioWindow = new BrowserWindow({
    width: 320,
    height: 200,
    show: false,
    webPreferences: {
      preload: preload(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Hidden windows are throttled by default, which would stall the
      // audio pump the moment the app loses focus.
      backgroundThrottling: false
    }
  })

  audioWindow.on('closed', () => {
    audioWindow = null
  })

  load(audioWindow, 'audio')
  return audioWindow
}

export function getAudioWindow(): BrowserWindow | null {
  return audioWindow
}

/* ---------------------------------------------------------- overlay window */

let overlayWindow: BrowserWindow | null = null

function overlayDisplay(settings: OverlaySettings): DisplayInfo {
  const all = listDisplays()
  if (settings.target === 'primary') {
    return all.find((d) => d.isPrimary) ?? all[0]
  }
  if (settings.target === 'active') {
    const point = screen.getCursorScreenPoint()
    const active = screen.getDisplayNearestPoint(point)
    return all.find((d) => d.id === String(active.id)) ?? all[0]
  }
  // 'secondary' — use the second monitor when there is one, otherwise fall
  // back to the primary so the overlay is never invisible.
  return secondaryDisplay() ?? all.find((d) => d.isPrimary) ?? all[0]
}

function cornerPosition(
  display: DisplayInfo,
  corner: OverlayCorner
): { x: number; y: number } {
  const { x, y, width, height } = display.bounds
  const right = x + width - OVERLAY_WIDTH - OVERLAY_MARGIN
  const bottom = y + height - OVERLAY_HEIGHT - OVERLAY_MARGIN
  const left = x + OVERLAY_MARGIN
  const top = y + OVERLAY_MARGIN
  switch (corner) {
    case 'top-left':
      return { x: left, y: top }
    case 'top-right':
      return { x: right, y: top }
    case 'bottom-left':
      return { x: left, y: bottom }
    default:
      return { x: right, y: bottom }
  }
}

export function createOverlayWindow(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow

  overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    acceptFirstMouse: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preload(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  // 'screen-saver' keeps it above full-screen games, which is the whole point.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  overlayWindow.on('closed', () => {
    overlayWindow = null
  })

  load(overlayWindow, 'overlay')
  return overlayWindow
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow
}

export function positionOverlay(settings: OverlaySettings): void {
  const win = createOverlayWindow()
  const display = overlayDisplay(settings)
  const { x, y } = cornerPosition(display, settings.corner)
  win.setBounds({ x, y, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT })
}

/** Show without stealing focus — the user is probably still in a game. */
export function revealOverlay(settings: OverlaySettings): void {
  const win = createOverlayWindow()
  positionOverlay(settings)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.showInactive()
}

export function hideOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
}
