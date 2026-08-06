import { useEffect, useState } from 'react'
import { useApp } from '../lib/store'
import { Field, Section, Switch } from '../components/controls'

export function GeneralPane(): React.JSX.Element | null {
  const { settings, ffmpeg, patch } = useApp()
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.clipbait.appVersion().then(setVersion)
  }, [])

  if (!settings) return null
  const g = settings.general

  return (
    <div className="pane">
      <header className="pane__head">
        <div className="eyebrow">General</div>
        <h1 className="pane__title">How Clipbait behaves</h1>
      </header>

      <Section title="Startup">
        <Field label="Start with Windows" help="Launches into the tray, out of your way.">
          <Switch
            label="Start with Windows"
            checked={g.launchOnStartup}
            onChange={(launchOnStartup) => patch({ general: { launchOnStartup } })}
          />
        </Field>
        <Field
          label="Arm the buffer on launch"
          help="Begins recording in the background as soon as Clipbait opens."
        >
          <Switch
            label="Arm the buffer on launch"
            checked={g.armOnLaunch}
            onChange={(armOnLaunch) => patch({ general: { armOnLaunch } })}
          />
        </Field>
      </Section>

      <Section title="Window">
        <Field label="Keep running in the tray" help="Closing the window leaves capture running.">
          <Switch
            label="Keep running in the tray"
            checked={g.closeToTray}
            onChange={(closeToTray) => patch({ general: { closeToTray, minimizeToTray: closeToTray } })}
          />
        </Field>
      </Section>

      <Section title="About">
        <Field label="Clipbait">
          <span className="mono" style={{ color: 'var(--text-3)', fontSize: 12 }}>
            {version ? `v${version}` : '—'}
          </span>
        </Field>
        <Field label="FFmpeg" help={ffmpeg?.path ?? 'Not installed yet.'}>
          <span className="mono" style={{ color: 'var(--text-3)', fontSize: 12 }}>
            {ffmpeg?.version ?? ffmpeg?.state ?? '—'}
          </span>
        </Field>
        <Field
          label="Reset every setting"
          help="Puts capture, audio, output, hotkeys and sharing back to their defaults."
        >
          <button
            type="button"
            className="btn btn--sm btn--danger"
            onClick={() => void window.clipbait.resetSettings()}
          >
            Reset
          </button>
        </Field>
      </Section>
    </div>
  )
}
