import type { ClipCategory } from '@shared/types'

/**
 * Works out whether a clip came from a game or an ordinary application.
 *
 * Where the executable lives is a far better signal than what it is called:
 * anything under a launcher's library folder is a game, whatever it is named.
 * Name matching is only the fallback for when the path could not be read.
 */

/** Launcher library folders. A hit here is decisive. */
const GAME_DIRS = [
  'steamapps',
  'steamlibrary',
  'epic games',
  'riot games',
  'gog games',
  'gog galaxy',
  'battle.net',
  'ubisoft',
  'ea games',
  'ea desktop',
  'origin games',
  'xboxgames',
  'windowsapps\\microsoft.minecraft',
  'rockstar games',
  'roblox'
]

/** Shipped-build markers that only games use. */
const GAME_MARKERS = [/-win64-shipping/i, /-wingdk-shipping/i, /_be\b/i, /-shipping/i]

/** Everyday software, matched on process name when the path is unavailable. */
const KNOWN_APPS = new Set([
  'chrome',
  'msedge',
  'firefox',
  'brave',
  'opera',
  'arc',
  'zen',
  'discord',
  'slack',
  'teams',
  'zoom',
  'telegram',
  'whatsapp',
  'signal',
  'spotify',
  'vlc',
  'mpc-hc',
  'obs64',
  'obs',
  'code',
  'cursor',
  'devenv',
  'rider',
  'idea64',
  'pycharm64',
  'sublime_text',
  'notepad',
  'notepad++',
  'notion',
  'obsidian',
  'figma',
  'photoshop',
  'illustrator',
  'premiere',
  'afterfx',
  'blender',
  'excel',
  'winword',
  'powerpnt',
  'outlook',
  'acrobat',
  'steam',
  'epicgameslauncher',
  'explorer',
  'thunderbird',
  'windowsterminal',
  'powershell',
  'pwsh'
])

function normalise(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * @param source  friendly name, e.g. "VALORANT"
 * @param exePath full path to the executable, or '' if it could not be read
 * @param overrides user corrections keyed by source name
 */
export function classify(
  source: string | null,
  exePath: string,
  overrides: Record<string, ClipCategory> = {}
): ClipCategory {
  if (!source) return 'other'

  // A correction the user made always wins.
  const override = overrides[source] ?? overrides[normalise(source)]
  if (override) return override

  const path = normalise(exePath.replace(/\//g, '\\'))
  if (path) {
    if (GAME_DIRS.some((dir) => path.includes(dir))) return 'game'
    if (GAME_MARKERS.some((marker) => marker.test(path))) return 'game'
  }

  const name = normalise(source).replace(/\.exe$/, '')
  if (KNOWN_APPS.has(name)) return 'app'
  if (GAME_MARKERS.some((marker) => marker.test(name))) return 'game'

  // Program Files without a launcher folder is far more often an application.
  if (path.includes('\\program files') || path.includes('\\appdata\\local\\programs')) {
    return 'app'
  }

  return 'other'
}

export const CATEGORY_LABEL: Record<ClipCategory, string> = {
  game: 'Games',
  app: 'Apps',
  other: 'Other'
}
