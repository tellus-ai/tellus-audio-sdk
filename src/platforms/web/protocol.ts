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

/** core가 Opus로 인코딩하는 출력 레이트다. */
const OPUS_SAMPLE_RATES = [8000, 12000, 16000, 24000, 48000];

/**
 * 공개 출력 레이트를 core 전송 설정과 같은 규칙으로 검증해 돌려준다. 생략하면 16000이다.
 * 8000..=192000 Hz에서 고정 20 ms 청크가 정수 샘플(50의 배수)이어야 하고 chunkDurationMs는 20만 받는다. 어기면 tellus_processing_config_invalid다.
 * Opus(codec 생략 시 기본, 앞뒤 공백·대소문자 무시)는 8000·12000·16000·24000·48000 Hz만 받고 다른 레이트는 tellus_opus_sample_rate_unsupported다.
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

/** 공개 denoiseMode를 core와 같은 규칙(앞뒤 공백·대소문자 무시)으로 검증한다. 생략하면 close_talk이고 모르는 값은 거부한다. */
export function denoiseMode(config: AudioCaptureConfig): NonNullable<AudioCaptureConfig['denoiseMode']> {
  const value: unknown = config.denoiseMode ?? 'close_talk';
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (mode !== 'close_talk' && mode !== 'general') throw new Error('tellus_denoise_mode_invalid');
  return mode;
}
