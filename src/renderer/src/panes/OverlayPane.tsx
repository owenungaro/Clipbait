import { useApp } from '../lib/store'
import { Field, Section, Segmented, Slider, Switch } from '../components/controls'

export function OverlayPane(): React.JSX.Element | null {
  const { settings, displays, clips, patch } = useApp()
  if (!settings) return null
  const o = settings.overlay
  const multiMonitor = displays.length > 1

  return (
    <div className="pane">
      <header className="pane__head">
        <div className="eyebrow">Overlay</div>
        <h1 className="pane__title">The card that appears after a clip</h1>
        <p className="pane__lede">
          A small window with the clip in it. Drag the thumbnail straight into Discord or an
          editor, or turn it into a link without leaving your game.
        </p>
      </header>

      <Section title="Appearance">
        <Field label="Show the overlay after saving a clip">
          <Switch
            label="Show the overlay after saving a clip"
            checked={o.enabled}
            onChange={(enabled) => patch({ overlay: { enabled } })}
          />
        </Field>

        {o.enabled && (
          <>
            <Field
              label="Monitor"
              help={
                multiMonitor
                  ? 'Second screen keeps it out of the way of whatever you are playing.'
                  : 'You only have one monitor connected, so it will appear there either way.'
              }
            >
              <Segmented
                value={o.target}
                onChange={(target) => patch({ overlay: { target } })}
                options={[
                  { value: 'secondary', label: 'Second' },
                  { value: 'primary', label: 'Primary' },
                  { value: 'active', label: 'Cursor' }
                ]}
              />
            </Field>

            <Field label="Corner">
              <Segmented
                value={o.corner}
                onChange={(corner) => patch({ overlay: { corner } })}
                options={[
                  { value: 'top-left', label: '↖' },
                  { value: 'top-right', label: '↗' },
                  { value: 'bottom-left', label: '↙' },
                  { value: 'bottom-right', label: '↘' }
                ]}
              />
            </Field>

            <Field
              label="Dismiss after"
              help="Hovering the overlay pauses this, so it will not vanish mid-drag."
            >
              <Slider
                label="Dismiss after"
                value={o.autoHideSeconds}
                min={0}
                max={60}
                step={1}
                onChange={(autoHideSeconds) => patch({ overlay: { autoHideSeconds } })}
                format={(v) => (v === 0 ? 'stays open' : `${v}s`)}
              />
            </Field>

            <Field
              label="Try it"
              help={
                clips.length > 0
                  ? 'Shows the overlay with your most recent clip.'
                  : 'Save a clip first and this will show it here.'
              }
            >
              <button
                type="button"
                className="btn btn--sm"
                disabled={clips.length === 0}
                onClick={() => void window.clipbait.previewOverlay()}
              >
                Show overlay
              </button>
            </Field>
          </>
        )}
      </Section>
    </div>
  )
}
