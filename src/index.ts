import { release as osRelease } from 'node:os';

import { prepareEngineRuntime } from './runtime/engine-runtime';

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
  /** Optional microphone device name. */
  micDeviceName?: string;
  /** Microphone level policy. */
  microphoneLevelMode?: 'agc2' | 'microphone_level_max' | 'none';
  /** SDK-internal microphone output gain in dB. Does not change the OS input volume. */
  micOutputGainDb?: number;
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
  /** Speaker PCM16 frame at the original speaker device sample rate, or null when inactive. */
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
}

export interface CaptureStatus {
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
  /** Current denoise attenuation limit in dB. */
  denoiseAttenuationDb: number;
  /** Current SDK-internal microphone output gain in dB. */
  micOutputGainDb: number;
  vadPositiveThreshold: number;
  vadNegativeThreshold: number;
  vadRmsThreshold: number;
  vadSilenceDurationMs: number;
  vadPreSpeechBufferMs: number;
}

export interface CaptureError {
  source: string;
  message: string;
  recoverable: boolean;
}

export interface MicActiveApp {
  processId: number;
  appName: string;
  bundleId?: string;
}

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
export type CapturePermissionStatus = 'granted' | 'denied' | 'unsupported' | 'stale' | 'unknown';

export interface CapturePermissionCheckResult {
  granted: boolean;
  request: CapturePermissionRequest;
  permissionScope: CapturePermissionScope;
  trackSource?: AudioTrackSource | null;
  backend: CapturePermissionBackend;
  status: CapturePermissionStatus;
  message: string;
  error?: string;
}

export type ErrorCallback = (err: Error | null, arg: CaptureError) => unknown;
export type AudioChunkCallback = (err: Error | null, arg: AudioChunk) => unknown;

const { nativeBinding } = prepareEngineRuntime();

const {
  AudioCapture: NativeAudioCapture,
  listMicDevices: nativeListMicDevices,
  isSpeakerCaptureSupported: nativeIsSpeakerCaptureSupported,
  probeMicCapture: nativeProbeMicCapture,
  checkMicCapturePermission: nativeCheckMicCapturePermission,
  checkMicCapturePermissionInfo: nativeCheckMicCapturePermissionInfo,
  probeSpeakerCapture: nativeProbeSpeakerCapture,
  checkSpeakerCapturePermission: nativeCheckSpeakerCapturePermission,
  checkSpeakerCapturePermissionInfo: nativeCheckSpeakerCapturePermissionInfo,
  requestSystemAudioCapturePermission: nativeRequestSystemAudioCapturePermission,
  getMicActiveApps: nativeGetMicActiveApps,
  getDefaultInputDevice: nativeGetDefaultInputDevice,
  getDefaultOutputDevice: nativeGetDefaultOutputDevice,
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function permissionStatus(granted: boolean, backend: CapturePermissionBackend): CapturePermissionStatus {
  if (granted) {
    return 'granted';
  }
  return backend === 'unsupported' ? 'unsupported' : 'denied';
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
    };
  }

  const details = speakerPermissionDetails();
  const status = permissionStatus(granted, details.backend);
  return {
    granted,
    request,
    permissionScope: details.permissionScope,
    trackSource: granted ? details.trackSource : null,
    backend: details.backend,
    status,
    message: granted
      ? `Speaker capture permission is granted and the ${details.trackSource ?? 'speaker'} capture stream can be opened.`
      : 'Speaker capture permission is denied, unsupported, or the speaker capture stream cannot be opened.',
  };
}

function permissionFailureResult(
  request: CapturePermissionRequest,
  error: unknown,
): CapturePermissionCheckResult {
  const message = errorText(error);
  const lower = message.toLowerCase();
  const failedStatus: CapturePermissionStatus = lower.includes('stale')
    ? 'stale'
    : lower.includes('unsupported') || lower.includes('not supported')
      ? 'unsupported'
      : lower.includes('denied') || lower.includes('permission')
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
  if (typeof nativeCheckSpeakerCapturePermission === 'function') {
    return nativeCheckSpeakerCapturePermission();
  }
  throw new Error('Native speaker permission check is not available.');
}

export class AudioCapture {
  #native: any;

  constructor(config?: AudioCaptureConfig | null) {
    this.#native = new NativeAudioCapture(config);
  }

  onError(callback: ErrorCallback): void {
    this.#native.onError(callback);
  }

  start(callback: AudioChunkCallback): void {
    this.#native.start(callback);
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

  setDenoiseAttenuation(db: number): void {
    this.#native.setDenoiseAttenuation(db);
  }

  getDenoiseAttenuation(): number {
    return this.#native.getDenoiseAttenuation();
  }

  setMicDenoiseAttenuation(db: number): void {
    this.#native.setMicDenoiseAttenuation(db);
  }

  getMicDenoiseAttenuation(): number {
    return this.#native.getMicDenoiseAttenuation();
  }

  setSpeakerDenoiseAttenuation(db: number): void {
    this.#native.setSpeakerDenoiseAttenuation(db);
  }

  getSpeakerDenoiseAttenuation(): number {
    return this.#native.getSpeakerDenoiseAttenuation();
  }

  setMicOutputGainDb(db: number): void {
    this.#native.setMicOutputGainDb(db);
  }

  getMicOutputGainDb(): number {
    return this.#native.getMicOutputGainDb();
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
export const isSpeakerCaptureSupported: () => boolean = nativeIsSpeakerCaptureSupported;
export const probeMicCapture: () => boolean = () =>
  typeof nativeProbeMicCapture === 'function' ? nativeProbeMicCapture() : checkMicCapturePermissionInfo().granted;
export const checkMicCapturePermission: () => boolean = () => checkMicCapturePermissionInfo().granted;
export const checkMicCapturePermissionInfo: () => CapturePermissionCheckResult = () =>
  callPermissionCheck('microphone', callNativeMicPermissionCheck);
export const probeSpeakerCapture: () => boolean = () =>
  typeof nativeProbeSpeakerCapture === 'function'
    ? nativeProbeSpeakerCapture()
    : checkSpeakerCapturePermissionInfo().granted;
export const checkSpeakerCapturePermission: () => boolean = () => checkSpeakerCapturePermissionInfo().granted;
export const checkSpeakerCapturePermissionInfo: () => CapturePermissionCheckResult = () =>
  callPermissionCheck('speaker', callNativeSpeakerPermissionCheck);
/** @deprecated Use checkSpeakerCapturePermission(). */
export const checkSystemAudioCapturePermission: () => boolean = checkSpeakerCapturePermission;
/** @deprecated Use checkSpeakerCapturePermissionInfo(). */
export const checkSystemAudioCapturePermissionInfo: () => CapturePermissionCheckResult =
  checkSpeakerCapturePermissionInfo;
export const requestSystemAudioCapturePermission: () => boolean =
  nativeRequestSystemAudioCapturePermission;
export const getMicActiveApps: () => Promise<MicActiveApp[]> = nativeGetMicActiveApps;
export const getDefaultInputDevice: () => string | null = nativeGetDefaultInputDevice;
export const getDefaultOutputDevice: () => string | null = nativeGetDefaultOutputDevice;
export const isBuiltInSpeaker: () => boolean = nativeIsBuiltInSpeaker;
export const init: (
  config?: AudioCaptureConfig | null,
  options?: AudioEngineInitOptions | null,
) => AudioEngineInitStatus = (config, options) => normalizeInitStatus(nativeInit(config, options));
export const preloadModels: (config?: AudioCaptureConfig | null) => AudioEngineInitStatus = (config) => {
  const nativePreloadModels = nativeBinding.preloadModels;
  if (typeof nativePreloadModels === 'function') {
    return normalizeInitStatus(nativePreloadModels(config));
  }
  return init(config, { preloadModels: true });
};
export const initLogging: (level?: string | null) => void = nativeInitLogging;
