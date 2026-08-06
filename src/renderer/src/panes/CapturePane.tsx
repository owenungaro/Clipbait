import { useEffect, useState } from 'react'
import { useApp } from '../lib/store'
import { Field, Section, Segmented, Select, Slider, Switch } from '../components/controls'

export function CapturePane(): React.JSX.Element | null {
  const { settings, displays, encoders, patch } = useApp()
  const [previews, setPreviews] = useState<Record<number, string | null>>({})
  const [loadingPreviews, setLoadingPreviews] = useState(false)

  const loadPreviews = async (): Promise<void> => {
    setLoadingPreviews(true)
    const next: Record<number, string | null> = {}
    for (const d of displays) {
      next[d.captureIndex] = await window.clipbait.previewDisplay(d.captureIndex)
    }
    setPreviews(next)
    setLoadingPreviews(false)
  }

  useEffect(() => {
    if (displays.length > 0) void loadPreviews()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displays.length])

  if (!settings) return null
  const c = settings.capture
  const byQuality = c.rateControl === 'quality'

  return (
    <div className="pane">
      <header className="pane__head">
        <div className="eyebrow">Capture</div>
        <h1 className="pane__title">What Clipbait records</h1>
        <p className="pane__lede">
          Higher settings cost more disk and more GPU. A hardware encoder keeps the cost off
          your frame rate.
        </p>
      </header>

      <Section
        title="Monitor"
        hint="Each tile shows a live frame from that capture source, so you can pick by eye."
      >
        <div className="monitors">
          {displays.map((d) => {
            const selected =
              c.displayId === d.id || (c.displayId === 'primary' && d.isPrimary)
            return (
              <button
                key={d.id}
                type="button"
                className="monitor"
                aria-pressed={selected}
                onClick={() => patch({ capture: { displayId: d.id } })}
              >
                <span className="monitor__screen">
                  {previews[d.captureIndex] ? (
                    <img src={previews[d.captureIndex]!} alt="" draggable={false} />
                  ) : (
                    <span className="eyebrow">
                      {loadingPreviews ? 'reading…' : 'no signal'}
                    </span>
                  )}
                </span>
                <span className="monitor__meta">
                  <span className="monitor__name">
                    {d.isPrimary ? 'Primary monitor' : `Monitor ${d.captureIndex + 1}`}
                  </span>
                  <span className="eyebrow">
                    {d.width}×{d.height}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        <Field
          label="Always follow the primary monitor"
          help="Useful if you rearrange displays or dock and undock."
        >
          <Switch
            label="Always follow the primary monitor"
            checked={c.displayId === 'primary'}
            onChange={(on) =>
              patch({
                capture: {
                  displayId: on ? 'primary' : (displays[0]?.id ?? 'primary')
                }
              })
            }
          />
        </Field>
        <Field label="Refresh previews" help="Grabs a fresh frame from every monitor.">
          <button
            type="button"
            className="btn btn--sm"
            disabled={loadingPreviews}
            onClick={() => void loadPreviews()}
          >
            {loadingPreviews ? 'Reading…' : 'Refresh'}
          </button>
        </Field>
      </Section>

      <Section title="Quality">
        <Field label="Frame rate" help="Match your monitor for the smoothest clips.">
          <Segmented
            value={c.fps}
            onChange={(fps) => patch({ capture: { fps } })}
            options={[
              { value: 30, label: '30' },
              { value: 60, label: '60' },
              { value: 120, label: '120' },
              { value: 144, label: '144' }
            ]}
          />
        </Field>

        <Field
          label="Resolution"
          help="Scaling down shrinks files and uploads far more than it costs in detail."
        >
          <Segmented
            value={c.resolution}
            onChange={(resolution) => patch({ capture: { resolution } })}
            options={[
              { value: 'native', label: 'Native' },
              { value: '1440p', label: '1440p' },
              { value: '1080p', label: '1080p' },
              { value: '720p', label: '720p' }
            ]}
          />
        </Field>

        <Field
          label="Encoder"
          help={
            encoders.find((e) => e.id === c.encoder)?.detail ??
            'Auto picks the fastest hardware encoder this machine has.'
          }
        >
          <Select
            label="Encoder"
            value={c.encoder}
            onChange={(encoder) => patch({ capture: { encoder } })}
            options={[
              { value: 'auto' as const, label: 'Auto' },
              ...encoders.map((e) => ({
                value: e.id,
                label: e.available ? e.label : `${e.label} — unavailable`
              }))
            ]}
          />
        </Field>

        <Field label="Rate control" help="Constant quality adapts bitrate to the scene.">
          <Segmented
            value={c.rateControl}
            onChange={(rateControl) => patch({ capture: { rateControl } })}
            options={[
              { value: 'quality', label: 'Quality' },
              { value: 'bitrate', label: 'Bitrate' }
            ]}
          />
        </Field>

        {byQuality ? (
          <Field
            label="Quality level"
            help="Lower is better looking and larger. 21 is a good balance for gameplay."
          >
            <Slider
              label="Quality level"
              value={c.quality}
              min={14}
              max={34}
              onChange={(quality) => patch({ capture: { quality } })}
              format={(v) =>
                `${v} · ${v <= 18 ? 'very high' : v <= 23 ? 'high' : v <= 28 ? 'medium' : 'low'}`
              }
            />
          </Field>
        ) : (
          <Field label="Bitrate" help="Roughly 8 Mb/s per million pixels holds up well at 60 fps.">
            <Slider
              label="Bitrate"
              value={c.bitrateMbps}
              min={4}
              max={120}
              step={2}
              onChange={(bitrateMbps) => patch({ capture: { bitrateMbps } })}
              format={(v) => `${v} Mb/s`}
            />
          </Field>
        )}

        <Field label="Include the mouse cursor">
          <Switch
            label="Include the mouse cursor"
            checked={c.captureCursor}
            onChange={(captureCursor) => patch({ capture: { captureCursor } })}
          />
        </Field>
      </Section>

      <Section
        title="Buffer"
        hint="Changing this restarts capture, which clears whatever is currently held."
      >
        <Field
          label="Clip length"
          help="How far back a clip reaches. Longer buffers use more disk while armed."
        >
          <Slider
            label="Clip length"
            value={c.bufferSeconds}
            min={10}
            max={300}
            step={5}
            onChange={(bufferSeconds) => patch({ capture: { bufferSeconds } })}
            format={(v) => (v >= 60 ? `${Math.floor(v / 60)}m ${v % 60}s` : `${v}s`)}
          />
        </Field>
      </Section>
    </div>
  )
}
