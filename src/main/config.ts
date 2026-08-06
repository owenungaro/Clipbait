import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Settings, SettingsPatch } from '@shared/types'

const FILE = () => path.join(app.getPath('userData'), 'settings.json')

export function defaultSettings(): Settings {
  return {
    capture: {
      displayId: 'primary',
      fps: 60,
      resolution: 'native',
      encoder: 'auto',
      rateControl: 'quality',
      bitrateMbps: 30,
      quality: 21,
      captureCursor: true,
      bufferSeconds: 60
    },
    audio: {
      desktopEnabled: true,
      desktopGain: 1,
      micEnabled: false,
      micDeviceId: 'default',
      micGain: 1
    },
    output: {
      folder: path.join(app.getPath('videos'), 'Clipbait'),
      filenameTemplate: '{app} {date} {time}',
      keepSegments: false
    },
    hotkeys: {
      saveClip: 'F9',
      toggleBuffer: 'Control+Shift+F9',
      openApp: 'Control+Shift+C'
    },
    overlay: {
      enabled: true,
      target: 'secondary',
      corner: 'bottom-right',
      autoHideSeconds: 12,
      playSound: false
    },
    sharing: {
      provider: 'catbox',
      litterboxExpiry: '72h',
      autoUpload: false,
      copyLinkToClipboard: true
    },
    library: {
      categoryOverrides: {}
    },
    general: {
      launchOnStartup: false,
      armOnLaunch: false,
      minimizeToTray: true,
      closeToTray: true
    }
  }
}

/**
 * Merge one level deep. Settings is a flat map of flat sections, so this is
 * enough — and it means a stored file missing a newly-added key still loads.
 */
function mergeSection<K extends keyof Settings>(
  out: Settings,
  base: Settings,
  key: K,
  patch: SettingsPatch | Partial<Settings>
): void {
  const section = patch[key]
  if (section && typeof section === 'object') {
    out[key] = { ...base[key], ...section } as Settings[K]
  }
}

function merge(base: Settings, patch: SettingsPatch | Partial<Settings>): Settings {
  const out = { ...base }
  for (const key of Object.keys(patch) as (keyof Settings)[]) {
    mergeSection(out, base, key, patch)
  }
  return out
}

let cache: Settings | null = null

export function getSettings(): Settings {
  if (cache) return cache
  const defaults = defaultSettings()
  try {
    if (existsSync(FILE())) {
      const raw = JSON.parse(readFileSync(FILE(), 'utf8')) as Partial<Settings>
      cache = merge(defaults, raw)
    } else {
      cache = defaults
    }
  } catch {
    cache = defaults
  }
  return cache
}

let writeChain: Promise<unknown> = Promise.resolve()

export function updateSettings(patch: SettingsPatch): Settings {
  const next = merge(getSettings(), patch)
  cache = next
  // Serialise writes so rapid slider drags can't interleave and corrupt.
  writeChain = writeChain
    .then(async () => {
      await fs.mkdir(path.dirname(FILE()), { recursive: true })
      await fs.writeFile(FILE(), JSON.stringify(next, null, 2), 'utf8')
    })
    .catch((err) => console.error('[config] write failed', err))
  return next
}

export function resetSettings(): Settings {
  cache = null
  return updateSettings(defaultSettings())
}

/** Where the rolling segment ring lives. Deliberately outside the user's clips folder. */
export function segmentDir(): string {
  return path.join(app.getPath('userData'), 'buffer')
}

export function cacheDir(): string {
  return path.join(app.getPath('userData'), 'cache')
}
