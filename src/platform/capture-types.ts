import type { AuthorizableAudioCapture } from '../authorization/contracts';

export interface AudioCaptureConfig {
  micEnabled?: boolean;
  speakerEnabled?: boolean;
  enableRawAudio?: boolean;
  denoiseEnabled?: boolean;
  vadEnabled?: boolean;
  echoCancellationEnabled?: boolean;
  micAgc2Enabled?: boolean;
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
  /** 종료 시 padding을 제외한 유효 샘플 수. */
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
  denoiseEnabled: boolean;
  vadEnabled: boolean;
  modelsLoaded: string[];
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
  /** 승인과 캡처를 유지하면서 처리 이력과 미전달 출력을 폐기한다. */
  reset(): Promise<void>;
  /** 재생 완료까지 기다리며 같은 샘플을 엔진 AEC 기준 신호로 전달한다. */
  playback(samples: Float32Array, nativeRate: number): Promise<void>;
  /** OS decoder로 MP3·WAV를 읽고 동일 재생·AEC 경로에 전달한다. */
  playbackEncoded(data: ArrayBuffer): Promise<void>;
  cancelPlayback(): Promise<void>;
  /** Android 녹음 알림을 설정한다. pause/resume은 앱 세션이 제어한다. */
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
  /** SDK가 다운로드·복사한 암호화 컨테이너의 파일 경로. */
  encryptedModels: string[];
}
