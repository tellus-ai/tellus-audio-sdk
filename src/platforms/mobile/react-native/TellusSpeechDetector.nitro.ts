import type { HybridObject } from 'react-native-nitro-modules';

/**
 * permit 없이 OS 마이크 입력만으로 발화 상태를 감지한다. TellusCapture와 Rust handle·승인·모델 키·worker를 공유하지 않는다.
 * 감지기 C ABI(tellus_audio_speech_detector_*)만 부르며 JS에는 상태 이벤트와 오류 코드만 전달한다.
 */
export interface TellusSpeechDetector extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  /** 평문 Silero 모델을 file:// 경로나 SDK resource 이름으로 읽어 둔다. 감지기는 start마다 이 bytes로 새로 만든다. */
  loadModel(path: string): Promise<void>;
  /**
   * micDeviceId(빈 문자열이면 기본 마이크)를 열고 감지를 시작한다. 이벤트는 상태가 바뀌거나 첫 1초 창이 찼을 때만 온다.
   * onError는 실행 중 마이크가 끊기거나 감지가 실패했을 때 한 번 오며, 그 뒤 감지는 끝난다.
   */
  start(micDeviceId: string, onEvent: (speaking: boolean, timestampMs: number) => void, onError: (code: string) => void): Promise<void>;
  /** 감지를 멈추고 마이크와 감지기를 닫는다. 실행 중이 아니면 아무것도 하지 않는다. */
  stop(): Promise<void>;
}
