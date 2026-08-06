import { contextBridge, ipcRenderer } from 'electron'
import type {
  AudioStartRequest,
  Clip,
  ClipCategory,
  DisplayInfo,
  EncoderInfo,
  EngineStatus,
  FfmpegStatus,
  Settings,
  SettingsPatch,
  Toast
} from '@shared/types'
import { CHANNEL } from '@shared/types'

type Off = () => void

function subscribe<T>(channel: string, cb: (payload: T) => void): Off {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api = {
  /* settings */
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: SettingsPatch): Promise<Settings> =>
    ipcRenderer.invoke('settings:update', patch),
  resetSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:reset'),
  onSettingsChanged: (cb: (s: Settings) => void): Off =>
    subscribe(CHANNEL.settingsChanged, cb),

  /* engine */
  getEngineStatus: (): Promise<EngineStatus> => ipcRenderer.invoke('engine:get'),
  arm: (): Promise<void> => ipcRenderer.invoke('engine:arm'),
  disarm: (): Promise<void> => ipcRenderer.invoke('engine:disarm'),
  saveClip: (): Promise<void> => ipcRenderer.invoke('engine:save'),
  onEngineStatus: (cb: (s: EngineStatus) => void): Off =>
    subscribe(CHANNEL.engineStatus, cb),

  /* ffmpeg */
  getFfmpegStatus: (): Promise<FfmpegStatus> => ipcRenderer.invoke('ffmpeg:get'),
  installFfmpeg: (): Promise<void> => ipcRenderer.invoke('ffmpeg:install'),
  onFfmpegStatus: (cb: (s: FfmpegStatus) => void): Off =>
    subscribe(CHANNEL.ffmpegStatus, cb),

  /* hardware */
  listDisplays: (): Promise<DisplayInfo[]> => ipcRenderer.invoke('displays:list'),
  previewDisplay: (captureIndex: number): Promise<string | null> =>
    ipcRenderer.invoke('displays:preview', captureIndex),
  listEncoders: (force?: boolean): Promise<EncoderInfo[]> =>
    ipcRenderer.invoke('encoders:list', force ?? false),

  /* clips */
  listClips: (): Promise<Clip[]> => ipcRenderer.invoke('clips:list'),
  shareClip: (id: string): Promise<void> => ipcRenderer.invoke('clips:share', id),
  cancelShare: (id: string): Promise<void> => ipcRenderer.invoke('clips:cancelShare', id),
  revealClip: (id: string): Promise<void> => ipcRenderer.invoke('clips:reveal', id),
  openClip: (id: string): Promise<void> => ipcRenderer.invoke('clips:open', id),
  deleteClip: (id: string): Promise<void> => ipcRenderer.invoke('clips:delete', id),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:copy', text),
  startDrag: (id: string): void => ipcRenderer.send('clips:drag', id),
  onClipCreated: (cb: (c: Clip) => void): Off => subscribe(CHANNEL.clipCreated, cb),
  onClipUpdated: (cb: (c: Clip) => void): Off => subscribe(CHANNEL.clipUpdated, cb),
  onClipRemoved: (cb: (id: string) => void): Off => subscribe(CHANNEL.clipRemoved, cb),
  onClipsReloaded: (cb: (clips: Clip[]) => void): Off =>
    subscribe(CHANNEL.clipsReloaded, cb),
  setClipCategory: (source: string, category: ClipCategory): Promise<void> =>
    ipcRenderer.invoke('clips:setCategory', source, category),

  /* overlay */
  onOverlayClip: (cb: (c: Clip | null) => void): Off => subscribe(CHANNEL.overlayClip, cb),
  dismissOverlay: (): void => ipcRenderer.send('overlay:dismiss'),
  pinOverlay: (pinned: boolean): void => ipcRenderer.send('overlay:pin', pinned),
  previewOverlay: (): Promise<void> => ipcRenderer.invoke('overlay:preview'),

  /* audio host (hidden window) */
  onAudioStart: (cb: (req: AudioStartRequest) => void): Off =>
    subscribe(CHANNEL.audioStart, cb),
  onAudioStop: (cb: () => void): Off => subscribe(CHANNEL.audioStop, () => cb()),
  sendPcm: (pcm: ArrayBuffer, level: number): void => {
    ipcRenderer.send('audio:pcm', pcm, level)
  },
  reportAudioError: (message: string): void => {
    ipcRenderer.send('audio:error', message)
  },

  /* misc */
  chooseFolder: (current: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:folder', current),
  openPath: (target: string): Promise<void> => ipcRenderer.invoke('shell:openPath', target),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  setHotkeyCapture: (active: boolean): Promise<void> =>
    ipcRenderer.invoke('hotkeys:capture', active),
  hotkeyConflicts: (): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('hotkeys:conflicts'),
  onToast: (cb: (t: Toast) => void): Off => subscribe(CHANNEL.toast, cb),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  quit: (): void => ipcRenderer.send('app:quit')
}

export type ClipbaitApi = typeof api

contextBridge.exposeInMainWorld('clipbait', api)
