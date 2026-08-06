import { useApp } from '../lib/store'
import { Field, HotkeyInput, Section } from '../components/controls'

export function HotkeysPane(): React.JSX.Element | null {
  const { settings, conflicts, patch } = useApp()
  if (!settings) return null
  const h = settings.hotkeys

  // registerHotkeys reports false for any accelerator Windows refused.
  const failed = (accel: string): boolean => conflicts[accel] === false

  const anyFailed = [h.saveClip, h.toggleBuffer, h.openApp].some(failed)

  return (
    <div className="pane">
      <header className="pane__head">
        <div className="eyebrow">Hotkeys</div>
        <h1 className="pane__title">Keys that work anywhere</h1>
        <p className="pane__lede">
          These are registered system-wide, so they fire inside full-screen games. Click a key,
          then press the combination you want.
        </p>
      </header>

      {anyFailed && (
        <div className="banner banner--error">
          <div className="banner__text">
            <strong>Windows refused a shortcut</strong>
            Another program already owns it. Pick a different combination for the key marked in
            red.
          </div>
        </div>
      )}

      <Section title="Bindings">
        <Field label="Save clip" help="Writes the buffer to a file and shows the overlay.">
          <HotkeyInput
            label="Save clip"
            value={h.saveClip}
            conflict={failed(h.saveClip)}
            onChange={(saveClip) => patch({ hotkeys: { saveClip } })}
          />
        </Field>
        <Field label="Arm or disarm the buffer" help="Starts and stops background recording.">
          <HotkeyInput
            label="Arm or disarm the buffer"
            value={h.toggleBuffer}
            conflict={failed(h.toggleBuffer)}
            onChange={(toggleBuffer) => patch({ hotkeys: { toggleBuffer } })}
          />
        </Field>
        <Field label="Open Clipbait" help="Brings this window back from the tray.">
          <HotkeyInput
            label="Open Clipbait"
            value={h.openApp}
            conflict={failed(h.openApp)}
            onChange={(openApp) => patch({ hotkeys: { openApp } })}
          />
        </Field>
      </Section>

      <p className="field__help">
        Function keys work on their own. Anything else needs at least one modifier, otherwise it
        would swallow that key in every other program.
      </p>
    </div>
  )
}
