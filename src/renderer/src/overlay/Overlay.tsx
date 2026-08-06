import { useEffect, useState } from 'react'
import type { Clip } from '@shared/types'
import { bytes, duration } from '../lib/format'

export function Overlay(): React.JSX.Element | null {
  const [clip, setClip] = useState<Clip | null>(null)

  useEffect(() => {
    const api = window.clipbait
    const offs = [
      api.onOverlayClip(setClip),
      api.onClipUpdated((updated) =>
        setClip((prev) => (prev && prev.id === updated.id ? updated : prev))
      )
    ]
    return () => offs.forEach((off) => off())
  }, [])

  if (!clip) return null

  const share = clip.share
  const uploading = share.status === 'uploading'
  const ready = share.status === 'ready'

  return (
    <div
      className="card"
      // Hovering holds the overlay open, so it cannot vanish part-way
      // through a drag or a copy.
      onMouseEnter={() => window.clipbait.pinOverlay(true)}
      onMouseLeave={() => window.clipbait.pinOverlay(false)}
    >
      <div className="card__bar">
        <span className="card__lamp" />
        <span className="card__title">Clip saved</span>
        <button
          type="button"
          className="card__close"
          aria-label="Dismiss"
          onClick={() => window.clipbait.dismissOverlay()}
        >
          ✕
        </button>
      </div>

      <button
        type="button"
        className="card__poster"
        title="Drag into Discord, an editor, or a folder"
        draggable
        onDragStart={(e) => {
          e.preventDefault()
          window.clipbait.startDrag(clip.id)
        }}
        onDoubleClick={() => void window.clipbait.openClip(clip.id)}
      >
        {clip.thumbnailDataUrl ? (
          <img src={clip.thumbnailDataUrl} alt="" draggable={false} />
        ) : (
          <span className="eyebrow">no preview</span>
        )}
        <span className="card__grab">
          <span className="card__grab-icon" />
          <span className="eyebrow" style={{ color: 'var(--accent-hi)' }}>
            drag to share
          </span>
        </span>
        <span className="card__badge">{duration(clip.durationSeconds)}</span>
      </button>

      <div className="card__foot">
        <div>
          <div className="card__name" title={clip.filename}>
            {clip.filename}
          </div>
          <div className="eyebrow">
            {bytes(clip.bytes)}
            {clip.width > 0 && ` · ${clip.width}×${clip.height}`}
          </div>
        </div>

        {uploading && (
          <div className="progress">
            <div
              className="progress__fill"
              style={{ width: `${share.progress * 100}%` }}
            />
          </div>
        )}

        {ready && (
          <div className="card__link">
            <code>{share.url}</code>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void window.clipbait.copyText(share.url)}
            >
              Copy
            </button>
          </div>
        )}

        {share.status === 'failed' && (
          <div className="eyebrow" style={{ color: 'var(--live)' }}>
            {share.message}
          </div>
        )}

        <div className="card__row">
          {!ready && (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={uploading}
              onClick={() => void window.clipbait.shareClip(clip.id)}
            >
              {uploading ? `Uploading ${Math.round(share.progress * 100)}%` : 'Get link'}
            </button>
          )}
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void window.clipbait.revealClip(clip.id)}
          >
            Folder
          </button>
          <div className="spacer" />
          <button
            type="button"
            className="btn btn--sm btn--ghost btn--danger"
            onClick={() => {
              void window.clipbait.deleteClip(clip.id)
              window.clipbait.dismissOverlay()
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
