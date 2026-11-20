import { NitroModules } from 'react-native-nitro-modules';
import type { SpeechDetectionEvent } from '../../../bindings/typescript/speech-detection.js';
import type { TellusSpeechDetector } from './TellusSpeechDetector.nitro.js';

/** 실행 중 마이크가 끊기거나 감지에 실패하면 오류를 한 번 받는다. 수집이 실행 중인 감지를 종료하면 speech_detection_preempted_by_capture를 한 번 받는다. */
export type SpeechDetectionCallback = (error: Error | null, event?: SpeechDetectionEvent) => void;

/** 감지 전용 평문 Silero 모델 위치. 생략하면 SDK resource의 `silero_vad_v6.2.onnx`를 읽는다. */
export interface NativeSpeechDetectorAssets {
  /** SDK resource 이름(iOS `TellusAudioSdkModels.bundle`, Android `assets/tellus-audio-sdk`) 또는 file:// 경로. */
  speechDetectionModel: string;
}

// 엔진 archive의 speech-detection/silero_vad_v6.2.onnx를 SDK가 암호화 모델과 같은 resource 위치에 복사한 이름이다.
const DEFAULT_SPEECH_DETECTION_MODEL = 'silero_vad_v6.2.onnx';

/**
 * permit 없이 마이크 입력만으로 발화 여부를 감지한다. AudioEngine·capture와 native 객체·승인·모델 키를 공유하지 않으며 오디오를 내보내지 않는다.
 * 스피커·AEC·denoise·녹음·재생은 열지 않는다. 승인된 수집이 시작되면 감지를 종료하고 마이크를 반환한다.
 */
export class SpeechDetector {
  private readonly native = NitroModules.createHybridObject<TellusSpeechDetector>('TellusSpeechDetector');
  private running = false;
  private disposed = false;
  // start마다 올린다. stop 뒤에 도착한 이벤트·오류는 이 값이 달라 버린다.
  private run = 0;

  private constructor() {}

  /** 평문 Silero 모델을 읽어 둔다. 마이크는 start에서 연다. 모델이 없거나 읽지 못하면 거부한다. */
  static async init(assets?: NativeSpeechDetectorAssets): Promise<SpeechDetector> {
    const model = assets?.speechDetectionModel ?? DEFAULT_SPEECH_DETECTION_MODEL;
    if (typeof model !== 'string' || !model) throw new Error('invalid_speech_detection_model_asset');
    const detector = new SpeechDetector();
    try { await detector.native.loadModel(model); } catch (error) { await detector.dispose(); throw error; }
    return detector;
  }

  /**
   * 기본 마이크(또는 deviceId 입력)를 열고 발화 상태 이벤트를 callback으로 보낸다.
   * 이미 실행 중이면 speech_detection_already_running, 모델이 준비되지 않았거나 마이크를 열 수 없으면 해당 오류 코드로 거부한다.
   * 수집이 마이크를 확보 중이거나 실행·일시 정지 상태이면 speech_detection_preempted_by_capture로 거부한다.
   * 시작 완료 전 선점은 callback 없이 이 Promise만 거부한다. 시작 완료 뒤 선점은 callback에 같은 오류를 한 번 보낸다.
   */
  async start(callback: SpeechDetectionCallback, deviceId?: string): Promise<void> {
    if (this.disposed) throw new Error('speech_detector_disposed');
    if (this.running) throw new Error('speech_detection_already_running');
    if (deviceId !== undefined && (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.includes('\0'))) throw new Error('invalid_audio_device_id');
    this.running = true;
    const run = ++this.run;
    try {
      // native 이벤트는 공개 필드 두 개만 새로 만들어 넘긴다.
      await this.native.start(deviceId ?? '', (speaking, timestampMs) => {
        if (run === this.run) callback(null, { speaking, timestampMs });
      }, (code) => {
        if (run !== this.run) return;
        this.running = false;
        ++this.run;
        callback(new Error(code));
      });
    } catch (error) {
      if (run === this.run) { this.running = false; ++this.run; }
      throw error;
    }
  }

  /** 감지를 멈추고 마이크를 닫는다. 실행 중이 아니면 아무것도 하지 않는다. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    ++this.run;
    await this.native.stop();
  }

  /** 감지를 멈추고 native 객체를 닫는다. 그 뒤 start는 speech_detector_disposed로 거부한다. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try { await this.stop(); } finally { this.native.dispose(); }
  }
}
