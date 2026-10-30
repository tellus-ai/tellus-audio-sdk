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
  /** denoise 활성화 여부. 모델은 DeepFilterNet3(암호화 모델 dfn3-48)로 고정이고 내부 처리는 48 kHz이며 출력만 processing.sampleRate로 변환한다. */
  denoiseEnabled?: boolean;
  /**
   * denoise 출력 정책. 생략하면 'close_talk'이다. 앞뒤 공백·대소문자는 무시하고 모르는 값은 init에서 거부한다.
   * 'close_talk'는 근접 발화 게이트로 먼 소리를 정확히 0으로 바꾸고 그만큼 출력을 300 ms 더 늦추며(모델 지연을 합쳐 약 330 ms) 잡음 감쇠는 최대 -12 dB다. 시끄러운 곳에서는 말이 막힐 수 있다.
   * 'general'은 DeepFilterNet3 출력을 그대로 쓰고 감쇠 제한이 없다. denoiseEnabled가 false면 게이트도 꺼진다.
   */
  denoiseMode?: 'close_talk' | 'general';
  vadEnabled?: boolean;
  echoCancellationEnabled?: boolean;
  micAgc2Enabled?: boolean;
  /**
   * sampleRate는 엔진 출력 레이트다. 호출자가 받는 청크·payload·샘플 시계가 이 레이트이고 생략하면 16000이다.
   * 장치 캡처 레이트가 아니다. 내부 처리는 항상 48 kHz이고 어떤 장치 레이트든 리샘플한다.
   * 8000..=192000 Hz에서 20ms가 정수 샘플(50의 배수)이어야 한다. Opus는 8000·12000·16000·24000·48000 Hz만 지원하므로 다른 레이트는 pcm_s16le·pcm_f32le를 쓴다.
   * chunkDurationMs는 20만 지원한다.
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
  /** denoise가 실제로 켜져 있는지다. dfn3-48을 올리지 못했으면 false다. */
  denoiseEnabled: boolean;
  /** 적용 중인 denoiseMode다. */
  denoiseMode: 'close_talk' | 'general';
  /** dfn3-48을 올리지 못해 denoise·게이트 없이 입력을 통과시키는 중이다. */
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
