import type { AuthorizableAudioCapture } from './authorization/contracts.js';
import type { AudioDeviceStatus } from './audio-devices.js';

export interface AudioCaptureConfig {
  micEnabled?: boolean;
  speakerEnabled?: boolean;
  micDeviceId?: string;
  systemAudioDeviceId?: string;
  playbackDeviceId?: string;
  iosOutputRoute?: 'speaker' | 'system';
  enableRawAudio?: boolean;
  /** Enables denoise. The model is fixed to DeepFilterNet3 (encrypted model dfn3-48); processing runs internally at 48 kHz and only the output is converted to processing.sampleRate. */
  denoiseEnabled?: boolean;
  /**
   * Denoise output policy. Defaults to 'close_talk'. Surrounding spaces and case are ignored; unknown values are rejected at init.
   * 'close_talk' adds a near-speech gate that turns far sound into exact silence, delays output by 300 ms more (about 330 ms with model latency), and limits noise attenuation to at most 12 dB. Speech can be blocked in noisy places.
   * 'general' keeps the DeepFilterNet3 output with no attenuation limit. With denoiseEnabled: false the gate is off too.
   */
  denoiseMode?: 'close_talk' | 'general';
  vadEnabled?: boolean;
  echoCancellationEnabled?: boolean;
  micAgc2Enabled?: boolean;
  /**
   * sampleRate is the engine output rate: chunks, payloads, and sample clocks the caller receives use it. Defaults to 16000.
   * This is not the device capture rate: processing always runs at 48 kHz internally and any device rate is resampled.
   * Must be within 8000..=192000 Hz and give a whole number of samples per 20 ms (a multiple of 50). Opus supports only 8000, 12000, 16000, 24000, or 48000 Hz; use pcm_s16le or pcm_f32le for other rates.
   * chunkDurationMs supports only 20.
   */
  processing?: { sampleRate?: number; chunkDurationMs?: number };
  transport?: { codec?: 'opus' | 'pcm_s16le' | 'pcm_f32le'; bitrateBps?: number };
  vad?: VADConfig;
}

export interface VADConfig {
  vadPositiveThreshold?: number;
  vadNegativeThreshold?: number;
  vadSilenceDurationMs?: number;
  vadPreSpeechBufferMs?: number;
}

export interface AudioChunk {
  data: { microphone?: Uint8Array };
  trackSource: 'microphone';
  codec: 'opus' | 'pcm_s16le' | 'pcm_f32le';
  sampleRate: number;
  sampleCount: number;
  /** Number of valid samples at shutdown, excluding padding. */
  validSampleCount: number;
  durationMs: number;
  sample: number;
  timestamp: number;
  rms: number;
  gateEvent?: string;
  vadRms?: number;
  sequence?: number;
  discontinuity?: {
    reason: 'consumer_lag' | 'native_overrun' | 'device_gap' | 'authorization_lost' | 'processing_error';
    droppedChunks: number;
    droppedSamples: number;
    fromSample: number;
    toSample: number;
  };
}

export interface CaptureStatus {
  state: 'idle' | 'running' | 'paused' | 'stopped';
  /** Whether denoise is actually on. False if dfn3-48 failed to load. */
  denoiseEnabled: boolean;
  /** Applied denoiseMode. */
  denoiseMode: 'close_talk' | 'general';
  /** dfn3-48 failed to load, so input passes through without denoise or the gate. */
  denoiseLoadFailed: boolean;
  vadEnabled: boolean;
  modelsLoaded: string[];
  deviceStatus?: AudioDeviceStatus[];
}

export type AudioCaptureCallback = (error: Error | null, chunk?: AudioChunk) => void;

export interface RecordingNotificationConfig {
  title: string;
  contentText: string;
  onPause?: () => void;
  onResume?: () => void;
}

export interface AudioCapture extends AuthorizableAudioCapture {
  start(callback: AudioCaptureCallback): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  getStatus(): Promise<CaptureStatus>;
  setDenoiseEnabled(enabled: boolean): Promise<void>;
  /** Discards processing history and undelivered output while keeping authorization and capture. */
  reset(): Promise<void>;
  /** Waits for playback to finish and passes the same samples to the engine as the AEC reference. */
  playback(samples: Float32Array, nativeRate: number): Promise<void>;
  /** Reads MP3/WAV with the OS decoder and passes it to the same playback and AEC path. */
  playbackEncoded(data: ArrayBuffer): Promise<void>;
  cancelPlayback(): Promise<void>;
  /** Sets the Android recording notification. The app session controls pause and resume. */
  setRecordingNotification?(config: RecordingNotificationConfig): Promise<void>;
}

export interface BrowserEngineAssets {
  engineModuleUrl: string;
  wasmUrl: string;
  ortModuleUrl?: string;
  ortWasmBaseUrl: string;
  encryptedModels: string[];
}

export interface NativeEngineAssets {
  /** File paths of the encrypted containers the SDK downloaded and copied. */
  encryptedModels: string[];
}
