import type { AudioChunk, AudioCaptureConfig, BrowserEngineAssets } from '../platform/capture-types.js';

export interface DeliveredChunk {
  chunk: AudioChunk;
  epoch: string;
  authorizationGeneration: string;
}

export interface NativeStatus {
  lifecycle: 'running' | 'paused' | 'stopped';
  denoise_enabled: boolean;
  denoise_loaded: boolean;
  vad_loaded: boolean;
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
