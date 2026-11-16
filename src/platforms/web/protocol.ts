import type { AudioChunk, AudioCaptureConfig, BrowserEngineAssets } from '../../bindings/typescript/capture-types.js';

export interface DeliveredChunk {
  chunk: AudioChunk;
  epoch: string;
  authorizationGeneration: string;
}

export interface NativeStatus {
  lifecycle: 'running' | 'paused' | 'stopped';
  denoise_enabled: boolean;
  denoise_loaded: boolean;
  denoise_load_failed: boolean;
  denoise_mode: NonNullable<AudioCaptureConfig['denoiseMode']>;
  /** Absent on engines without close-talk threshold support. null only before configure, and worker sessions are configured when they are created. */
  close_talk_threshold_db?: number | null;
  /** Absent on engines without denoise attenuation limit support. null only before configure, and worker sessions are configured when they are created. */
  denoise_attenuation_limit_db?: number | null;
  /** Absent on engines without general-mode attenuation limit support. null means unlimited. */
  general_denoise_attenuation_limit_db?: number | null;
  /** Absent on engines without close-talk tuning support. null only before configure. */
  close_talk_hold_ms?: number | null;
  close_talk_keep_gap_db?: number | null;
  close_talk_level_margin_db?: number | null;
  close_talk_level_min_dbfs?: number | null;
  close_talk_learned_level_dbfs?: number | null;
  close_talk_level_learned?: boolean | null;
  /** Absent on engines without input hold support. null before configure. */
  input_held?: boolean | null;
  vad_loaded: boolean;
  /** Session-lifetime input normalization counts. Absent on engines older than v0.4.9. */
  input_clipped_samples?: number;
  input_non_finite_samples?: number;
  input_timestamp_regressions?: number;
}

/** Native status plus the IDs of the loaded models, read from the encrypted container headers. */
export interface WorkerStatus extends NativeStatus {
  loadedModels: string[];
  /** Last failure explanation the worker read with copy_last_error; null when none or on old engines. */
  last_error_message: string | null;
}

export type WorkerCommand =
  | { operation: 'init'; assets: BrowserEngineAssets }
  | { operation: 'create'; config: AudioCaptureConfig }
  | { operation: 'capture'; samples: Float32Array; rate: number; timestamp: number; droppedSamples: number }
  | { operation: 'render'; samples: Float32Array; rate: number }
  | { operation: 'authorizationRequest'; conversationId: string }
  | { operation: 'applyAuthorization'; token: string }
  | { operation: 'modelKeys'; keys: { modelId: string; keyId: string; wrappedKey: string }[] }
  | { operation: 'canDeliver'; nativeEpoch: string; authorizationGeneration: string }
  | { operation: 'denoise'; enabled: boolean }
  | { operation: 'micGainDb'; db: number }
  | { operation: 'closeTalkThresholdDb'; db: number }
  | { operation: 'closeTalkHoldMs'; ms: number }
  | { operation: 'closeTalkKeepGapDb'; db: number }
  | { operation: 'closeTalkLevelMarginDb'; db: number }
  | { operation: 'closeTalkLevelMinDbfs'; dbfs: number }
  | { operation: 'closeTalkLearnedLevelDbfs'; dbfs: number | null }
  | { operation: 'denoiseAttenuationLimitDb'; db: number }
  | { operation: 'generalDenoiseAttenuationLimitDb'; db: number | null }
  | { operation: 'holdInput' | 'releaseInput' }
  | { operation: 'start' | 'pause' | 'resume' | 'stop' | 'reset' | 'destroy' | 'invalidate' | 'status' | 'authorizationStatus' | 'modelRequests' | 'clearRender' };

export interface WorkerRequest {
  id: number;
  sessionId: number;
  epoch: number;
  command: WorkerCommand;
}

export interface WorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
}

/** Output rates core encodes with Opus. */
const OPUS_SAMPLE_RATES = [8000, 12000, 16000, 24000, 48000];

/**
 * Validates the public output rate with the same rules as the core transport settings and returns it. Defaults to 16000.
 * Must be within 8000..=192000 Hz with a fixed 20 ms chunk of whole samples (a multiple of 50), and chunkDurationMs accepts only 20. Otherwise throws tellus_processing_config_invalid.
 * Opus (the default when codec is omitted; surrounding spaces and case ignored) accepts only 8000, 12000, 16000, 24000, and 48000 Hz; other rates throw tellus_opus_sample_rate_unsupported.
 */
export function outputSampleRate(config: AudioCaptureConfig): number {
  const rate = config.processing?.sampleRate ?? 16000;
  const chunkDurationMs = config.processing?.chunkDurationMs;
  if (!Number.isInteger(rate) || rate < 8000 || rate > 192000 || rate % 50 !== 0 || (chunkDurationMs !== undefined && chunkDurationMs !== 20)) {
    throw new Error('tellus_processing_config_invalid');
  }
  const codec: unknown = config.transport?.codec ?? 'opus';
  if (typeof codec === 'string' && codec.trim().toLowerCase() === 'opus' && !OPUS_SAMPLE_RATES.includes(rate)) {
    throw new Error('tellus_opus_sample_rate_unsupported');
  }
  return rate;
}

/** Validates the close_talk gate open threshold with the same rule as core (finite 0..=60 dB) and returns it. Otherwise throws tellus_close_talk_threshold_db_invalid. */
export function validateCloseTalkThresholdDb(db: number): number {
  if (!Number.isFinite(db) || db < 0 || db > 60) throw new Error('tellus_close_talk_threshold_db_invalid');
  return db;
}

/** Validates the close_talk gate hold time with the same rule as core (finite 0..=2000 ms) and returns it. */
export function validateCloseTalkHoldMs(ms: number): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > 2000) throw new Error('invalid_close_talk_hold_ms: expected a finite value within 0..=2000');
  return ms;
}

/** Validates the close_talk keep gap with the same rule as core (finite 0..=20 dB) and returns it. */
export function validateCloseTalkKeepGapDb(db: number): number {
  if (typeof db !== 'number' || !Number.isFinite(db) || db < 0 || db > 20) throw new Error('invalid_close_talk_keep_gap_db: expected a finite value within 0..=20');
  return db;
}

/** Validates the close_talk level margin with the same rule as core (finite 0..=20 dB) and returns it. */
export function validateCloseTalkLevelMarginDb(db: number): number {
  if (typeof db !== 'number' || !Number.isFinite(db) || db < 0 || db > 20) throw new Error('invalid_close_talk_level_margin_db: expected a finite value within 0..=20');
  return db;
}

/** Validates the close_talk level assist floor with the same rule as core (finite -100..=0 dBFS) and returns it. */
export function validateCloseTalkLevelMinDbfs(dbfs: number): number {
  if (typeof dbfs !== 'number' || !Number.isFinite(dbfs) || dbfs < -100 || dbfs > 0) throw new Error('invalid_close_talk_level_min_dbfs: expected a finite value within -100..=0');
  return dbfs;
}

/** Validates the close_talk learned level injection with the same rule as core (finite -100..=0 dBFS, or null) and returns it. */
export function validateCloseTalkLearnedLevelDbfs(dbfs: number | null): number | null {
  if (dbfs === null) return null;
  if (typeof dbfs !== 'number' || !Number.isFinite(dbfs) || dbfs < -100 || dbfs > 0) throw new Error('invalid_close_talk_learned_level_dbfs: expected a finite value within -100..=0 or null');
  return dbfs;
}

/** Validates the general-mode attenuation limit (finite 0..=60 dB, or null for unlimited) and returns it. Only null clears. */
export function validateGeneralDenoiseAttenuationLimitDb(db: number | null): number | null {
  if (db === null) return null;
  if (typeof db !== 'number' || !Number.isFinite(db) || db < 0 || db > 60) throw new Error('invalid_general_denoise_attenuation_limit_db: expected a finite value within 0..=60 or null');
  return db;
}

/** Validates the close_talk noise attenuation limit with the same rule as core (finite 0..=60 dB) and returns it. Otherwise throws tellus_denoise_attenuation_limit_db_invalid. */
export function validateDenoiseAttenuationLimitDb(db: number): number {
  if (!Number.isFinite(db) || db < 0 || db > 60) throw new Error('tellus_denoise_attenuation_limit_db_invalid');
  return db;
}

/** The engine names the VAD model with a `vad` suffix. Every other container is the denoise model. */
export function isVadModel(modelId: string): boolean {
  return modelId.endsWith('vad');
}

/** Validates the public denoiseMode with the same rules as core (surrounding spaces and case ignored). Omitting it selects close_talk; unknown values are rejected. */
export function denoiseMode(config: AudioCaptureConfig): NonNullable<AudioCaptureConfig['denoiseMode']> {
  const value: unknown = config.denoiseMode ?? 'close_talk';
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (mode !== 'close_talk' && mode !== 'general') throw new Error('tellus_denoise_mode_invalid');
  return mode;
}
