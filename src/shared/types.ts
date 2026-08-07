/**
 * The contract shared by main, preload and renderer.
 * Everything crossing the IPC boundary is described here.
 */

/* ------------------------------------------------------------------ settings */

export type EncoderChoice = "auto" | "nvenc" | "qsv" | "amf" | "x264";
export type ResolutionChoice = "native" | "1440p" | "1080p" | "720p";
export type RateControl = "quality" | "bitrate";
export type OverlayTarget = "secondary" | "primary" | "active";
export type OverlayCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";
export type ShareProvider = "catbox" | "litterbox";
export type LitterboxExpiry = "1h" | "12h" | "24h" | "72h";

export interface CaptureSettings {
  /** Electron display id, or 'primary' to always follow the primary monitor. */
  displayId: string;
  fps: number;
  resolution: ResolutionChoice;
  encoder: EncoderChoice;
  rateControl: RateControl;
  /** Used when rateControl is 'bitrate'. */
  bitrateMbps: number;
  /** 0 (best) .. 51 (worst); used when rateControl is 'quality'. */
  quality: number;
  captureCursor: boolean;
  /** How many seconds of history the ring buffer keeps. */
  bufferSeconds: number;
}

export interface AudioSettings {
  desktopEnabled: boolean;
  /** Linear gain, 0..2. */
  desktopGain: number;
  micEnabled: boolean;
  /** MediaDevices deviceId, or 'default'. */
  micDeviceId: string;
  micGain: number;
}

export interface OutputSettings {
  folder: string;
  /** Supports {date} {time} {datetime} {app} {display} {n} tokens. */
  filenameTemplate: string;
  /** Keep the source segments after a clip is written (for debugging). */
  keepSegments: boolean;
}

export interface HotkeySettings {
  saveClip: string;
  toggleBuffer: string;
  openApp: string;
}

export interface OverlaySettings {
  enabled: boolean;
  target: OverlayTarget;
  corner: OverlayCorner;
  /** Seconds before it auto-dismisses; 0 keeps it until dismissed. */
  autoHideSeconds: number;
  playSound: boolean;
}

export interface SharingSettings {
  provider: ShareProvider;
  litterboxExpiry: LitterboxExpiry;
  /** Start uploading the moment a clip lands, without being asked. */
  autoUpload: boolean;
  copyLinkToClipboard: boolean;
}

export interface LibrarySettings {
  /**
   * Manual corrections, keyed by source name. Detection is a heuristic, so the
   * user's answer always wins and applies to every clip from that source.
   */
  categoryOverrides: Record<string, ClipCategory>;
}

export interface GeneralSettings {
  launchOnStartup: boolean;
  armOnLaunch: boolean;
  minimizeToTray: boolean;
  closeToTray: boolean;
}

export interface Settings {
  capture: CaptureSettings;
  audio: AudioSettings;
  output: OutputSettings;
  hotkeys: HotkeySettings;
  overlay: OverlaySettings;
  sharing: SharingSettings;
  library: LibrarySettings;
  general: GeneralSettings;
}

/** A deep-partial patch, which is what the renderer sends on every edit. */
export type SettingsPatch = {
  [K in keyof Settings]?: Partial<Settings[K]>;
};

/* ------------------------------------------------------------------- engine */

export type EngineState = "idle" | "preparing" | "armed" | "stopping" | "error";

export interface SegmentInfo {
  /** Wall-clock ms when this segment started recording. */
  startedAt: number;
  durationSeconds: number;
  bytes: number;
}

export interface EngineStatus {
  state: EngineState;
  /** Wall-clock ms the engine entered its current state. */
  since: number | null;
  /** Resolved ffmpeg encoder name, e.g. 'h264_qsv'. */
  encoder: string | null;
  encoderLabel: string | null;
  display: { id: string; label: string; width: number; height: number } | null;
  /** Frames per second ffmpeg reports it is actually delivering. */
  fps: number;
  targetFps: number;
  bitrateKbps: number;
  droppedFrames: number;
  /** Seconds of history currently held. */
  bufferedSeconds: number;
  bufferCapacitySeconds: number;
  segments: SegmentInfo[];
  audio: { desktop: boolean; mic: boolean; level: number };
  /** Foreground window's app name, polled while armed; feeds the {app} token. */
  foregroundApp: string | null;
  error: string | null;
}

/* -------------------------------------------------------------------- clips */

export type ShareState =
  | { status: "none" }
  | { status: "uploading"; progress: number }
  | {
      status: "ready";
      url: string;
      provider: ShareProvider;
      expiresAt: number | null;
    }
  | { status: "failed"; message: string };

/** What a clip was captured from. Drives the library filters. */
export type ClipCategory = "game" | "app" | "other";

export interface Clip {
  id: string;
  path: string;
  filename: string;
  /** App or game the clip came from, e.g. "VALORANT". Null if unknown. */
  source: string | null;
  category: ClipCategory;
  thumbnailDataUrl: string | null;
  durationSeconds: number;
  bytes: number;
  width: number;
  height: number;
  createdAt: number;
  share: ShareState;
}

/* ----------------------------------------------------------------- hardware */

export interface DisplayInfo {
  id: string;
  label: string;
  width: number;
  height: number;
  scaleFactor: number;
  isPrimary: boolean;
  /** Index ddagrab uses to address this monitor (output_idx). */
  captureIndex: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface EncoderInfo {
  id: Exclude<EncoderChoice, "auto">;
  ffmpegName: string;
  label: string;
  detail: string;
  available: boolean;
  hardware: boolean;
}

export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
}

export interface FfmpegStatus {
  state: "missing" | "downloading" | "ready" | "error";
  path: string | null;
  version: string | null;
  progress: number;
  message: string | null;
}

/* ---------------------------------------------------------------- updates */

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  /** Version of the pending update once known, e.g. "1.1.0". */
  version: string | null;
  /** 0..1 while the installer downloads. */
  progress: number;
  /** Populated when state is 'error'. */
  message: string | null;
}

/* ---------------------------------------------------------------- ipc names */

/** Main -> renderer pushes. */
export const CHANNEL = {
  engineStatus: "engine:status",
  ffmpegStatus: "ffmpeg:status",
  settingsChanged: "settings:changed",
  clipCreated: "clip:created",
  clipUpdated: "clip:updated",
  clipRemoved: "clip:removed",
  clipsReloaded: "clips:reloaded",
  overlayClip: "overlay:clip",
  audioStart: "audio:start",
  audioStop: "audio:stop",
  toast: "ui:toast",
  updateStatus: "update:status",
} as const;

export interface AudioStartRequest {
  sampleRate: number;
  channels: number;
  desktopEnabled: boolean;
  desktopGain: number;
  micEnabled: boolean;
  micDeviceId: string;
  micGain: number;
}

export interface Toast {
  id: string;
  kind: "info" | "success" | "error";
  message: string;
}
