import { useState } from 'react'
import { useApp } from './lib/store'
import { StatusBar } from './components/StatusBar'
import { Gallery } from './components/Gallery'
import { SettingsSheet } from './components/SettingsSheet'

/**
 * Clips are the ground floor. The capture deck is a bar across the top, and
 * settings are a sheet you pull open — the window is almost always opened to
 * look at what you kept, not to change how it records.
 */
export function App(): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { toasts, dismissToast } = useApp()

  return (
    <div className="app">
      <StatusBar onOpenSettings={() => setSettingsOpen(true)} />

      <main className="stage">
        <Gallery />
      </main>

      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <div className="toasts">
        {toasts.map((toast) => (
          <button
            key={toast.id}
            type="button"
            className={`toast toast--${toast.kind}`}
            onClick={() => dismissToast(toast.id)}
          >
            <span className="toast__dot" />
            <span style={{ textAlign: 'left' }}>{toast.message}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
