import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { acceleratorFrom, prettyAccelerator } from '../lib/format'

export function Section({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="section">
      <header className="section__head">
        <div className="eyebrow">{title}</div>
        {hint && <div className="field__help">{hint}</div>}
      </header>
      {children}
    </section>
  )
}

export function Field({
  label,
  help,
  stack,
  children
}: {
  label: string
  help?: string
  stack?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className={stack ? 'field field--stack' : 'field'}>
      <div>
        <div className="field__label">{label}</div>
        {help && <div className="field__help">{help}</div>}
      </div>
      <div className="field__control">{children}</div>
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
  label: string
}): React.JSX.Element {
  const numeric = typeof value === 'number'
  return (
    <select
      className="select"
      aria-label={label}
      value={String(value)}
      onChange={(e) => onChange((numeric ? Number(e.target.value) : e.target.value) as T)}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
}): React.JSX.Element {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className="segmented__option"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
  label
}: {
  value: number
  min: number
  max: number
  step?: number
  format: (v: number) => string
  onChange: (next: number) => void
  label: string
}): React.JSX.Element {
  return (
    <div className="slider">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider__value">{format(value)}</span>
    </div>
  )
}

export function TextInput({
  value,
  onChange,
  label,
  placeholder,
  mono = true
}: {
  value: string
  onChange: (next: string) => void
  label: string
  placeholder?: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <input
      className="input"
      aria-label={label}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      style={mono ? undefined : { fontFamily: 'var(--font-ui)' }}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/**
 * Records a real key combination. Global shortcuts are suspended while this is
 * listening, so pressing the currently-bound key does not fire the action the
 * user is trying to rebind.
 */
export function HotkeyInput({
  value,
  onChange,
  conflict,
  label
}: {
  value: string
  onChange: (next: string) => void
  conflict?: boolean
  label: string
}): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  const [rejected, setRejected] = useState<string | null>(null)
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const latest = useRef(onChange)
  latest.current = onChange

  useEffect(() => {
    if (!recording) return
    setRejected(null)
    // Release our own global shortcuts first, or Windows hands the key to the
    // existing binding instead of delivering it to this window.
    void window.clipbait.setHotkeyCapture(true)

    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        return
      }
      // Ignore the modifier keys themselves so the combo can be built up.
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return

      const accel = acceleratorFrom(event)
      if (accel) {
        latest.current(accel)
        setRecording(false)
      } else {
        // Never fail silently — an unusable key has to say so, or the control
        // just looks broken. Most keys map; this is for the odd one that cannot
        // (media keys, some OEM keys) and for Escape, which cancels instead.
        setRejected("That key can't be used — try another")
      }
    }

    // Clicking elsewhere cancels. Focus is deliberately not used for this:
    // some combinations move focus on their own, which would cancel recording
    // the instant the user pressed the key they were trying to bind.
    const onPointerDown = (event: PointerEvent): void => {
      if (!button.current?.contains(event.target as Node)) setRecording(false)
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      void window.clipbait.setHotkeyCapture(false)
    }
  }, [recording])

  return (
    <div style={{ width: '100%' }}>
      <button
        type="button"
        id={id}
        ref={button}
        className="hotkey"
        data-recording={recording}
        data-conflict={!recording && conflict === true}
        aria-label={label}
        onClick={() => setRecording((r) => !r)}
      >
        {recording
          ? 'Press keys…'
          : conflict
            ? `${prettyAccelerator(value)} — in use`
            : prettyAccelerator(value)}
      </button>
      {recording && rejected && (
        <div className="eyebrow" style={{ marginTop: 6, color: 'var(--accent-hi)' }}>
          {rejected}
        </div>
      )}
    </div>
  )
}
