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
  vad_loaded: boolean;
}

/** Native status plus the IDs of the loaded models, read from the encrypted container headers. */
export interface WorkerStatus extends NativeStatus {
  loadedModels: string[];
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

/** Validates the public denoiseMode with the same rules as core (surrounding spaces and case ignored). Omitting it selects close_talk; unknown values are rejected. */
export function denoiseMode(config: AudioCaptureConfig): NonNullable<AudioCaptureConfig['denoiseMode']> {
  const value: unknown = config.denoiseMode ?? 'close_talk';
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (mode !== 'close_talk' && mode !== 'general') throw new Error('tellus_denoise_mode_invalid');
  return mode;
}
