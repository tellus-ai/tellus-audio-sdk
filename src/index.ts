import { prepareEngineRuntime } from './runtime/engine-runtime';

export interface AudioProcessingConfig {
  sampleRate?: number;
  chunkDurationMs?: number;
}

export type AudioTransportConfig =
  | {
      codec: 'opus';
      bitrateBps?: number;
    }
  | {
      codec: 'pcm_s16le';
    }
  | {
      codec: 'pcm_f32le';
    };

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
  mic: RawAudioFrame | null;
  /** Speaker PCM16 frame at the original speaker device sample rate, or null when inactive. */
  speaker: RawAudioFrame | null;
  /** Mixed PCM16 frame at the configured processing sample rate, or null unless both sources are enabled. */
  mixed: RawAudioFrame | null;
}

export interface AudioChunk {
  /** Final transport payload: Opus by default, PCM16LE for pcm_s16le, or Float32LE for pcm_f32le. */
  data: Buffer;
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
  denoiseAttenuationDb: number;
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

export type ErrorCallback = (err: Error | null, arg: CaptureError) => unknown;
export type AudioChunkCallback = (err: Error | null, arg: AudioChunk) => unknown;

const { nativeBinding } = prepareEngineRuntime();

const {
  AudioCapture: NativeAudioCapture,
  listMicDevices: nativeListMicDevices,
  isSpeakerCaptureSupported: nativeIsSpeakerCaptureSupported,
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

export const listMicDevices: () => string[] = nativeListMicDevices;
export const isSpeakerCaptureSupported: () => boolean = nativeIsSpeakerCaptureSupported;
