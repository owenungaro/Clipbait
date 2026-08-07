import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types'
import { useApp } from '../lib/store'
import { Field, Section, Switch } from '../components/controls'

function updateLabel(update: UpdateStatus | null): string {
  switch (update?.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Update${update.version ? ` v${update.version}` : ''} found — downloading…`
    case 'downloading':
      return `Downloading${update.version ? ` v${update.version}` : ''}… ${Math.round(update.progress * 100)}%`
    case 'downloaded':
      return `Update${update.version ? ` v${update.version}` : ''} ready to install`
    case 'not-available':
      return "You're on the latest version"
    case 'error':
      return update.message ?? 'Update check failed'
    default:
      return ''
  }
}

export function GeneralPane(): React.JSX.Element | null {
  const { settings, ffmpeg, update, patch } = useApp()
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.clipbait.appVersion().then(setVersion)
  }, [])

  if (!settings) return null
  const g = settings.general
  const busy = update?.state === 'checking' || update?.state === 'downloading'
  const statusLabel = updateLabel(update)

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

      <Section title="Updates">
        <Field
          label="Keep Clipbait up to date"
          help={statusLabel || 'Checks GitHub for the newest release and installs it.'}
        >
          {update?.state === 'downloaded' ? (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void window.clipbait.installUpdate()}
            >
              Restart &amp; install
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy}
              onClick={() => void window.clipbait.checkForUpdates()}
            >
              {busy ? 'Checking…' : 'Check for updates'}
            </button>
          )}
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
