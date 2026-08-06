import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Tracks the app that currently owns the foreground window, so a clip can be
 * named after the game it came from. One long-lived PowerShell process polls
 * and prints; spawning a shell per poll would be far more expensive than the
 * information is worth.
 *
 * The process name is preferred over the window title. Titles are written for
 * humans and vary constantly ("Inbox (3) - Gmail - Chrome"), and splitting them
 * guesses wrong often enough to produce nonsense filenames.
 */

const SCRIPT = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
}
'@
Add-Type -TypeDefinition $sig
while ($true) {
  try {
    $h = [Fg]::GetForegroundWindow()
    if ($h -eq [IntPtr]::Zero) { Write-Output '|'; Start-Sleep -Seconds 2; continue }
    $procId = 0
    [void][Fg]::GetWindowThreadProcessId($h, [ref]$procId)
    # PID 0 is the System Idle Process, which is what you get when nothing
    # real owns the foreground (lock screen, session switch).
    if ($procId -le 4) { Write-Output '|'; Start-Sleep -Seconds 2; continue }
    $p = Get-Process -Id $procId -ErrorAction Stop
    # Path is blocked for some protected processes; the name still works.
    $exe = ''
    try { $exe = $p.Path } catch { $exe = '' }
    Write-Output ($p.ProcessName + '|' + $p.MainWindowTitle + '|' + $exe)
  } catch { Write-Output '||' }
  Start-Sleep -Seconds 2
}
`

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

function clean(raw: string): { name: string | null; exe: string } | null {
  const parts = raw.split('|')
  if (parts.length < 2) return null
  const [process, title, exe = ''] = parts

  if (TITLE_HOSTS.has(process.trim().toLowerCase())) {
    // Titles here look like "Photos" or "Settings" — already the app name.
    return { name: tidy(title.split(/\s+[-–—|]\s+/)[0] ?? ''), exe }
  }
  return { name: tidy(process), exe }
}

let child: ChildProcess | null = null
let current: string | null = null
let currentExe = ''

export function startForegroundTracking(): void {
  if (child || process.platform !== 'win32') return
  try {
    child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.includes('|')) continue
        const value = clean(line)
        // Keep the last good name rather than clearing on a blank poll, so
        // alt-tabbing through the desktop does not wipe it.
        if (value?.name) {
          current = value.name
          currentExe = value.exe.trim()
        }
      }
    })
    child.on('error', () => {
      child = null
    })
    child.on('close', () => {
      child = null
    })
  } catch {
    child = null
  }
}

export function stopForegroundTracking(): void {
  child?.kill()
  child = null
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
