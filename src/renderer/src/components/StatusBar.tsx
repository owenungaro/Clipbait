import { useState } from 'react'
import { useApp } from '../lib/store'
import { BufferStrip, MiniStrip, Telemetry } from './scope'
import { prettyAccelerator } from '../lib/format'

/**
 * The whole capture deck, compressed into one bar.
 *
 * Settings and telemetry are occasional; clips are the reason the window is
 * open. So the deck gets a strip across the top and nothing more, and expands
 * only when asked.
 */
export function StatusBar({
  onOpenSettings
}: {
  onOpenSettings: () => void
}): React.JSX.Element | null {
  const { settings, status, ffmpeg } = useApp()
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!settings || !status) return null

  const armed = status.state === 'armed'
  const working = status.state === 'preparing' || status.state === 'stopping'
  const ready = ffmpeg?.state === 'ready'

  const stateLabel: Record<typeof status.state, string> = {
    idle: 'Idle',
    preparing: 'Arming',
    armed: 'Armed',
    stopping: 'Stopping',
    error: 'Fault'
  }

  const lampClass =
    status.state === 'armed'
      ? 'bar__lamp bar__lamp--armed'
      : status.state === 'error'
        ? 'bar__lamp bar__lamp--error'
        : working
          ? 'bar__lamp bar__lamp--busy'
          : 'bar__lamp'

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      if (armed) await window.clipbait.disarm()
      else await window.clipbait.arm()
    } finally {
      setBusy(false)
    }
  }

  return (
    <header className="bar">
      <div className="bar__main">
        <span className="bar__mark">CLIPBAIT</span>

        <span className="bar__state">
          <span className={lampClass} />
          {stateLabel[status.state]}
        </span>

        <button
          type="button"
          className="bar__meter"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title="Show capture details"
        >
          <span className="bar__held">{status.bufferedSeconds.toFixed(1)}</span>
          <span className="bar__unit">/ {settings.capture.bufferSeconds}s</span>
          <MiniStrip status={status} />
        </button>

        <div className="spacer" />

        <span className="bar__hotkey">
          {prettyAccelerator(settings.hotkeys.saveClip)} to clip
        </span>

        <button
          type="button"
          className={armed ? 'btn btn--sm' : 'btn btn--primary btn--sm'}
          disabled={busy || working || !ready}
          onClick={() => void toggle()}
        >
          {working ? 'Working' : armed ? 'Disarm' : 'Arm'}
        </button>

        <button
          type="button"
          className="btn btn--sm"
          disabled={!armed || status.bufferedSeconds < 1}
          onClick={() => void window.clipbait.saveClip()}
        >
          Clip now
        </button>

        <button type="button" className="bar__gear" onClick={onOpenSettings} title="Settings">
          SETUP
        </button>
      </div>

      {expanded && (
        <div className="bar__drawer">
          <BufferStrip status={status} />
          <Telemetry status={status} />
        </div>
      )}

      {ffmpeg?.state === 'downloading' && (
        <div className="bar__notice">
          Setting up FFmpeg — {Math.round(ffmpeg.progress * 100)}%
        </div>
      )}
      {ffmpeg?.state === 'error' && (
        <div className="bar__notice bar__notice--error">
          FFmpeg unavailable. {ffmpeg.message}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void window.clipbait.installFfmpeg()}
          >
            Retry
          </button>
        </div>
      )}
      {status.error && (
        <div className="bar__notice bar__notice--error">Capture stopped. {status.error}</div>
      )}
    </header>
  )
}
