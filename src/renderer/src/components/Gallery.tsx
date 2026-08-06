import { useMemo, useState } from 'react'
import type { Clip, ClipCategory } from '@shared/types'
import { useApp } from '../lib/store'
import { bytes, duration, expiresIn, relativeTime } from '../lib/format'

const CATEGORY_LABEL: Record<ClipCategory, string> = {
  game: 'Game',
  app: 'App',
  other: 'Other'
}

type Filter = 'all' | ClipCategory

function Shot({ clip }: { clip: Clip }): React.JSX.Element {
  const share = clip.share
  const uploading = share.status === 'uploading'
  const ready = share.status === 'ready'

  return (
    <article className="shot">
      <div
        className="shot__frame"
        draggable
        title="Drag into Discord, an editor, or a folder"
        onDragStart={(e) => {
          // Electron takes over so the OS receives a real file.
          e.preventDefault()
          window.clipbait.startDrag(clip.id)
        }}
        onDoubleClick={() => void window.clipbait.openClip(clip.id)}
      >
        {clip.thumbnailDataUrl ? (
          <img src={clip.thumbnailDataUrl} alt="" draggable={false} />
        ) : (
          <span className="shot__none">no preview</span>
        )}

        <span className="shot__len">{duration(clip.durationSeconds)}</span>

        {uploading && (
          <span className="shot__bar">
            <span className="shot__bar-fill" style={{ width: `${share.progress * 100}%` }} />
          </span>
        )}

        {/* Actions stay hidden until hover so the grid reads as pictures. */}
        <div className="shot__veil">
          <div className="shot__tools">
            {!ready && (
              <button
                type="button"
                className="shot__tool shot__tool--key"
                disabled={uploading}
                onClick={() => void window.clipbait.shareClip(clip.id)}
              >
                {uploading ? `${Math.round(share.progress * 100)}%` : 'Get link'}
              </button>
            )}
            <button
              type="button"
              className="shot__tool"
              onClick={() => void window.clipbait.openClip(clip.id)}
            >
              Play
            </button>
            <button
              type="button"
              className="shot__tool"
              onClick={() => void window.clipbait.revealClip(clip.id)}
            >
              Folder
            </button>
            <button
              type="button"
              className="shot__tool shot__tool--danger"
              onClick={() => void window.clipbait.deleteClip(clip.id)}
              aria-label={`Delete ${clip.filename}`}
            >
              Delete
            </button>
          </div>
          <span className="shot__hint">drag anywhere to share the file</span>
        </div>
      </div>

      <div className="shot__meta">
        <span className="shot__title" title={clip.filename}>
          {clip.source ?? clip.filename}
        </span>
        <span className="shot__sub">
          <span className={`chip chip--${clip.category}`}>{CATEGORY_LABEL[clip.category]}</span>
          {relativeTime(clip.createdAt)} · {bytes(clip.bytes)}
        </span>
      </div>

      {ready && (
        <button
          type="button"
          className="shot__link"
          title={`${share.url} — click to copy`}
          onClick={() => void window.clipbait.copyText(share.url)}
        >
          <code>{share.url.replace(/^https?:\/\//, '')}</code>
          <span className="shot__copy">Copy</span>
        </button>
      )}

      {ready && expiresIn(share.expiresAt) && (
        <span className="shot__note">{expiresIn(share.expiresAt)}</span>
      )}

      {share.status === 'failed' && (
        <span className="shot__note shot__note--bad">{share.message}</span>
      )}
    </article>
  )
}

export function Gallery(): React.JSX.Element {
  const { clips, settings, status } = useApp()
  const [filter, setFilter] = useState<Filter>('all')
  const [source, setSource] = useState<string>('all')
  const [query, setQuery] = useState('')

  const counts = useMemo(() => {
    const byCategory: Record<Filter, number> = { all: clips.length, game: 0, app: 0, other: 0 }
    const bySource = new Map<string, number>()
    for (const clip of clips) {
      byCategory[clip.category] += 1
      if (clip.source) bySource.set(clip.source, (bySource.get(clip.source) ?? 0) + 1)
    }
    return {
      byCategory,
      sources: [...bySource.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    }
  }, [clips])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return clips.filter((clip) => {
      if (filter !== 'all' && clip.category !== filter) return false
      if (source !== 'all' && clip.source !== source) return false
      if (!needle) return true
      return (
        clip.filename.toLowerCase().includes(needle) ||
        (clip.source ?? '').toLowerCase().includes(needle)
      )
    })
  }, [clips, filter, source, query])

  if (clips.length === 0) {
    return (
      <div className="blank">
        <h1 className="blank__title">Nothing kept yet</h1>
        <p className="blank__body">
          {status?.state === 'armed'
            ? `The buffer is running. Press ${settings?.hotkeys.saveClip ?? 'your clip key'} when something worth keeping happens.`
            : 'Arm the buffer, then press your clip key when something worth keeping happens.'}
        </p>
      </div>
    )
  }

  const tabs: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'game', label: 'Games' },
    { id: 'app', label: 'Apps' },
    { id: 'other', label: 'Other' }
  ]

  return (
    <>
      <div className="filters">
        <div className="tabs" role="group" aria-label="Filter by category">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className="tabs__tab"
              aria-pressed={filter === tab.id}
              disabled={tab.id !== 'all' && counts.byCategory[tab.id] === 0}
              onClick={() => setFilter(tab.id)}
            >
              {tab.label}
              <span className="tabs__count">{counts.byCategory[tab.id]}</span>
            </button>
          ))}
        </div>

        <select
          className="picker"
          aria-label="Filter by source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="all">Every source</option>
          {counts.sources.map(([name, n]) => (
            <option key={name} value={name}>
              {name} ({n})
            </option>
          ))}
        </select>

        <input
          className="search"
          type="search"
          placeholder="Search clips"
          aria-label="Search clips"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {/* Detection is a guess; correcting it here teaches it for good. */}
        {source !== 'all' && (
          <div className="reassign">
            <span className="reassign__label">Treat {source} as</span>
            <button
              type="button"
              className="reassign__btn"
              onClick={() => void window.clipbait.setClipCategory(source, 'game')}
            >
              Game
            </button>
            <button
              type="button"
              className="reassign__btn"
              onClick={() => void window.clipbait.setClipCategory(source, 'app')}
            >
              App
            </button>
          </div>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="blank blank--tight">
          <p className="blank__body">Nothing matches those filters.</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setFilter('all')
              setSource('all')
              setQuery('')
            }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="gallery">
          {visible.map((clip) => (
            <Shot key={clip.id} clip={clip} />
          ))}
        </div>
      )}
    </>
  )
}
