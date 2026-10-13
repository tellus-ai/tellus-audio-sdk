import type {
  AudioDeviceListResult, AudioDeviceOperationError, AudioDeviceSource, AudioDeviceStatus,
} from '../../bindings/typescript/audio-devices.js';

/** 브라우저 장치 경계의 실패를 문자열 파싱 없이 공개 상태로 전달한다. */
export function audioDeviceError(value: unknown, source: AudioDeviceSource, requestedDeviceId?: string): AudioDeviceOperationError {
  const error = value instanceof Error ? value : new Error('tellus_audio_device_unavailable');
  const code: AudioDeviceStatus['code'] = error.name === 'NotAllowedError' || error.name === 'SecurityError'
    ? 'permission_denied' : error.name === 'NotSupportedError' ? 'unsupported' : 'unavailable';
  return Object.assign(error, { deviceStatus: { source, code, ...(requestedDeviceId === undefined ? {} : { requestedDeviceId }) } });
}

/** 권한을 요청하지 않고 브라우저가 현재 공개하는 장치 ID와 label을 조회한다. */
export async function listAudioDevices(source: AudioDeviceSource): Promise<AudioDeviceListResult> {
  if (!['microphone', 'system_audio', 'playback'].includes(source)) throw new Error('tellus_audio_device_source_invalid');
  if (source === 'system_audio' || !navigator.mediaDevices?.enumerateDevices) {
    return { status: { source, code: 'unsupported' }, devices: [] };
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const kind = source === 'microphone' ? 'audioinput' : 'audiooutput';
    return {
      status: { source, code: 'ready' },
      devices: devices.filter((device) => device.kind === kind && device.deviceId !== '').map((device) => ({ id: device.deviceId, label: device.label })),
    };
  } catch (error) {
    return { status: audioDeviceError(error, source).deviceStatus, devices: [] };
  }
}
