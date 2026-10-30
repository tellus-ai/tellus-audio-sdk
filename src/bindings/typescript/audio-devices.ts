/** What to list or select. Separates system audio capture from SDK playback output. */
export type AudioDeviceSource = 'microphone' | 'system_audio' | 'playback';

/** ID and name returned by the platform. IDs are not guaranteed to persist. */
export interface AudioDeviceInfo {
  id: string;
  label: string;
}

/** ready means that operation is prepared; a successful listing does not guarantee stream selection. */
export interface AudioDeviceStatus {
  source: AudioDeviceSource;
  code: 'pending' | 'ready' | 'unavailable' | 'unsupported' | 'permission_denied' | 'route_mismatch';
  requestedDeviceId?: string;
  actualDeviceId?: string;
  /**
   * Rate (Hz) the OS or browser hands to the engine for a ready input. Absent when unknown.
   * Not proof of the device's real bandwidth: Linux server-side resampling and browser resampling can hide a narrowband device.
   */
  nativeSampleRateHz?: number;
}

export interface AudioDeviceListResult {
  status: AudioDeviceStatus;
  devices: readonly AudioDeviceInfo[];
}

/** Carries structured device failures on existing rejections and error callbacks. */
export interface AudioDeviceOperationError extends Error {
  deviceStatus: AudioDeviceStatus;
}
