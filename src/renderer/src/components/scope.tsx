import { useMemo } from 'react'
import type { EngineStatus } from '@shared/types'

/** Older footage is drawn fainter, so it visibly thins before eviction. */
function fadeFor(age: number): number {
  return 0.3 + 0.7 * age
}

/**
 * The ring buffer, drawn as the segments that actually exist on disk.
 *
 * One tick per segment slot. Height is that segment's bitrate, so the strip
 * doubles as an activity trace — a still desktop draws flat, a busy scene
 * draws tall. Older ticks fade out, so footage visibly thins as it approaches the
 * eviction edge. The leading tick, drawn in the live colour, is the segment
 * ffmpeg is writing right now.
 */
export function BufferStrip({ status }: { status: EngineStatus }): React.JSX.Element {
  const { capacity, ticks } = useMemo(() => {
    const segmentLength = 2
    const slots = Math.max(1, Math.ceil(status.bufferCapacitySeconds / segmentLength))
    const recent = status.segments.slice(-slots)

    const rates = recent.map((s) =>
      s.durationSeconds > 0.2 ? s.bytes / s.durationSeconds : 0
    )
    const peak = Math.max(...rates, 1)

    const filled = recent.map((s, i) => ({
      key: `${s.startedAt}`,
      level: Math.max(0.07, rates[i] / peak),
      age: recent.length > 1 ? i / (recent.length - 1) : 1,
      live: i === recent.length - 1
    }))

    return { capacity: slots, ticks: filled }
  }, [status.segments, status.bufferCapacitySeconds])

  const empties = Math.max(0, capacity - ticks.length)
  const span = Math.round(status.bufferCapacitySeconds)

  return (
    <div>
      <div className="strip">
        {Array.from({ length: empties }, (_, i) => (
          <span key={`empty-${i}`} className="strip__tick strip__tick--empty" />
        ))}
        {ticks.map((t) => (
          <span
            key={t.key}
            className={`strip__tick${t.live ? ' strip__tick--live' : ''}`}
            style={{
              height: `${Math.round(12 + 76 * t.level)}%`,
              opacity: t.live ? 1 : fadeFor(t.age)
            }}
          />
        ))}
      </div>
      <div className="strip__scale">
        <span className="eyebrow">−{span}s</span>
        <span className="eyebrow">−{Math.round(span / 2)}s</span>
        <span className="eyebrow">now</span>
      </div>
    </div>
  )
}

/**
 * The strip reduced to status-bar size. Same language — bitrate as height,
 * age as opacity — just fewer, narrower ticks.
 */
export function MiniStrip({ status }: { status: EngineStatus }): React.JSX.Element {
  const ticks = useMemo(() => {
    const slots = 22
    const recent = status.segments.slice(-slots)
    const rates = recent.map((s) =>
      s.durationSeconds > 0.2 ? s.bytes / s.durationSeconds : 0
    )
    const peak = Math.max(...rates, 1)
    return recent.map((s, i) => ({
      key: String(s.startedAt),
      level: Math.max(0.12, rates[i] / peak),
      age: recent.length > 1 ? i / (recent.length - 1) : 1,
      live: i === recent.length - 1
    }))
  }, [status.segments])

  const empties = Math.max(0, 22 - ticks.length)

  return (
    <div className="ministrip" title={`${status.bufferedSeconds.toFixed(1)}s held`}>
      {Array.from({ length: empties }, (_, i) => (
        <span key={`e${i}`} className="ministrip__tick ministrip__tick--empty" />
      ))}
      {ticks.map((t) => (
        <span
          key={t.key}
          className={`ministrip__tick${t.live ? ' ministrip__tick--live' : ''}`}
          style={{
            height: `${Math.round(18 + 82 * t.level)}%`,
            opacity: t.live ? 1 : fadeFor(t.age)
          }}
        />
      ))}
    </div>
  )
}

export function Telemetry({ status }: { status: EngineStatus }): React.JSX.Element {
  const armed = status.state === 'armed'
  const fpsShort = armed && status.fps > 0 && status.fps < status.targetFps * 0.9

  const cells: { label: string; value: string; tone?: 'warn' | 'muted' }[] = [
    {
      label: 'Encoder',
      value: status.encoderLabel ?? '—',
      tone: status.encoderLabel ? undefined : 'muted'
    },
    {
      label: 'Source',
      value: status.display ? `${status.display.width}×${status.display.height}` : '—',
      tone: status.display ? undefined : 'muted'
    },
    {
      label: 'Frame rate',
      value: armed ? `${status.fps.toFixed(1)} / ${status.targetFps}` : `— / ${status.targetFps}`,
      tone: fpsShort ? 'warn' : armed ? undefined : 'muted'
    },
    {
      label: 'Bitrate',
      value: armed && status.bitrateKbps > 0 ? `${(status.bitrateKbps / 1000).toFixed(1)} Mb/s` : '—',
      tone: armed && status.bitrateKbps > 0 ? undefined : 'muted'
    },
    {
      label: 'Dropped',
      value: armed ? String(status.droppedFrames) : '—',
      tone: status.droppedFrames > 0 ? 'warn' : armed ? undefined : 'muted'
    },
    {
      label: 'Audio',
      value: !status.audio.desktop && !status.audio.mic
        ? 'Off'
        : [status.audio.desktop && 'Desktop', status.audio.mic && 'Mic']
            .filter(Boolean)
            .join(' + '),
      tone: !status.audio.desktop && !status.audio.mic ? 'muted' : undefined
    }
  ]

  return (
    <div className="telemetry">
      {cells.map((c) => (
        <div key={c.label} className="telemetry__cell">
          <span className="eyebrow">{c.label}</span>
          <span
            className={`telemetry__value${
              c.tone === 'warn'
                ? ' telemetry__value--warn'
                : c.tone === 'muted'
                  ? ' telemetry__value--muted'
                  : ''
            }`}
          >
            {c.value}
          </span>
        </div>
      ))}
    </div>
  )
}
