import { release as osRelease } from 'node:os';
import type { AudioDeviceSource, AudioDeviceStatus, AudioDeviceListResult } from '../../../bindings/typescript/audio-devices.js';
export type { AudioDeviceSource, AudioDeviceInfo, AudioDeviceStatus, AudioDeviceListResult, AudioDeviceOperationError } from '../../../bindings/typescript/audio-devices.js';

import { prepareEngineRuntime } from './runtime/engine-runtime.js';
import type { EngineAuthorizationRequest, EngineAuthorizationStatus } from '../../../bindings/typescript/authorization/contracts.js';

export interface AudioProcessingConfig {
  /**
   * Engine output rate: what the caller receives (chunks, payloads, rawAudio.mixed, sample clocks). Default 16000.
   * This is not the device capture rate: the internal pipeline always runs at 48 kHz and any device rate is resampled.
   * Must be within 8000..=192000 Hz and give a whole number of samples per chunkDurationMs chunk.
   * Opus supports only 8000, 12000, 16000, 24000, or 48000 Hz; use pcm_s16le or pcm_f32le for other rates.
   */
  sampleRate?: number;
  chunkDurationMs?: number;
}

export interface AudioTransportConfig {
  codec?: 'opus' | 'pcm_s16le' | 'pcm_f32le';
  bitrateBps?: number;
}

export type AudioTrackSource =
  | 'microphone'
  | 'screen_share_audio'
  | 'system_audio'
  | 'microphone_speaker_mix';

/** Audio capture configuration. */
export interface AudioCaptureConfig {
  /** Omit to follow the OS default input. */
  micDeviceId?: string;
  /** Output ID to capture system audio from. */
  systemAudioDeviceId?: string;
  /** The desktop engine playback path is not supported. */
  playbackDeviceId?: string;
  /** iOS only. Unsupported on desktop. */
  iosOutputRoute?: 'speaker' | 'system';
  /** Enables microphone capture. Native default is true. */
  micEnabled?: boolean;
  /** Enables speaker/system-audio capture. Native default is false. */
  speakerEnabled?: boolean;
  /** Includes synchronized PCM16 raw frames in chunk.rawAudio. */
  enableRawAudio?: boolean;
  /** Enables denoise. Native default is true. */
  denoiseEnabled?: boolean;
  /**
   * Denoise output policy. Native default is 'close_talk'. Surrounding spaces and case are ignored; unknown values throw.
   * 'close_talk' adds a near-speech gate that turns far sound into exact silence, delays the microphone by 300 ms more,
   * and limits noise attenuation to at most 12 dB. 'general' keeps the denoise model output with no attenuation limit.
   * Both apply to the microphone only and leave rawAudio.mic unchanged.
   * With denoiseEnabled: false the gate is off too.
   */
  denoiseMode?: 'close_talk' | 'general';
  /** Enables the native VAD gate. Native default is false. */
  vadEnabled?: boolean;
  /** Processing/mixer settings. */
  processing?: AudioProcessingConfig;
  /** Final transport payload settings. Native default is { codec: "opus" }. */
  transport?: AudioTransportConfig;
}

export interface VADConfig {
  /** Speech start threshold for the VAD model probability. */
  vadPositiveThreshold?: number;
  /** Speech end threshold for the VAD model probability. */
  vadNegativeThreshold?: number;
  /** Compatibility value. The VAD model does not use RMS for speech decisions. */
  vadRmsThreshold?: number;
  /** Keep the gate open for this long after the last speech frame. */
  vadSilenceDurationMs?: number;
  /** Keep this much pre-speech context inside the VAD gate. */
  vadPreSpeechBufferMs?: number;
}

export interface RawAudioFrame {
  /** PCM16 little-endian audio bytes. */
  data: Buffer;
  /** mic/speaker raw uses the original device sample rate; mixed raw uses processing sample rate. */
  sampleRate: number;
  /** mic/speaker raw sample cursor is based on the original device stream. */
  sample: number;
  /** Unix epoch timestamp in milliseconds. */
  timestamp: number;
  /** RMS level, 0.0 to 1.0. */
  rms: number;
}

export interface RawAudioBundle {
  /** Microphone PCM16 frame at the original microphone device sample rate, or null when inactive. */
  mic?: RawAudioFrame | null;
  /** Speaker PCM16 frame at the original speaker device sample rate, or null when disabled or temporarily unavailable. */
  speaker?: RawAudioFrame | null;
  /** Mixed PCM16 frame at the configured processing sample rate, or null unless both sources are enabled. */
  mixed?: RawAudioFrame | null;
}

export interface AudioData {
  /** Microphone output payload. Filled for mic-only and mixed output. */
  microphone?: Buffer;
  /** System-audio output payload. Filled for speaker-only output. */
  system_audio?: Buffer;
  /** macOS ScreenCaptureKit fallback speaker-only output payload. */
  screen_share_audio?: Buffer;
  /** Speaker component payload for mixed output. */
  speaker?: Buffer;
  /** Mixed output payload. */
  mixed?: Buffer;
}

export type AudioDiscontinuityReason = 'consumer_lag' | 'native_overrun' | 'device_gap';

export interface AudioDiscontinuity {
  reason: AudioDiscontinuityReason;
  droppedChunks: number;
  droppedSamples: number;
  /** First missing processing sample, inclusive. */
  fromSample: number;
  /** End of the missing processing sample range, exclusive. */
  toSample: number;
}

export interface AudioChunk {
  /** Final transport payloads keyed by source. */
  data: AudioData;
  /** Source label for the primary final transport payload. */
  trackSource: AudioTrackSource;
  /** Codec used for the final transport payloads in data. */
  codec: 'opus' | 'pcm_s16le' | 'pcm_f32le';
  sampleRate: number;
  /** Number of samples per channel in this transport chunk. */
  sampleCount: number;
  /** Duration covered by this transport chunk in milliseconds. */
  durationMs: number;
  sample: number;
  timestamp: number;
  rms: number;
  /** Present on VAD gate transition chunks. */
  gateEvent?: string;
  /** Present when VAD is enabled. RMS measured on the VAD input chunk. */
  vadRms?: number;
  /** Present only when enableRawAudio is true. */
  rawAudio?: RawAudioBundle;
  /** Output order within the current capture session, starting at zero. */
  sequence?: number;
  /** Missing sample range immediately before this delivered chunk. */
  discontinuity?: AudioDiscontinuity;
}

export interface CaptureStatus {
  deviceStatus?: AudioDeviceStatus[];
  state: string;
  micThreadAlive: boolean;
  speakerThreadAlive: boolean;
  mixerThreadAlive: boolean;
  denoiseActive: boolean;
  aecActive: boolean;
  vadEnabled: boolean;
  vadReady: boolean;
  vadMode: string;
  vadGateState: 'open' | 'closed';
  vadProbability: number;
  vadRms: number;
  vadIsSpeech: boolean;
  vadPositiveThreshold: number;
  vadNegativeThreshold: number;
  vadRmsThreshold: number;
  vadSilenceDurationMs: number;
  vadPreSpeechBufferMs: number;
  deliveryQueueCapacityChunks: number;
  deliveryQueueSizeChunks: number;
  deliveryQueueHighWatermarkChunks: number;
  deliveryDroppedChunks: number;
  deliveryDroppedSamples: number;
  deliveryNotificationPending: boolean;
  rawQueueCapacityMs: number;
  rawMicQueueSamples: number;
  rawSpeakerQueueSamples: number;
  rawMicDroppedSamples: number;
  rawSpeakerDroppedSamples: number;
}

export interface CaptureError {
  deviceStatus?: AudioDeviceStatus;
  source: string;
  message: string;
  recoverable: boolean;
}

export interface MicActiveApp {
  processId: number;
  appName: string;
  bundleId?: string;
}

/** The Zoom desktop app, or Google Meet in a browser. */
export type MeetingAppId = 'zoom' | 'google_meet';
export type MeetingSyncMode = 'off' | 'auto' | 'manual';
export type MeetingSyncStateName = 'off' | 'idle' | 'needs_link' | 'synced' | 'lost';
export type MeetingSyncReason =
  | 'accessibility_permission'
  | 'control_not_found'
  | 'unknown_label'
  | 'app_not_running'
  | 'read_failed'
  /** The meeting view is not visible, so the value cannot be trusted (minimized window, background tab, covered Safari window, and so on). */
  | 'meeting_hidden';
export type MeetingAudioState = 'unmuted' | 'muted' | 'telephone' | 'not_joined';

/** An app using the microphone, plus its app ID if it is a meeting app that can be synced. */
export interface MeetingCandidate extends MicActiveApp {
  appId?: MeetingAppId;
}

/** Meeting app mute item titles to add to the engine's default label table. Each list name is the meeting app state when that title is shown. */
export interface MeetingAudioLabels {
  unmuted?: string[];
  muted?: string[];
  telephone?: string[];
  notJoined?: string[];
}

export interface MeetingSyncOptions {
  mode: MeetingSyncMode;
  /** Required when mode is manual. */
  targetAppId?: MeetingAppId;
  /** 100 to 2000, default 250. */
  pollIntervalMs?: number;
  /** 0 to 60000, default 5000. */
  unknownGraceMs?: number;
  labels?: MeetingAudioLabels;
}

export interface MeetingSyncEvent {
  state: MeetingSyncStateName;
  mode: MeetingSyncMode;
  appId?: MeetingAppId;
  reason?: MeetingSyncReason;
  meetingAudio?: MeetingAudioState;
  /** Last mute item title read (for diagnostics). */
  controlTitle?: string;
  /** Microphone mute actually applied. */
  micMuted: boolean;
  /** True while the meeting app decides the microphone (synced or lost). setMicMuted then throws mic_sync_active. */
  micControlled: boolean;
  observedAtMs: number;
}

export type MeetingSyncCallback = (err: Error | null, event: MeetingSyncEvent) => unknown;

export interface AudioEngineDenoiseInitStatus {
  enabled: boolean;
  active: boolean;
  reused: boolean;
  model: string;
  /** Applied denoiseMode. */
  mode: string;
  modelDir?: string;
  sampleRateHz: number;
  preparedInstances: number;
  warmupMs: number;
}

export interface AudioEngineVadInitStatus {
  enabled: boolean;
  active: boolean;
  ready: boolean;
  reused: boolean;
  model: string;
  modelDir?: string;
  sampleRateHz: number;
  warmupMs: number;
}

export interface AudioEngineDspInitStatus {
  enabled: boolean;
  dcRemovalEnabled: boolean;
  hpfEnabled: boolean;
  micAgc2Enabled: boolean;
  limiterEnabled: boolean;
}

export interface AudioEngineInitStatus {
  initialized: boolean;
  reused: boolean;
  modelsPreloaded: boolean;
  processingSampleRate: number;
  chunkDurationMs: number;
  denoise: AudioEngineDenoiseInitStatus;
  vad: AudioEngineVadInitStatus;
  dsp: AudioEngineDspInitStatus;
}

export interface AudioEngineModelsPreloadStatus {
  denoise: AudioEngineDenoiseInitStatus;
  vad: AudioEngineVadInitStatus;
}

export interface AudioEngineInitOptions {
  preloadModels?: boolean;
}

export type CapturePermissionRequest = 'microphone' | 'speaker';
export type CapturePermissionScope = 'microphone' | 'system_audio' | 'screen_recording' | 'none';
export type CapturePermissionBackend =
  | 'cpal_microphone'
  | 'core_audio_tap'
  | 'screen_capture_kit'
  | 'wasapi_loopback'
  | 'pulseaudio_monitor'
  | 'unsupported';
export type CapturePermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown';

export interface CapturePermissionRawResult {
  api: string;
  value?: boolean | null;
  statusCode?: number | null;
  errorCode?: number | null;
  errorDomain?: string | null;
  errorMessage?: string | null;
}

export interface CapturePermissionCheckResult {
  granted: boolean;
  request: CapturePermissionRequest;
  permissionScope: CapturePermissionScope;
  trackSource?: AudioTrackSource | null;
  backend: CapturePermissionBackend;
  status: CapturePermissionStatus;
  message: string;
  error?: string;
  reason?: string;
  probeStage?: string;
  elapsedMs?: number;
  captureHealth?: 'ready' | 'silent' | 'failed' | 'not-run' | null;
  captureReady?: boolean;
  captureError?: string;
  rawStatus?: string;
  rawResult?: CapturePermissionRawResult;
  capabilityStatus?: string;
  capabilityResult?: CapturePermissionRawResult;
}

export interface PermissionOpenResult {
  opened: boolean;
  error?: string;
}

export interface MicrophonePermissionOpenResult extends PermissionOpenResult {}
export interface SystemAudioPermissionOpenResult extends PermissionOpenResult {}
export interface ScreenCapturePermissionOpenResult extends PermissionOpenResult {}
export interface AccessibilityPermissionOpenResult extends PermissionOpenResult {}

/** Result of checking the Accessibility permission needed to read the meeting app's window. */
export interface AccessibilityPermissionCheckResult {
  /** True if the meeting app's window can be read. Also true on platforms that need no permission. */
  granted: boolean;
  /** Whether this platform needs the Accessibility permission (true only on macOS). */
  required: boolean;
  /** macOS cannot tell not-yet-granted from denied, so both are denied. */
  status: 'granted' | 'denied' | 'not-required';
  message: string;
}

export type ErrorCallback = (err: Error | null, arg: CaptureError) => unknown;
export type AudioChunkCallback = (err: Error | null, arg: AudioChunk) => unknown;

const { nativeBinding } = prepareEngineRuntime();

const {
  AudioCapture: NativeAudioCapture,
  listAudioDevices: nativeListAudioDevices,
  listMicDevices: nativeListMicDevices,
  listSpeakerDevices: nativeListSpeakerDevices,
  isSpeakerCaptureSupported: nativeIsSpeakerCaptureSupported,
  probeMicCapture: nativeProbeMicCapture,
  checkMicCapturePermission: nativeCheckMicCapturePermission,
  checkMicCapturePermissionInfo: nativeCheckMicCapturePermissionInfo,
  checkSpeakerCapturePermissionInfo: nativeCheckSpeakerCapturePermissionInfo,
  probeSpeakerCapturePermissionInfo: nativeProbeSpeakerCapturePermissionInfo,
  requestInitialMicrophonePermissionOpen: nativeRequestInitialMicrophonePermissionOpen,
  requestMicrophonePermission: nativeRequestMicrophonePermission,
  requestInitialSystemAudioPermissionOpen: nativeRequestInitialSystemAudioPermissionOpen,
  requestSystemAudioPermission: nativeRequestSystemAudioPermission,
  requestScreenCapturePermission: nativeRequestScreenCapturePermission,
  checkAccessibilityPermissionInfo: nativeCheckAccessibilityPermissionInfo,
  requestAccessibilityPermission: nativeRequestAccessibilityPermission,
  getMicActiveApps: nativeGetMicActiveApps,
  getMeetingCandidates: nativeGetMeetingCandidates,
  getDefaultInputDevice: nativeGetDefaultInputDevice,
  getDefaultSpeakerDevice: nativeGetDefaultSpeakerDevice,
  isBuiltInSpeaker: nativeIsBuiltInSpeaker,
  init: nativeInit,
  initLogging: nativeInitLogging,
} = nativeBinding;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeVadStatus(status: Record<string, unknown>): AudioEngineVadInitStatus {
  const vad = isRecord(status.vad) ? status.vad : {};
  const enabled = Boolean(vad.enabled ?? vad.ready ?? false);
  return {
    enabled,
    active: Boolean(vad.active ?? vad.ready ?? enabled),
    ready: Boolean(vad.ready ?? vad.active ?? false),
    reused: Boolean(vad.reused ?? false),
    model: typeof vad.model === 'string' ? vad.model : 'vad',
    modelDir: typeof vad.modelDir === 'string' ? vad.modelDir : undefined,
    sampleRateHz: typeof vad.sampleRateHz === 'number' ? vad.sampleRateHz : 16000,
    warmupMs: typeof vad.warmupMs === 'number' ? vad.warmupMs : 0,
  };
}

function normalizeInitStatus(status: AudioEngineInitStatus): AudioEngineInitStatus {
  const record = status as unknown as Record<string, unknown>;
  const denoise = isRecord(record.denoise) ? record.denoise : {};
  const vad = normalizeVadStatus(record);
  const modelsPreloaded =
    typeof record.modelsPreloaded === 'boolean'
      ? record.modelsPreloaded
      : Boolean(denoise.active ?? vad.ready ?? vad.active);

  return {
    ...status,
    modelsPreloaded,
    vad,
  };
}

function normalizeModelsPreloadStatus(status: AudioEngineModelsPreloadStatus): AudioEngineModelsPreloadStatus {
  const record = status as unknown as Record<string, unknown>;
  return {
    denoise: (isRecord(record.denoise) ? record.denoise : {}) as unknown as AudioEngineDenoiseInitStatus,
    vad: normalizeVadStatus(record),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePermissionOpenResult(value: unknown): PermissionOpenResult {
  if (isRecord(value) && typeof value.opened === 'boolean') {
    const result: PermissionOpenResult = { opened: value.opened };
    if (typeof value.error === 'string') {
      result.error = value.error;
    }
    return result;
  }

  return { opened: Boolean(value) };
}

function callPermissionOpen(request: () => unknown): PermissionOpenResult {
  try {
    return normalizePermissionOpenResult(request());
  } catch (error) {
    return {
      opened: false,
      error: errorText(error),
    };
  }
}

function darwinMajorVersion(): number {
  return Number.parseInt(osRelease().split('.')[0] ?? '', 10);
}

function speakerPermissionDetails(): {
  backend: CapturePermissionBackend;
  permissionScope: CapturePermissionScope;
  trackSource: AudioTrackSource | null;
} {
  if (process.platform === 'darwin') {
    const darwinMajor = darwinMajorVersion();
    if (Number.isFinite(darwinMajor) && darwinMajor >= 23) {
      return {
        backend: 'core_audio_tap',
        permissionScope: 'system_audio',
        trackSource: 'system_audio',
      };
    }
    return {
      backend: 'screen_capture_kit',
      permissionScope: 'screen_recording',
      trackSource: 'screen_share_audio',
    };
  }
  if (process.platform === 'win32') {
    return {
      backend: 'wasapi_loopback',
      permissionScope: 'none',
      trackSource: 'system_audio',
    };
  }
  if (process.platform === 'linux') {
    return {
      backend: 'pulseaudio_monitor',
      permissionScope: 'none',
      trackSource: 'system_audio',
    };
  }
  return {
    backend: 'unsupported',
    permissionScope: 'none',
    trackSource: null,
  };
}

function permissionStatus(
  granted: boolean,
  backend: CapturePermissionBackend,
): CapturePermissionStatus {
  if (granted) {
    return 'granted';
  }
  return backend === 'unsupported' ? 'unknown' : 'denied';
}

function speakerPermissionUnknownResult(
  message: string,
  reason: string,
  api: string,
): CapturePermissionCheckResult {
  const details = speakerPermissionDetails();
  return {
    granted: false,
    request: 'speaker',
    permissionScope: details.permissionScope,
    trackSource: null,
    backend: details.backend,
    status: 'unknown',
    message,
    reason,
    captureHealth: 'not-run',
    captureReady: false,
    rawStatus: 'Unavailable',
    rawResult: {
      api,
      value: null,
    },
  };
}

function normalizePermissionResult(
  request: CapturePermissionRequest,
  value: unknown,
): CapturePermissionCheckResult {
  if (isRecord(value) && typeof value.granted === 'boolean') {
    return value as unknown as CapturePermissionCheckResult;
  }

  const granted = Boolean(value);
  if (request === 'microphone') {
    const status = permissionStatus(granted, 'cpal_microphone');
    return {
      granted,
      request,
      permissionScope: 'microphone',
      trackSource: granted ? 'microphone' : null,
      backend: 'cpal_microphone',
      status,
      message: granted
        ? 'Microphone capture permission is granted and the microphone capture stream can be opened.'
        : 'Microphone capture permission is denied or the microphone capture stream cannot be opened.',
      rawStatus: granted ? 'BooleanTrue' : 'BooleanFalse',
      rawResult: {
        api: 'legacy.boolean_permission_check',
        value: granted,
      },
    };
  }

  return speakerPermissionUnknownResult(
    'The native speaker permission API returned an invalid structured result.',
    'invalid-structured-permission-result',
    'sdk.speaker.permission_check',
  );
}

function permissionFailureResult(
  request: CapturePermissionRequest,
  error: unknown,
): CapturePermissionCheckResult {
  const message = errorText(error);
  const lower = message.toLowerCase();
  const failedStatus: CapturePermissionStatus = lower.includes('stale')
    ? 'unknown'
    : lower.includes('unsupported') || lower.includes('not supported')
      ? 'unknown'
      : lower.includes('restricted')
        ? 'restricted'
        : lower.includes('not determined') || lower.includes('not-determined')
          ? 'not-determined'
          : lower.includes('denied')
            ? 'denied'
            : 'unknown';

  if (request === 'microphone') {
    return {
      granted: false,
      request,
      permissionScope: 'microphone',
      trackSource: null,
      backend: 'cpal_microphone',
      status: failedStatus,
      message: 'Microphone capture permission check failed.',
      error: message,
      rawStatus: 'Exception',
      rawResult: {
        api: 'sdk.microphone.permission_check',
        errorMessage: message,
      },
    };
  }

  const details = speakerPermissionDetails();
  return {
    granted: false,
    request,
    permissionScope: details.permissionScope,
    trackSource: null,
    backend: details.backend,
    status: failedStatus,
    message: 'Speaker capture permission check failed.',
    error: message,
    rawStatus: 'Exception',
    rawResult: {
      api: 'sdk.speaker.permission_check',
      errorMessage: message,
    },
  };
}

function callPermissionCheck(
  request: CapturePermissionRequest,
  check: () => unknown,
): CapturePermissionCheckResult {
  try {
    return normalizePermissionResult(request, check());
  } catch (error) {
    return permissionFailureResult(request, error);
  }
}

function callNativeMicPermissionCheck(): unknown {
  if (typeof nativeCheckMicCapturePermissionInfo === 'function') {
    return nativeCheckMicCapturePermissionInfo();
  }
  if (typeof nativeCheckMicCapturePermission === 'function') {
    return nativeCheckMicCapturePermission();
  }
  throw new Error('Native microphone permission check is not available.');
}

function callNativeSpeakerPermissionCheck(): unknown {
  if (typeof nativeCheckSpeakerCapturePermissionInfo === 'function') {
    return nativeCheckSpeakerCapturePermissionInfo();
  }
  return speakerPermissionUnknownResult(
    'The native structured speaker permission check API is not available.',
    'structured-permission-api-unavailable',
    'sdk.speaker.permission_check',
  );
}

function callNativeSpeakerPermissionProbe(): unknown {
  if (typeof nativeProbeSpeakerCapturePermissionInfo === 'function') {
    return nativeProbeSpeakerCapturePermissionInfo();
  }
  return speakerPermissionUnknownResult(
    'The native structured speaker permission probe API is not available.',
    'structured-permission-api-unavailable',
    'sdk.speaker.permission_probe',
  );
}

/** Delivers support failures as structured errors within the existing return contract. */
function validateDeviceSelection(config?: AudioCaptureConfig | null): void {
  if (config?.playbackDeviceId !== undefined || config?.iosOutputRoute !== undefined) {
    throw Object.assign(new Error('Desktop playback device selection is unsupported'), {
      deviceStatus: { source: 'playback', code: 'unsupported', requestedDeviceId: config.playbackDeviceId },
    });
  }
  const selected = config?.micDeviceId !== undefined ? { source: 'microphone', id: config.micDeviceId }
    : config?.systemAudioDeviceId !== undefined ? { source: 'system_audio', id: config.systemAudioDeviceId } : undefined;
  if (!selected) return;
  if (typeof nativeListAudioDevices !== 'function') {
    throw Object.assign(new Error('Native audio device selection is unsupported'), {
      deviceStatus: { source: selected.source, code: 'unsupported', requestedDeviceId: selected.id },
    });
  }
}

/** Distinguishes a failed listing from a valid empty list. */
export async function listAudioDevices(source: AudioDeviceSource): Promise<AudioDeviceListResult> {
  if (!['microphone', 'system_audio', 'playback'].includes(source)) throw new Error('Invalid audio device source');
  if (typeof nativeListAudioDevices !== 'function') return { status: { source, code: 'unsupported' }, devices: [] };
  return nativeListAudioDevices(source);
}

const MEETING_SYNC_UNSUPPORTED = 'meeting_sync_unsupported: install a native engine with meeting app sync support';

export class AudioCapture {
  #native: any;
  // The engine releases the sync callback on stop, so it is kept here to register again before the next start.
  #meetingSyncCallback?: MeetingSyncCallback;

  constructor(config?: AudioCaptureConfig | null) {
    validateDeviceSelection(config);
    this.#native = new NativeAudioCapture(config);
  }

  #requireAuthorizationSupport(): void {
    if (typeof this.#native.createAuthorizationRequest !== 'function' ||
        typeof this.#native.applyAuthorization !== 'function' ||
        typeof this.#native.getAuthorizationStatus !== 'function' ||
        typeof this.#native.invalidateAuthorization !== 'function') {
      throw new Error('engine_authorization_unsupported: install an authorization-enabled native engine');
    }
  }

  createAuthorizationRequest(conversationId: string): EngineAuthorizationRequest {
    this.#requireAuthorizationSupport();
    return this.#native.createAuthorizationRequest(conversationId);
  }

  applyAuthorization(token: string): EngineAuthorizationStatus {
    this.#requireAuthorizationSupport();
    return this.#native.applyAuthorization(token);
  }

  getAuthorizationStatus(): EngineAuthorizationStatus {
    this.#requireAuthorizationSupport();
    return this.#native.getAuthorizationStatus();
  }

  invalidateAuthorization(): void {
    this.#requireAuthorizationSupport();
    this.#native.invalidateAuthorization();
  }

  #requireSourceMuteSupport(): void {
    if (typeof this.#native.setMicMuted !== 'function' ||
        typeof this.#native.setSpeakerMuted !== 'function') {
      throw new Error('source_mute_unsupported: install a native engine with source mute support');
    }
  }

  /** Mutes or unmutes the microphone from the next chunk. The device stays open and sound during mute is discarded. */
  setMicMuted(muted: boolean): void {
    this.#requireSourceMuteSupport();
    this.#native.setMicMuted(muted);
  }

  /** Mutes or unmutes the speaker from the next chunk. System audio capture stays open. */
  setSpeakerMuted(muted: boolean): void {
    this.#requireSourceMuteSupport();
    this.#native.setSpeakerMuted(muted);
  }

  #requireMeetingSyncSupport(): void {
    if (typeof this.#native.setMeetingSync !== 'function' ||
        typeof this.#native.getMeetingSyncState !== 'function' ||
        typeof this.#native.onMeetingSync !== 'function') {
      throw new Error(MEETING_SYNC_UNSUPPORTED);
    }
  }

  /**
   * Follows the meeting app's mute state for the microphone. Can be called any time, before start or during recording.
   * While the meeting app decides the microphone, setMicMuted is rejected with mic_sync_active.
   */
  setMeetingSync(options: MeetingSyncOptions): void {
    this.#requireMeetingSyncSupport();
    this.#native.setMeetingSync(options);
  }

  /** Current meeting app microphone sync state. Outside capture it is off or idle, reflecting only the settings. */
  getMeetingSyncState(): MeetingSyncEvent {
    this.#requireMeetingSyncSupport();
    return this.#native.getMeetingSyncState();
  }

  /** Callback invoked when the sync state changes. Once registered it survives stop() followed by start(). */
  onMeetingSync(callback: MeetingSyncCallback): void {
    this.#requireMeetingSyncSupport();
    this.#meetingSyncCallback = callback;
    this.#native.onMeetingSync(callback);
  }

  onError(callback: ErrorCallback): void {
    this.#native.onError(callback);
  }

  start(callback: AudioChunkCallback): void {
    if (this.#meetingSyncCallback) this.#native.onMeetingSync(this.#meetingSyncCallback);
    try { this.#native.start(callback); }
    catch (error) {
      const status = this.#native.getStatus().deviceStatus?.find((status: AudioDeviceStatus) =>
        status.code !== 'ready' && status.code !== 'pending');
      if (error instanceof Error && status) Object.assign(error, { deviceStatus: status });
      throw error;
    }
  }

  pause(): void {
    this.#native.pause();
  }

  resume(): void {
    this.#native.resume();
  }

  stop(): void {
    this.#native.stop();
  }

  getState(): string {
    return this.#native.getState();
  }

  getStatus(): CaptureStatus {
    return this.#native.getStatus();
  }

  getMicDevices(): string[] {
    return this.#native.getMicDevices();
  }

  isSpeakerSupported(): boolean {
    return this.#native.isSpeakerSupported();
  }

  setVadEnabled(enabled: boolean): void {
    this.#native.setVadEnabled(enabled);
  }

  setVadConfig(config: VADConfig): void {
    this.#native.setVadConfig(config);
  }

  getVadConfig(): VADConfig {
    return this.#native.getVadConfig();
  }
}

export class AudioEngine {
  #config?: AudioCaptureConfig | null;
  #status: AudioEngineInitStatus;

  private constructor(config: AudioCaptureConfig | null | undefined, status: AudioEngineInitStatus) {
    this.#config = config;
    this.#status = status;
  }

  static async init(
    config?: AudioCaptureConfig | null,
    options?: AudioEngineInitOptions | null,
  ): Promise<AudioEngine> {
    const status = init(config, options);
    return new AudioEngine(config, status);
  }

  createCapture(): AudioCapture {
    return new AudioCapture(this.#config);
  }

  getStatus(): AudioEngineInitStatus {
    return this.#status;
  }
}

export const listMicDevices: () => string[] = nativeListMicDevices;
export const listSpeakerDevices: () => string[] = () =>
  typeof nativeListSpeakerDevices === 'function' ? nativeListSpeakerDevices() : [];
export const isSpeakerCaptureSupported: () => boolean = nativeIsSpeakerCaptureSupported;
export const probeMicCapture: () => boolean = () =>
  typeof nativeProbeMicCapture === 'function'
    ? nativeProbeMicCapture()
    : checkMicCapturePermissionInfo().granted;
export const checkMicCapturePermission: () => boolean = () =>
  checkMicCapturePermissionInfo().granted;
export const checkMicCapturePermissionInfo: () => CapturePermissionCheckResult = () =>
  callPermissionCheck('microphone', callNativeMicPermissionCheck);
export const checkSpeakerCapturePermissionInfo: () => CapturePermissionCheckResult = () =>
  callPermissionCheck('speaker', callNativeSpeakerPermissionCheck);
export const probeSpeakerCapturePermissionInfo: () => CapturePermissionCheckResult = () =>
  callPermissionCheck('speaker', callNativeSpeakerPermissionProbe);
export const requestInitialMicrophonePermissionOpen: () => MicrophonePermissionOpenResult = () =>
  callPermissionOpen(nativeRequestInitialMicrophonePermissionOpen);
export const requestMicrophonePermission: () => MicrophonePermissionOpenResult = () =>
  callPermissionOpen(nativeRequestMicrophonePermission);
export const requestInitialSystemAudioPermissionOpen: () => SystemAudioPermissionOpenResult = () =>
  callPermissionOpen(nativeRequestInitialSystemAudioPermissionOpen);
export const requestSystemAudioPermission: () => SystemAudioPermissionOpenResult = () =>
  callPermissionOpen(nativeRequestSystemAudioPermission);
export const requestScreenCapturePermission: () => ScreenCapturePermissionOpenResult = () =>
  callPermissionOpen(nativeRequestScreenCapturePermission);

const ACCESSIBILITY_PERMISSION_UNSUPPORTED =
  'accessibility_permission_unsupported: install a native engine with accessibility permission support';

/** Checks the macOS Accessibility permission meeting app sync needs, without showing a prompt. Other platforms return required: false. */
export function checkAccessibilityPermissionInfo(): AccessibilityPermissionCheckResult {
  if (typeof nativeCheckAccessibilityPermissionInfo !== 'function') throw new Error(ACCESSIBILITY_PERMISSION_UNSUPPORTED);
  return nativeCheckAccessibilityPermissionInfo();
}

/**
 * Opens the macOS permission prompt and Settings if the Accessibility permission is missing. Call only from a user action.
 * The return value is the result of opening them; check the grant again with checkAccessibilityPermissionInfo.
 */
export const requestAccessibilityPermission: () => AccessibilityPermissionOpenResult = () =>
  callPermissionOpen(() => {
    if (typeof nativeRequestAccessibilityPermission !== 'function') throw new Error(ACCESSIBILITY_PERMISSION_UNSUPPORTED);
    return nativeRequestAccessibilityPermission();
  });
export const getMicActiveApps: () => Promise<MicActiveApp[]> = nativeGetMicActiveApps;
/** Returns the apps using the microphone, with appId added when one is a meeting app that can be synced. */
export async function getMeetingCandidates(): Promise<MeetingCandidate[]> {
  if (typeof nativeGetMeetingCandidates !== 'function') throw new Error(MEETING_SYNC_UNSUPPORTED);
  return nativeGetMeetingCandidates();
}
export const getDefaultInputDevice: () => string | null = nativeGetDefaultInputDevice;
export const getDefaultSpeakerDevice: () => string | null = nativeGetDefaultSpeakerDevice;
export const isBuiltInSpeaker: () => boolean = nativeIsBuiltInSpeaker;
export const init: (
  config?: AudioCaptureConfig | null,
  options?: AudioEngineInitOptions | null,
) => AudioEngineInitStatus = (config, options) => normalizeInitStatus(nativeInit(config, options));
export const preloadModels: (config?: AudioCaptureConfig | null) => AudioEngineModelsPreloadStatus = (config) => {
  const nativePreloadModels = nativeBinding.preloadModels;
  if (typeof nativePreloadModels === 'function') {
    return normalizeModelsPreloadStatus(nativePreloadModels(config));
  }
  const status = init(config, { preloadModels: true });
  return {
    denoise: status.denoise,
    vad: status.vad,
  };
};
export const initLogging: (level?: string | null) => void = nativeInitLogging;

export { attachEngineAuthorization } from '../../../bindings/typescript/authorization/realtime.js';
export type {
  AuthorizableAudioCapture, EngineAuthorizationController, EngineAuthorizationOptions,
  EngineAuthorizationRequest, EngineAuthorizationSocket, EngineAuthorizationStatus,
} from '../../../bindings/typescript/authorization/contracts.js';
