import { release as osRelease } from 'node:os';
import type { AudioDeviceSource, AudioDeviceStatus, AudioDeviceListResult } from '../../../bindings/typescript/audio-devices.js';
export type { AudioDeviceSource, AudioDeviceInfo, AudioDeviceStatus, AudioDeviceListResult, AudioDeviceOperationError } from '../../../bindings/typescript/audio-devices.js';

import { prepareEngineRuntime } from './runtime/engine-runtime.js';
import type { EngineAuthorizationRequest, EngineAuthorizationStatus } from '../../../bindings/typescript/authorization/contracts.js';

export interface AudioProcessingConfig {
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
  /** 생략하면 OS 기본 입력을 따른다. */
  micDeviceId?: string;
  /** 시스템 오디오를 캡처할 출력 ID. */
  systemAudioDeviceId?: string;
  /** 데스크톱 엔진 재생 경로는 지원하지 않는다. */
  playbackDeviceId?: string;
  /** iOS 전용 설정. 데스크톱에서는 unsupported. */
  iosOutputRoute?: 'speaker' | 'system';
  /** Enables microphone capture. Native default is true. */
  micEnabled?: boolean;
  /** Enables speaker/system-audio capture. Native default is false. */
  speakerEnabled?: boolean;
  /** Includes synchronized PCM16 raw frames in chunk.rawAudio. */
  enableRawAudio?: boolean;
  /** Enables FastEnhancer denoise. Native default is true. */
  denoiseEnabled?: boolean;
  /** Enables the native Silero VAD gate. Native default is false. */
  vadEnabled?: boolean;
  /** Processing/mixer settings. */
  processing?: AudioProcessingConfig;
  /** Final transport payload settings. Native default is { codec: "opus" }. */
  transport?: AudioTransportConfig;
}

export interface VADConfig {
  /** Speech start threshold for Silero probability. */
  vadPositiveThreshold?: number;
  /** Speech end threshold for Silero probability. */
  vadNegativeThreshold?: number;
  /** Compatibility value. Silero-only VAD does not use RMS for speech decisions. */
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
  vadMode: 'silero' | 'disabled';
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

/** Zoom 데스크톱 앱, 또는 브라우저 안의 Google Meet. */
export type MeetingAppId = 'zoom' | 'google_meet';
export type MeetingSyncMode = 'off' | 'auto' | 'manual';
export type MeetingSyncStateName = 'off' | 'idle' | 'needs_link' | 'synced' | 'lost';
export type MeetingSyncReason =
  | 'accessibility_permission'
  | 'control_not_found'
  | 'unknown_label'
  | 'app_not_running'
  | 'read_failed'
  /** 회의 화면이 보이지 않아 값을 믿을 수 없음(최소화된 창, 뒤쪽 탭, 가려진 Safari 창 등). */
  | 'meeting_hidden';
export type MeetingAudioState = 'unmuted' | 'muted' | 'telephone' | 'not_joined';

/** 마이크를 사용 중인 앱과, 동기화할 수 있는 회의 앱이면 그 앱 ID. */
export interface MeetingCandidate extends MicActiveApp {
  appId?: MeetingAppId;
}

/** 엔진 기본 문구 표에 더할 회의 앱 음소거 항목 제목. 목록 이름은 그 제목이 보일 때의 회의 앱 상태다. */
export interface MeetingAudioLabels {
  unmuted?: string[];
  muted?: string[];
  telephone?: string[];
  notJoined?: string[];
}

export interface MeetingSyncOptions {
  mode: MeetingSyncMode;
  /** mode가 manual일 때 필수 */
  targetAppId?: MeetingAppId;
  /** 100~2000, 기본 250 */
  pollIntervalMs?: number;
  /** 0~60000, 기본 5000 */
  unknownGraceMs?: number;
  labels?: MeetingAudioLabels;
}

export interface MeetingSyncEvent {
  state: MeetingSyncStateName;
  mode: MeetingSyncMode;
  appId?: MeetingAppId;
  reason?: MeetingSyncReason;
  meetingAudio?: MeetingAudioState;
  /** 마지막으로 읽은 음소거 항목 제목(진단용) */
  controlTitle?: string;
  /** 실제 적용된 마이크 음소거 */
  micMuted: boolean;
  /** 회의 앱이 마이크를 정하는 중(synced·lost)이면 true. 이때 setMicMuted는 mic_sync_active로 throw */
  micControlled: boolean;
  observedAtMs: number;
}

export type MeetingSyncCallback = (err: Error | null, event: MeetingSyncEvent) => unknown;

export interface AudioEngineDenoiseInitStatus {
  enabled: boolean;
  active: boolean;
  reused: boolean;
  model: string;
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

/** 회의 앱 화면을 읽는 데 필요한 손쉬운 사용 권한 확인 결과. */
export interface AccessibilityPermissionCheckResult {
  /** 회의 앱 화면을 읽을 수 있으면 true. 권한이 필요 없는 플랫폼도 true다. */
  granted: boolean;
  /** 이 플랫폼에서 손쉬운 사용 권한이 필요한지 여부(macOS만 true). */
  required: boolean;
  /** macOS는 허용 전과 거부를 구분할 수 없어 둘 다 denied다. */
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
    model: typeof vad.model === 'string' ? vad.model : 'silero_vad_v6.2',
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

/** 기존 반환 계약에서 지원 실패를 구조화해 전달한다. */
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

/** 조회 실패 상태와 정상적인 빈 목록을 구분한다. */
export async function listAudioDevices(source: AudioDeviceSource): Promise<AudioDeviceListResult> {
  if (!['microphone', 'system_audio', 'playback'].includes(source)) throw new Error('Invalid audio device source');
  if (typeof nativeListAudioDevices !== 'function') return { status: { source, code: 'unsupported' }, devices: [] };
  return nativeListAudioDevices(source);
}

const MEETING_SYNC_UNSUPPORTED = 'meeting_sync_unsupported: install a native engine with meeting app sync support';

export class AudioCapture {
  #native: any;
  // 엔진은 stop에서 동기화 콜백을 해제하므로 다음 start 전에 다시 등록하려고 보관한다.
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

  /** 다음 청크부터 마이크 소리를 무음으로 바꾸거나 되돌린다. 장치는 열어 두고 음소거 중 소리는 버린다. */
  setMicMuted(muted: boolean): void {
    this.#requireSourceMuteSupport();
    this.#native.setMicMuted(muted);
  }

  /** 다음 청크부터 스피커 소리를 무음으로 바꾸거나 되돌린다. 시스템 오디오 캡처는 열어 둔다. */
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
   * 회의 앱 음소거 상태를 따라 마이크를 맞춘다. 시작 전·녹음 중 언제든 부를 수 있다.
   * 회의 앱이 마이크를 정하는 동안 setMicMuted는 mic_sync_active로 거부된다.
   */
  setMeetingSync(options: MeetingSyncOptions): void {
    this.#requireMeetingSyncSupport();
    this.#native.setMeetingSync(options);
  }

  /** 지금 회의 앱 마이크 동기화 상태. 캡처 중이 아니면 설정만 반영한 off 또는 idle이다. */
  getMeetingSyncState(): MeetingSyncEvent {
    this.#requireMeetingSyncSupport();
    return this.#native.getMeetingSyncState();
  }

  /** 동기화 상태가 바뀔 때 부를 콜백. 한 번 등록하면 stop() 뒤 다시 start()해도 유지된다. */
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

/** 회의 앱 동기화에 필요한 macOS 손쉬운 사용 권한을 권한 창 없이 확인한다. 다른 플랫폼은 required: false다. */
export function checkAccessibilityPermissionInfo(): AccessibilityPermissionCheckResult {
  if (typeof nativeCheckAccessibilityPermissionInfo !== 'function') throw new Error(ACCESSIBILITY_PERMISSION_UNSUPPORTED);
  return nativeCheckAccessibilityPermissionInfo();
}

/**
 * 손쉬운 사용 권한이 없으면 macOS 권한 창과 설정창을 연다. 사용자 동작에서만 부른다.
 * 반환값은 창을 연 동작의 결과이며, 허용 여부는 checkAccessibilityPermissionInfo로 다시 확인한다.
 */
export const requestAccessibilityPermission: () => AccessibilityPermissionOpenResult = () =>
  callPermissionOpen(() => {
    if (typeof nativeRequestAccessibilityPermission !== 'function') throw new Error(ACCESSIBILITY_PERMISSION_UNSUPPORTED);
    return nativeRequestAccessibilityPermission();
  });
export const getMicActiveApps: () => Promise<MicActiveApp[]> = nativeGetMicActiveApps;
/** 마이크를 사용 중인 앱에, 동기화할 수 있는 회의 앱이면 appId를 붙여 돌려준다. */
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
