/** 조회와 선택의 대상. 시스템 오디오 캡처와 SDK 재생 출력을 구분한다. */
export type AudioDeviceSource = 'microphone' | 'system_audio' | 'playback';

/** 플랫폼이 반환한 ID와 이름. ID의 영구성을 보장하지 않는다. */
export interface AudioDeviceInfo {
  id: string;
  label: string;
}

/** ready는 해당 작업의 준비 완료이며, 목록 조회는 스트림 선택을 보장하지 않는다. */
export interface AudioDeviceStatus {
  source: AudioDeviceSource;
  code: 'pending' | 'ready' | 'unavailable' | 'unsupported' | 'permission_denied' | 'route_mismatch';
  requestedDeviceId?: string;
  actualDeviceId?: string;
  /**
   * 준비된 입력에서 OS·브라우저가 엔진 쪽으로 넘기는 레이트(Hz). 알 수 없으면 없다.
   * 장치의 실제 대역폭 증명이 아니다. Linux 서버 측 리샘플링과 브라우저 리샘플링은 협대역 장치를 숨길 수 있다.
   */
  nativeSampleRateHz?: number;
}

export interface AudioDeviceListResult {
  status: AudioDeviceStatus;
  devices: readonly AudioDeviceInfo[];
}

/** 기존 reject와 오류 callback에서 장치 실패를 구조화하여 제공한다. */
export interface AudioDeviceOperationError extends Error {
  deviceStatus: AudioDeviceStatus;
}
