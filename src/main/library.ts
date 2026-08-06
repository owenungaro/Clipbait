import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Clip, ClipCategory } from '@shared/types'
import { classify } from './classify'
import { getSettings } from './config'

const MAX_CLIPS = 60

function file(): string {
  return path.join(app.getPath('userData'), 'clips.json')
}

let clips: Clip[] | null = null
let writeChain: Promise<unknown> = Promise.resolve()

/**
 * Clips written before categories existed only carry a filename, which is
 * "{source} {date} {time}.mp4" — enough to recover the source and classify it.
 */
function backfill(clip: Clip): Clip {
  if (clip.source !== undefined && clip.category !== undefined) return clip
  const base = clip.filename.replace(/\.[^.]+$/, '')
  const match = base.match(/^(.*?)\s*\d{4}-\d{2}-\d{2}/)
  const source = match?.[1]?.trim() || null
  return {
    ...clip,
    source,
    // No executable path survives in the file, so this leans on the name list
    // and whatever the user has already corrected.
    category: classify(source, '', getSettings().library.categoryOverrides)
  }
}

function load(): Clip[] {
  if (clips) return clips
  try {
    if (existsSync(file())) {
      const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Clip[]
      clips = Array.isArray(parsed) ? parsed.map(backfill) : []
    } else {
      clips = []
    }
  } catch {
    clips = []
  }
  return clips
}

/** Re-apply categories to every clip, after the user corrects a source. */
export function recategorise(source: string, category: ClipCategory): Clip[] {
  const all = load()
  for (const clip of all) {
    if (clip.source === source) clip.category = category
  }
  persist()
  return all
}

function persist(): void {
  const snapshot = load()
  writeChain = writeChain
    .then(() => fs.writeFile(file(), JSON.stringify(snapshot), 'utf8'))
    .catch((err) => console.error('[library] write failed', err))
}

/** Clips whose files the user has since deleted should not linger in the UI. */
export async function listClips(): Promise<Clip[]> {
  const all = load()
  const alive: Clip[] = []
  for (const clip of all) {
    try {
      await fs.access(clip.path)
      alive.push(clip)
    } catch {
      /* file is gone; drop it */
    }
  }
  if (alive.length !== all.length) {
    clips = alive
    persist()
  }
  return alive
}

export function addClip(clip: Clip): void {
  const all = load()
  all.unshift(clip)
  if (all.length > MAX_CLIPS) all.length = MAX_CLIPS
  persist()
}

export function getClip(id: string): Clip | undefined {
  return load().find((c) => c.id === id)
}

export function updateClip(id: string, patch: Partial<Clip>): Clip | undefined {
  const all = load()
  const index = all.findIndex((c) => c.id === id)
  if (index < 0) return undefined
  all[index] = { ...all[index], ...patch }
  persist()
  return all[index]
}

export async function removeClip(id: string, deleteFile: boolean): Promise<void> {
  const all = load()
  const index = all.findIndex((c) => c.id === id)
  if (index < 0) return
  const [clip] = all.splice(index, 1)
  persist()
  if (deleteFile) {
    await fs.rm(clip.path, { force: true }).catch(() => {})
  }
}
