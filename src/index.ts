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
  /** Enables the native Silero VAD gate. Native default is true. */
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
  sampleRate: number;
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
  processingSampleRate: number;
  chunkDurationMs: number;
  denoise: AudioEngineDenoiseInitStatus;
  dsp: AudioEngineDspInitStatus;
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
  probeSpeakerCapture: nativeProbeSpeakerCapture,
  checkSpeakerCapturePermission: nativeCheckSpeakerCapturePermission,
  checkSystemAudioCapturePermission: nativeCheckSystemAudioCapturePermission,
  requestSystemAudioCapturePermission: nativeRequestSystemAudioCapturePermission,
  getMicActiveApps: nativeGetMicActiveApps,
  getDefaultInputDevice: nativeGetDefaultInputDevice,
  getDefaultOutputDevice: nativeGetDefaultOutputDevice,
  isBuiltInSpeaker: nativeIsBuiltInSpeaker,
  init: nativeInit,
  initLogging: nativeInitLogging,
} = nativeBinding;

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

export const listMicDevices: () => string[] = nativeListMicDevices;
export const isSpeakerCaptureSupported: () => boolean = nativeIsSpeakerCaptureSupported;
export const probeMicCapture: () => boolean = nativeProbeMicCapture;
export const checkMicCapturePermission: () => boolean = nativeCheckMicCapturePermission;
export const probeSpeakerCapture: () => boolean = nativeProbeSpeakerCapture;
export const checkSpeakerCapturePermission: () => boolean = nativeCheckSpeakerCapturePermission;
export const checkSystemAudioCapturePermission: () => boolean =
  nativeCheckSystemAudioCapturePermission;
export const requestSystemAudioCapturePermission: () => boolean =
  nativeRequestSystemAudioCapturePermission;
export const getMicActiveApps: () => Promise<MicActiveApp[]> = nativeGetMicActiveApps;
export const getDefaultInputDevice: () => string | null = nativeGetDefaultInputDevice;
export const getDefaultOutputDevice: () => string | null = nativeGetDefaultOutputDevice;
export const isBuiltInSpeaker: () => boolean = nativeIsBuiltInSpeaker;
export const init: (config?: AudioCaptureConfig | null) => AudioEngineInitStatus = nativeInit;
export const initLogging: (level?: string | null) => void = nativeInitLogging;
