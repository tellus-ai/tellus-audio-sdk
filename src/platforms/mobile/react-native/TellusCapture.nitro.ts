import type { HybridObject, UInt64 } from 'react-native-nitro-modules';

/** 승인된 Rust 세션과 OS 마이크를 연결한다. PCM 처리와 모델 추론은 native worker에서만 수행한다. */
export interface TellusCapture extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  configure(json: string, processingRate: number): Promise<void>;
  createAuthorizationRequest(conversationId: string): Promise<string>;
  applyAuthorization(token: string): Promise<string>;
  getAuthorizationStatus(): Promise<string>;
  invalidateAuthorization(): void;
  createModelKeyRequest(): Promise<string>;
  inspectModelFile(path: string): Promise<string>;
  applyModelKey(modelId: string, keyId: string, wrappedKey: ArrayBuffer): Promise<void>;
  loadModelFile(path: string): Promise<void>;
  start(
    onChunk: (payload: ArrayBuffer, metadata: string, epoch: UInt64, generation: UInt64) => void,
    onError: (code: string) => void,
  ): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
  reset(): Promise<void>;
  getStatus(): Promise<string>;
  setDenoiseEnabled(enabled: boolean): Promise<void>;
  setRecordingNotification(title: string, contentText: string, pauseAction: boolean, resumeAction: boolean,
    onAction: (action: string) => void): Promise<void>;
  playback(samples: ArrayBuffer, rate: number): Promise<void>;
  playbackEncoded(encoded: ArrayBuffer): Promise<void>;
  cancelPlayback(): Promise<void>;
  canDeliver(epoch: UInt64, generation: UInt64): boolean;
  acknowledgeChunk(): void;
}
