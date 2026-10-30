import type { HybridObject, UInt64 } from 'react-native-nitro-modules';

/** Connects the authorized Rust session to the OS microphone. PCM processing and model inference run only on the native worker. */
export interface TellusCapture extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  configure(json: string, processingRate: number): Promise<void>;
  configureAudioDevices(micDeviceId: string, playbackDeviceId: string, iosOutputRoute: string): Promise<void>;
  listAudioDevices(source: string): Promise<string>;
  getAudioDeviceStatus(): Promise<string>;
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
