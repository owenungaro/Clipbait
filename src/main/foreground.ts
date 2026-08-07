/**
 * Tracks the app that currently owns the foreground window, so a clip can be
 * named after the game it came from.
 *
 * This used to run a hidden, long-lived PowerShell process that compiled inline
 * C# at runtime (Add-Type + DllImport user32) to reach GetForegroundWindow.
 * That shape — powershell.exe with -ExecutionPolicy Bypass, runtime-compiled
 * P/Invoke, hidden and long-running — is indistinguishable from malware to
 * heuristic antivirus and got flagged (Avast/AVG "Boxter"). We now call the same
 * Win32 APIs directly, in process, through koffi: no shell is spawned and nothing
 * is compiled at runtime, so there is nothing for the heuristic to match.
 *
 * The process name is preferred over the window title. Titles are written for
 * humans and vary constantly ("Inbox (3) - Gmail - Chrome"), and splitting them
 * guesses wrong often enough to produce nonsense filenames.
 */

/** OpenProcess access that works for query-only even across integrity levels. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/* -------------------------------------------------------------- ffi binding */

type KoffiFunc = (...args: unknown[]) => unknown
interface KoffiLib {
  func: (prototype: string) => KoffiFunc
}
interface Koffi {
  load: (name: string) => KoffiLib
}

interface Win32 {
  getForegroundWindow: () => unknown
  getWindowThreadProcessId: (hwnd: unknown, pidOut: number[]) => number
  getWindowText: (hwnd: unknown, buf: Uint16Array, max: number) => number
  openProcess: (access: number, inherit: boolean, pid: number) => unknown
  closeHandle: (handle: unknown) => boolean
  queryImageName: (handle: unknown, flags: number, buf: Uint16Array, size: number[]) => boolean
}

let win32: Win32 | null = null
let ffiUnavailable = false

/** Bind the Win32 entry points once. Any failure disables tracking for good. */
function api(): Win32 | null {
  if (win32) return win32
  if (ffiUnavailable || process.platform !== 'win32') return null
  try {
    // Required lazily and guarded: if the native binary is missing on some odd
    // build, clip naming quietly turns off rather than taking the app down.
    const koffi = require('koffi') as Koffi
    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')
    win32 = {
      getForegroundWindow: user32.func(
        'void* __stdcall GetForegroundWindow()'
      ) as Win32['getForegroundWindow'],
      getWindowThreadProcessId: user32.func(
        'uint32 __stdcall GetWindowThreadProcessId(void* hWnd, _Out_ uint32* pid)'
      ) as Win32['getWindowThreadProcessId'],
      getWindowText: user32.func(
        'int __stdcall GetWindowTextW(void* hWnd, _Out_ uint16* str, int max)'
      ) as Win32['getWindowText'],
      openProcess: kernel32.func(
        'void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'
      ) as Win32['openProcess'],
      closeHandle: kernel32.func(
        'bool __stdcall CloseHandle(void* handle)'
      ) as Win32['closeHandle'],
      queryImageName: kernel32.func(
        'bool __stdcall QueryFullProcessImageNameW(void* handle, uint32 flags, _Out_ uint16* name, _Inout_ uint32* size)'
      ) as Win32['queryImageName']
    }
    return win32
  } catch {
    ffiUnavailable = true
    return null
  }
}

/** Decode a NUL-terminated UTF-16 buffer up to `max` code units. */
function readWide(buf: Uint16Array, max: number): string {
  let end = 0
  while (end < max && buf[end] !== 0) end++
  return Buffer.from(buf.buffer, buf.byteOffset, end * 2).toString('utf16le')
}

/** Full path of the process with this id, or '' when it cannot be read. */
function imageFor(pid: number): string {
  const a = win32
  if (!a) return ''
  const proc = a.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!proc) return ''
  try {
    const buf = new Uint16Array(4096)
    const size = [buf.length]
    if (a.queryImageName(proc, 0, buf, size)) return readWide(buf, size[0])
    return ''
  } finally {
    a.closeHandle(proc)
  }
}

function titleFor(handle: unknown): string {
  const a = win32
  if (!a) return ''
  const buf = new Uint16Array(512)
  const len = a.getWindowText(handle, buf, buf.length)
  return len > 0 ? readWide(buf, len) : ''
}

/* ----------------------------------------------------------------- naming */

/** Never name a clip after these — they are shells, not apps. */
const IGNORED = new Set([
  '',
  'idle',
  'system',
  'clipbait',
  'electron',
  'explorer',
  'dwm',
  'sihost',
  'searchhost',
  'searchapp',
  'shellexperiencehost',
  'startmenuexperiencehost',
  'textinputhost',
  'lockapp',
  'conhost',
  'cmd',
  'powershell',
  'pwsh',
  'windowsterminal'
])

/** UWP apps all run under this host, so their title is the only real name. */
const TITLE_HOSTS = new Set(['applicationframehost'])

/** Suffixes Unreal and friends bolt onto shipped executables. */
const SUFFIXES = /(-Win64-Shipping|-WinGDK-Shipping|-Shipping|_BE|_EAC|64|-x64)$/i

function tidy(value: string): string | null {
  let name = value.trim().replace(/\.exe$/i, '')
  name = name.replace(SUFFIXES, '')
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim()
  if (!name || IGNORED.has(name.toLowerCase())) return null
  // Bare lowercase executables read better capitalised; anything already
  // styled (VALORANT, iTunes) is left as its author wrote it.
  if (name === name.toLowerCase()) {
    name = name.charAt(0).toUpperCase() + name.slice(1)
  }
  return name.slice(0, 48)
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? ''
}

function nameFor(process: string, title: string): string | null {
  if (TITLE_HOSTS.has(process.trim().toLowerCase())) {
    // Titles here look like "Photos" or "Settings" — already the app name.
    return tidy(title.split(/\s+[-–—|]\s+/)[0] ?? '')
  }
  return tidy(process)
}

/* --------------------------------------------------------------- tracking */

let timer: NodeJS.Timeout | null = null
let current: string | null = null
let currentExe = ''

function poll(): void {
  const a = api()
  if (!a) {
    stopForegroundTracking()
    return
  }
  try {
    const hwnd = a.getForegroundWindow()
    if (!hwnd) return

    const pidOut = [0]
    a.getWindowThreadProcessId(hwnd, pidOut)
    const pid = pidOut[0]
    // PID <= 4 is the System Idle / System process, which is what you get when
    // nothing real owns the foreground (lock screen, session switch).
    if (pid <= 4) return

    const exe = imageFor(pid)
    const process = baseName(exe)
    const name = nameFor(process, titleFor(hwnd))
    // Keep the last good name rather than clearing on a blank poll, so
    // alt-tabbing through the desktop does not wipe it.
    if (name) {
      current = name
      currentExe = exe.trim()
    }
  } catch {
    // A single failed poll is not worth tearing down; try again next tick.
  }
}

export function startForegroundTracking(): void {
  if (timer || process.platform !== 'win32') return
  if (!api()) return
  poll()
  timer = setInterval(poll, 2000)
}

export function stopForegroundTracking(): void {
  if (timer) clearInterval(timer)
  timer = null
  current = null
  currentExe = ''
}

export function foregroundApp(): string | null {
  return current
}

/** Full path to the foreground executable, or '' when it could not be read. */
export function foregroundExe(): string {
  return currentExe
}
