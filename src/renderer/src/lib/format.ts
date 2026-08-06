export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 MB'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function seconds(value: number): string {
  return `${value.toFixed(1)}s`
}

export function relativeTime(ts: number): string {
  const delta = Date.now() - ts
  const minutes = Math.round(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function expiresIn(ts: number | null): string | null {
  if (!ts) return null
  const delta = ts - Date.now()
  if (delta <= 0) return 'expired'
  const hours = Math.round(delta / 3_600_000)
  if (hours < 1) return 'expires within the hour'
  return `expires in ${hours}h`
}

/** Turn a keyboard event into an Electron accelerator, or null if unusable. */
export function acceleratorFrom(event: KeyboardEvent): string | null {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Super')

  const code = event.code
  let key: string | null = null

  if (/^F\d{1,2}$/.test(code)) key = code
  else if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^Numpad\d$/.test(code)) key = `num${code.slice(6)}`
  else {
    const map: Record<string, string> = {
      Space: 'Space',
      Tab: 'Tab',
      Backspace: 'Backspace',
      Delete: 'Delete',
      Insert: 'Insert',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Minus: '-',
      Equal: '=',
      BracketLeft: '[',
      BracketRight: ']',
      Backslash: '\\',
      Semicolon: ';',
      Quote: "'",
      Comma: ',',
      Period: '.',
      Slash: '/',
      Backquote: '`'
    }
    key = map[code] ?? null
  }

  if (!key) return null
  // A bare letter or digit would swallow typing everywhere on the system.
  const needsModifier = !/^F\d{1,2}$/.test(key)
  if (needsModifier && parts.length === 0) return null

  parts.push(key)
  return parts.join('+')
}

export function prettyAccelerator(accel: string): string {
  return accel
    .split('+')
    .map((p) => (p === 'Control' ? 'Ctrl' : p === 'Super' ? 'Win' : p))
    .join(' + ')
}
