import { useEffect, useState } from 'react'
import { CapturePane } from '../panes/CapturePane'
import { AudioPane } from '../panes/AudioPane'
import { OutputPane } from '../panes/OutputPane'
import { OverlayPane } from '../panes/OverlayPane'
import { HotkeysPane } from '../panes/HotkeysPane'
import { SharingPane } from '../panes/SharingPane'
import { GeneralPane } from '../panes/GeneralPane'

type Tab = 'capture' | 'audio' | 'output' | 'overlay' | 'hotkeys' | 'sharing' | 'general'

const TABS: { id: Tab; label: string }[] = [
  { id: 'capture', label: 'Capture' },
  { id: 'audio', label: 'Audio' },
  { id: 'output', label: 'Output' },
  { id: 'overlay', label: 'Overlay' },
  { id: 'hotkeys', label: 'Keys' },
  { id: 'sharing', label: 'Share' },
  { id: 'general', label: 'App' }
]

function Body({ tab }: { tab: Tab }): React.JSX.Element | null {
  switch (tab) {
    case 'capture':
      return <CapturePane />
    case 'audio':
      return <AudioPane />
    case 'output':
      return <OutputPane />
    case 'overlay':
      return <OverlayPane />
    case 'hotkeys':
      return <HotkeysPane />
    case 'sharing':
      return <SharingPane />
    case 'general':
      return <GeneralPane />
  }
}

/** Settings live off to the side, because changing them is the rare task. */
export function SettingsSheet({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const [tab, setTab] = useState<Tab>('capture')

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <button className="scrim" aria-label="Close settings" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-label="Settings">
        <header className="sheet__head">
          <span className="sheet__title">Setup</span>
          <button type="button" className="sheet__close" onClick={onClose} aria-label="Close">
            ESC
          </button>
        </header>

        <nav className="sheet__tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="sheet__tab"
              aria-pressed={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="sheet__body">
          <Body tab={tab} />
        </div>
      </aside>
    </>
  )
}
