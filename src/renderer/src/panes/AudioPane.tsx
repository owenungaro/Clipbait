import { useEffect, useState } from 'react'
import { useApp } from '../lib/store'
import { Field, Section, Select, Slider, Switch } from '../components/controls'

interface Device {
  deviceId: string
  label: string
}

export function AudioPane(): React.JSX.Element | null {
  const { settings, status, patch } = useApp()
  const [devices, setDevices] = useState<Device[]>([])
  const [needsPermission, setNeedsPermission] = useState(false)

  const enumerate = async (): Promise<void> => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      const mics = all.filter((d) => d.kind === 'audioinput')
      // Device labels stay blank until microphone access has been granted once.
      setNeedsPermission(mics.length > 0 && mics.every((d) => d.label === ''))
      setDevices(
        mics.map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${i + 1}`
        }))
      )
    } catch {
      setDevices([])
    }
  }

  useEffect(() => {
    void enumerate()
    navigator.mediaDevices.addEventListener('devicechange', enumerate)
    return () => navigator.mediaDevices.removeEventListener('devicechange', enumerate)
  }, [])

  const grantAccess = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
      await enumerate()
    } catch {
      /* the user declined; the dropdown keeps its generic names */
    }
  }

  if (!settings) return null
  const a = settings.audio

  return (
    <div className="pane">
      <header className="pane__head">
        <div className="eyebrow">Audio</div>
        <h1 className="pane__title">What your clips sound like</h1>
        <p className="pane__lede">
          Desktop sound and microphone are mixed into a single track as the clip records.
          Changing anything here restarts capture.
        </p>
      </header>

      <Section title="Desktop">
        <Field
          label="Record desktop audio"
          help="Everything you hear — game, voice chat, music."
        >
          <Switch
            label="Record desktop audio"
            checked={a.desktopEnabled}
            onChange={(desktopEnabled) => patch({ audio: { desktopEnabled } })}
          />
        </Field>
        {a.desktopEnabled && (
          <Field label="Desktop level">
            <Slider
              label="Desktop level"
              value={Math.round(a.desktopGain * 100)}
              min={0}
              max={200}
              step={5}
              onChange={(v) => patch({ audio: { desktopGain: v / 100 } })}
              format={(v) => `${v}%`}
            />
          </Field>
        )}
      </Section>

      <Section title="Microphone">
        <Field label="Record microphone" help="Mixed in alongside desktop sound.">
          <Switch
            label="Record microphone"
            checked={a.micEnabled}
            onChange={(micEnabled) => patch({ audio: { micEnabled } })}
          />
        </Field>

        {a.micEnabled && (
          <>
            <Field label="Input device">
              {needsPermission ? (
                <button type="button" className="btn btn--sm" onClick={() => void grantAccess()}>
                  Allow access to name devices
                </button>
              ) : (
                <Select
                  label="Input device"
                  value={a.micDeviceId}
                  onChange={(micDeviceId) => patch({ audio: { micDeviceId } })}
                  options={[
                    { value: 'default', label: 'System default' },
                    ...devices.map((d) => ({ value: d.deviceId, label: d.label }))
                  ]}
                />
              )}
            </Field>
            <Field label="Microphone level">
              <Slider
                label="Microphone level"
                value={Math.round(a.micGain * 100)}
                min={0}
                max={200}
                step={5}
                onChange={(v) => patch({ audio: { micGain: v / 100 } })}
                format={(v) => `${v}%`}
              />
            </Field>
          </>
        )}
      </Section>

      {status?.state === 'armed' && (a.desktopEnabled || a.micEnabled) && (
        <Section title="Signal">
          <Field
            label="Input level"
            help="Peak across the mixed track. If this never moves, nothing is reaching the recorder."
          >
            <div style={{ width: '100%' }}>
              <div className="progress">
                <div
                  className="progress__fill"
                  style={{
                    width: `${Math.min(100, Math.round((status.audio.level || 0) * 140))}%`
                  }}
                />
              </div>
            </div>
          </Field>
        </Section>
      )}
    </div>
  )
}
