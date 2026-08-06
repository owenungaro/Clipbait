import { useApp } from '../lib/store'
import { Field, Section, Segmented, Select, Switch } from '../components/controls'

export function SharingPane(): React.JSX.Element | null {
  const { settings, patch } = useApp()
  if (!settings) return null
  const s = settings.sharing
  const temporary = s.provider === 'litterbox'

  return (
    <div className="pane">
      <header className="pane__head">
        <div className="eyebrow">Sharing</div>
        <h1 className="pane__title">Turning a clip into a link</h1>
        <p className="pane__lede">
          Clipbait uploads the MP4 and hands back a direct link that plays in Discord, a browser,
          or anywhere else you paste it. No account, no sign-in.
        </p>
      </header>

      <Section title="Destination">
        <Field
          label="Service"
          help={
            temporary
              ? 'Litterbox takes files up to 1 GB and deletes them when they expire.'
              : 'Catbox keeps files permanently and takes up to 200 MB.'
          }
        >
          <Segmented
            value={s.provider}
            onChange={(provider) => patch({ sharing: { provider } })}
            options={[
              { value: 'catbox', label: 'Catbox' },
              { value: 'litterbox', label: 'Litterbox' }
            ]}
          />
        </Field>

        {temporary && (
          <Field label="Keep the link alive for">
            <Select
              label="Keep the link alive for"
              value={s.litterboxExpiry}
              onChange={(litterboxExpiry) => patch({ sharing: { litterboxExpiry } })}
              options={[
                { value: '1h' as const, label: '1 hour' },
                { value: '12h' as const, label: '12 hours' },
                { value: '24h' as const, label: '1 day' },
                { value: '72h' as const, label: '3 days' }
              ]}
            />
          </Field>
        )}
      </Section>

      <Section title="Behaviour">
        <Field
          label="Upload every clip automatically"
          help="Starts the upload the moment a clip is saved, without waiting for you to ask."
        >
          <Switch
            label="Upload every clip automatically"
            checked={s.autoUpload}
            onChange={(autoUpload) => patch({ sharing: { autoUpload } })}
          />
        </Field>
        <Field label="Copy the link once the upload finishes">
          <Switch
            label="Copy the link once the upload finishes"
            checked={s.copyLinkToClipboard}
            onChange={(copyLinkToClipboard) => patch({ sharing: { copyLinkToClipboard } })}
          />
        </Field>
      </Section>

      <p className="field__help">
        Anyone with the link can watch the clip, and neither service asks who they are. Upload
        only what you are happy to hand out.
      </p>
    </div>
  )
}
