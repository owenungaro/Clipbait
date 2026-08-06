import { useApp } from '../lib/store'
import { Field, Section, Switch, TextInput } from '../components/controls'

const TOKENS = [
  { token: '{app}', describes: 'the app in focus' },
  { token: '{date}', describes: 'year-month-day' },
  { token: '{time}', describes: 'hour-minute-second' },
  { token: '{datetime}', describes: 'date and time' },
  { token: '{display}', describes: 'the monitor name' }
]

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Mirrors renderFilename in the main process so the preview stays honest. */
function previewName(template: string, app: string, display: string): string {
  const now = new Date()
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  const filled = template
    .replace(/\{date\}/gi, date)
    .replace(/\{time\}/gi, time)
    .replace(/\{datetime\}/gi, `${date} ${time}`)
    .replace(/\{app\}/gi, app)
    .replace(/\{display\}/gi, display)
    .replace(/\{n\}/gi, '')
  const cleaned = filled
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '')
    .trim()
  return `${cleaned || `Clip ${date} ${time}`}.mp4`
}

export function OutputPane(): React.JSX.Element | null {
  const { settings, status, patch } = useApp()
  if (!settings) return null
  const o = settings.output

  const chooseFolder = async (): Promise<void> => {
    const picked = await window.clipbait.chooseFolder(o.folder)
    if (picked) patch({ output: { folder: picked } })
  }

  const appName = status?.foregroundApp ?? 'Clip'
  const displayName = status?.display?.label.split(' · ')[0] ?? 'Primary'

  return (
    <div className="pane">
      <header className="pane__head">
        <div className="eyebrow">Output</div>
        <h1 className="pane__title">Where clips land</h1>
        <p className="pane__lede">
          Clips are written as MP4 with H.264 video and AAC audio, which plays anywhere without
          conversion.
        </p>
      </header>

      <Section title="Location">
        <Field label="Save folder" stack>
          <div className="row" style={{ width: '100%' }}>
            <TextInput
              label="Save folder"
              value={o.folder}
              onChange={(folder) => patch({ output: { folder } })}
            />
            <button type="button" className="btn" onClick={() => void chooseFolder()}>
              Browse
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void window.clipbait.openPath(o.folder)}
            >
              Open
            </button>
          </div>
        </Field>
      </Section>

      <Section title="File name">
        <Field label="Name pattern" stack>
          <div style={{ width: '100%' }}>
            <TextInput
              label="Name pattern"
              value={o.filenameTemplate}
              onChange={(filenameTemplate) => patch({ output: { filenameTemplate } })}
            />
            <div className="tokens">
              {TOKENS.map((t) => (
                <button
                  key={t.token}
                  type="button"
                  className="token"
                  title={t.describes}
                  onClick={() =>
                    patch({
                      output: { filenameTemplate: `${o.filenameTemplate}${t.token}` }
                    })
                  }
                >
                  {t.token}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="eyebrow" style={{ marginBottom: 4 }}>
                Next clip
              </div>
              <div className="preview-name">
                {previewName(o.filenameTemplate, appName, displayName)}
              </div>
            </div>
          </div>
        </Field>
      </Section>

      <Section title="Diagnostics">
        <Field
          label="Keep buffer segments after saving"
          help="Leaves the raw segment files in place. Only useful when debugging a bad clip."
        >
          <Switch
            label="Keep buffer segments after saving"
            checked={o.keepSegments}
            onChange={(keepSegments) => patch({ output: { keepSegments } })}
          />
        </Field>
      </Section>
    </div>
  )
}
