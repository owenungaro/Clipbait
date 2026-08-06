import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import type {
  Clip,
  DisplayInfo,
  EncoderInfo,
  EngineStatus,
  FfmpegStatus,
  Settings,
  SettingsPatch,
  Toast
} from '@shared/types'

interface AppState {
  settings: Settings | null
  status: EngineStatus | null
  ffmpeg: FfmpegStatus | null
  clips: Clip[]
  displays: DisplayInfo[]
  encoders: EncoderInfo[]
  toasts: Toast[]
  conflicts: Record<string, boolean>
  patch: (p: SettingsPatch) => void
  refreshClips: () => void
  dismissToast: (id: string) => void
}

const Ctx = createContext<AppState | null>(null)

export function AppProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null)
  const [clips, setClips] = useState<Clip[]>([])
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [encoders, setEncoders] = useState<EncoderInfo[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [conflicts, setConflicts] = useState<Record<string, boolean>>({})

  const refreshClips = useCallback(() => {
    void window.clipbait.listClips().then(setClips)
  }, [])

  useEffect(() => {
    const api = window.clipbait
    void api.getSettings().then(setSettings)
    void api.getEngineStatus().then(setStatus)
    void api.getFfmpegStatus().then(setFfmpeg)
    void api.listDisplays().then(setDisplays)
    void api.listEncoders().then(setEncoders)
    void api.hotkeyConflicts().then(setConflicts)
    refreshClips()

    const offs = [
      api.onSettingsChanged(setSettings),
      api.onEngineStatus(setStatus),
      api.onFfmpegStatus((next) => {
        setFfmpeg(next)
        // Encoder probing only means anything once the binary is in place.
        if (next.state === 'ready') void api.listEncoders().then(setEncoders)
      }),
      api.onClipCreated((clip) => setClips((prev) => [clip, ...prev])),
      api.onClipUpdated((clip) =>
        setClips((prev) => prev.map((c) => (c.id === clip.id ? clip : c)))
      ),
      api.onClipRemoved((id) => setClips((prev) => prev.filter((c) => c.id !== id))),
      api.onClipsReloaded(setClips),
      api.onToast((toast) => {
        setToasts((prev) => [...prev.slice(-3), toast])
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== toast.id))
        }, 5200)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [refreshClips])

  const patch = useCallback((p: SettingsPatch) => {
    // Update locally first so controls never feel laggy, then reconcile.
    setSettings((prev) => {
      if (!prev) return prev
      const next = { ...prev }
      const apply = <K extends keyof Settings>(key: K): void => {
        const section = p[key]
        if (section) next[key] = { ...prev[key], ...section } as Settings[K]
      }
      for (const key of Object.keys(p) as (keyof Settings)[]) apply(key)
      return next
    })
    void window.clipbait.updateSettings(p).then((saved) => {
      setSettings(saved)
      if (p.hotkeys) void window.clipbait.hotkeyConflicts().then(setConflicts)
    })
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const value = useMemo<AppState>(
    () => ({
      settings,
      status,
      ffmpeg,
      clips,
      displays,
      encoders,
      toasts,
      conflicts,
      patch,
      refreshClips,
      dismissToast
    }),
    [settings, status, ffmpeg, clips, displays, encoders, toasts, conflicts, patch, refreshClips, dismissToast]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useApp(): AppState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useApp must be used inside AppProvider')
  return ctx
}
