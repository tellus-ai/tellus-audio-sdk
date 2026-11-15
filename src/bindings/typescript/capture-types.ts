import type { AuthorizableAudioCapture } from './authorization/contracts.js';
import type { AudioDeviceStatus } from './audio-devices.js';
import type { AutoGainControlConfig } from './audio-gain.js';
export type { AutoGainControlConfig } from './audio-gain.js';

export interface AudioCaptureConfig {
  micEnabled?: boolean;
  speakerEnabled?: boolean;
  micDeviceId?: string;
  systemAudioDeviceId?: string;
  playbackDeviceId?: string;
  iosOutputRoute?: 'speaker' | 'system';
  enableRawAudio?: boolean;
  /** Enables denoise. The denoise model is fixed; processing runs internally at 48 kHz and only the output is converted to processing.sampleRate. */
  denoiseEnabled?: boolean;
  /**
   * Denoise output policy. Defaults to 'close_talk'. Surrounding spaces and case are ignored; unknown values are rejected at init.
   * 'close_talk' adds a near-speech gate that turns far sound into exact silence, delays output by 300 ms more (about 330 ms with model latency), and limits noise attenuation to at most 12 dB. Speech can be blocked in noisy places.
   * 'general' keeps the denoise model output with no attenuation limit. With denoiseEnabled: false the gate is off too.
   */
  denoiseMode?: 'close_talk' | 'general';
  /** close_talk gate open threshold in dB, finite 0..=60, engine default 30. Changeable at runtime with setCloseTalkThresholdDb. */
  closeTalkThresholdDb?: number;
  /** close_talk noise attenuation limit in dB (positive magnitude), finite 0..=60, engine default 12. The engine mixes the input back at 10^(-db/20). Changeable at runtime with setDenoiseAttenuationLimitDb; general mode stays unlimited. */
  denoiseAttenuationLimitDb?: number;
  /** General-mode noise attenuation limit in dB (positive magnitude), finite 0..=60, or null (default) for unlimited. The engine mixes the noisy input back at 10^(-db/20) in 'general' denoise mode. Does not affect close_talk. Changeable at runtime with setGeneralDenoiseAttenuationLimitDb. Requires engine v0.4.8+. */
  generalDenoiseAttenuationLimitDb?: number | null;
  /** close_talk hold time in ms, finite 0..=2000, engine default 250. The gate stays open round(ms / 10) more 10 ms hops after the open evidence ends (0: only hops with evidence). Changeable at runtime with setCloseTalkHoldMs. */
  closeTalkHoldMs?: number;
  /** close_talk keep gap in dB, finite 0..=20, engine default 4. An open gate stays open while the mean lsnr is at least closeTalkThresholdDb minus this gap. Changeable at runtime with setCloseTalkKeepGapDb. */
  closeTalkKeepGapDb?: number;
  /** close_talk level margin in dB, finite 0..=20, engine default 2. A 200 ms level at or above the learned level minus this margin is open evidence regardless of lsnr. Changeable at runtime with setCloseTalkLevelMarginDb. */
  closeTalkLevelMarginDb?: number;
  /** Learned close_talk speech level in dBFS applied when the gate is created, finite -100..=0, or null (default: none). Pass a value read from getStatus().closeTalkLearnedLevelDbfs to carry it into a new capture. */
  closeTalkLearnedLevelDbfs?: number | null;
  vadEnabled?: boolean;
  echoCancellationEnabled?: boolean;
  /** Per-session digital microphone gain, -60..12 dB; default 0. Never changes OS input volume. */
  micGainDb?: number;
  /** Captured system audio gain; web/mobile support only the neutral default 0. Does not control playback. */
  speakerGainDb?: number;
  autoGainControl?: AutoGainControlConfig;
  /** @deprecated Use autoGainControl. The new config takes precedence when supplied. */
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

/** Decision of the close_talk gate hops that produced a chunk's audio. Aligned with the chunk audio (the gate's 300 ms hold is accounted for). */
export interface CloseTalkGateDiagnostics {
  /** Whether the chunk's last 10 ms hop was open. */
  open: boolean;
  /** Fraction of the chunk's hops that were open (0..1). */
  openRatio: number;
  /** 200 ms mean lsnr (dB) of the last hop; null while the decision window is not full or the measurement is missing. */
  lsnrDb: number | null;
  /** 200 ms level (dBFS) of the last hop; null while the decision window is not full or the measurement is missing. */
  levelDbfs: number | null;
  /** Learned level (dBFS) the gate used when it emitted that hop; null if none. */
  learnedLevelDbfs: number | null;
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
    reason: 'consumer_lag' | 'native_overrun' | 'device_gap' | 'authorization_lost' | 'processing_error' | 'input_held';
    droppedChunks: number;
    droppedSamples: number;
    fromSample: number;
    toSample: number;
  };
  /** close_talk gate decision for this chunk's microphone audio; null when the gate did not process it (general mode, denoise off, stale bypass). Absent on engines without close-talk diagnostics support. */
  closeTalkGate?: CloseTalkGateDiagnostics | null;
}

export interface CaptureStatus {
  state: 'idle' | 'running' | 'paused' | 'stopped';
  /** Whether denoise is actually on. False if the denoise model failed to load. */
  denoiseEnabled: boolean;
  /** Applied denoiseMode. */
  denoiseMode: 'close_talk' | 'general';
  /** The denoise model failed to load, so input passes through without denoise or the gate. */
  denoiseLoadFailed: boolean;
  /** Applied close_talk gate open threshold (dB). Absent on engines without close-talk threshold support. */
  closeTalkThresholdDb?: number;
  /** Applied close_talk noise attenuation limit (dB). Absent on engines without denoise attenuation limit support. */
  denoiseAttenuationLimitDb?: number;
  /** Applied general-mode attenuation limit (dB), null when unlimited. Absent on engines without general-mode attenuation limit support. */
  generalDenoiseAttenuationLimitDb?: number | null;
  /** Stored close_talk hold time (ms), reported in every denoiseMode. Absent on engines without close-talk tuning support. */
  closeTalkHoldMs?: number;
  /** Stored close_talk keep gap (dB), reported in every denoiseMode. Absent on engines without close-talk tuning support. */
  closeTalkKeepGapDb?: number;
  /** Stored close_talk level margin (dB), reported in every denoiseMode. Absent on engines without close-talk tuning support. */
  closeTalkLevelMarginDb?: number;
  /** Learned level (dBFS) the close_talk gate currently uses, from its own learning or injection; null if none. Keeps the last value while not running. Absent on engines without close-talk tuning support. */
  closeTalkLearnedLevelDbfs?: number | null;
  /** True only when closeTalkLearnedLevelDbfs comes from the gate's own learning (at least 30 levels), not from injection. Absent on engines without close-talk tuning support. */
  closeTalkLevelLearned?: boolean;
  /** Whether input is held (see holdInput). Absent on engines without input hold support. */
  inputHeld?: boolean;
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
  setMicGainDb(db: number): Promise<void>;
  /** Updates the close_talk gate open threshold from the next 10 ms hop. Rejects with a platform unsupported error on engines without the API. */
  setCloseTalkThresholdDb(db: number): Promise<void>;
  /** Updates the close_talk noise attenuation limit from the next 10 ms hop. Rejects with a platform unsupported error on engines without the API. */
  setDenoiseAttenuationLimitDb(db: number): Promise<void>;
  /** Updates the general-mode noise attenuation limit (dB, finite 0..=60) from the next 10 ms hop; null restores unlimited. Does not affect close_talk. Rejects with a platform unsupported error on engines without the API. */
  setGeneralDenoiseAttenuationLimitDb(db: number | null): Promise<void>;
  /** Updates the close_talk hold time (ms, finite 0..=2000) from the next 10 ms hop, keeping held audio and learning. Rejects with a platform unsupported error on engines without the API. */
  setCloseTalkHoldMs(ms: number): Promise<void>;
  /** Updates the close_talk keep gap (dB, finite 0..=20) from the next 10 ms hop, keeping held audio and learning. Rejects with a platform unsupported error on engines without the API. */
  setCloseTalkKeepGapDb(db: number): Promise<void>;
  /** Updates the close_talk level margin (dB, finite 0..=20) from the next 10 ms hop, keeping held audio and learning. Rejects with a platform unsupported error on engines without the API. */
  setCloseTalkLevelMarginDb(db: number): Promise<void>;
  /**
   * Clears the close_talk learning history and sets the learned level to dbfs (finite -100..=0); the gate's own learning replaces it after 30 new levels. null clears the learned level too.
   * Learning survives denoise on/off, mode switches, pause/resume, stop/start, and mic restarts, so apps that switch input device reset it with null. Rejects with a platform unsupported error on engines without the API.
   */
  setCloseTalkLearnedLevelDbfs(dbfs: number | null): Promise<void>;
  /** Captured system audio gain. Rejects on web/mobile where system capture is unsupported. */
  setSpeakerGainDb(db: number): Promise<void>;
  /** Discards processing history and undelivered output while keeping authorization and capture. */
  reset(): Promise<void>;
  /**
   * Holds input while the app's uplink is stopped, e.g. during TTS playback. Freezes adaptive state
   * (DFN3 noise estimate, close_talk learned level, AGC) and stops output. Idempotent; callable before start.
   * The state persists across pause/resume and stop/start. Rejects with a platform unsupported error on engines without the API.
   * Hold and release are applied in call order and are never cancelled by a later start/resume/pause/reset/stop, even unawaited in the same tick;
   * only dispose() (`capture_disposed` on mobile, `tellus_capture_disposed` on web; the desktop wrapper has no dispose rejection) and old engines (`tellus_input_hold_unsupported`) reject.
   */
  holdInput(): Promise<void>;
  /**
   * Ends a hold. Discards audio held inside the engine (including the denoise model's audio history; the noise estimate, close_talk learned values and AGC are kept) and silently resets the VAD gate (no event; the next speech opens it).
   * After an actual hold, the next chunk carries an `input_held` discontinuity (a release while not held is a no-op). Idempotent; callable before start.
   * No audio from before or during the hold is output after release, except while the AEC is actively processing (a render reference is flowing: engine playback on mobile/web,
   * speaker capture with a non-head-worn output on desktop): then the first 25 ms of echo-cancelled audio is silenced and a decaying residue below 1e-3 peak (about -60 dBFS) can follow, exactly 0 within 250 ms.
   * When engine playback ends the AEC is recreated, so in the usual flow (TTS through engine playback, then release) the boundary is exactly 0. An app playing TTS through its own player never activates the AEC on mobile/web.
   * Rejects with a platform unsupported error on engines without the API.
   */
  releaseInput(): Promise<void>;
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
