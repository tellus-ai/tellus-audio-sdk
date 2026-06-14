import { prepareEngineRuntime } from './runtime/engine-runtime';

/** Audio capture configuration. */
export interface AudioCaptureConfig {
  /** Processing/mixer PCM sample rate. Native default is 16000 when config is omitted. */
  sampleRate: number;
  /** Processing/mixer PCM chunk duration in milliseconds. Native default is 20 when config is omitted. */
  chunkDurationMs: number;
  /** Transport audio codec. Native default is "opus". */
  audioCodec?: string;
  /** Initial target bitrate in bps. */
  bitrateBps?: number;
  /** Enables microphone capture. */
  enableMic: boolean;
  /** Enables speaker/system-audio capture. */
  enableSpeaker: boolean;
  /** Optional microphone device name. */
  micDeviceName?: string;
}

interface AudioChunk {
  source: string;
  stage?: string;
  data: Buffer;
  sampleRate: number;
  sample: number;
  timestamp: number;
  rms: number;
}

interface CaptureError {
  source: string;
  message: string;
  recoverable: boolean;
}

type ErrorCallback = (err: Error | null, arg: CaptureError) => unknown;
type AudioChunkCallback = (err: Error | null, arg: AudioChunk) => unknown;

const { nativeBinding } = prepareEngineRuntime();

const {
  AudioCapture: NativeAudioCapture,
  listMicDevices: nativeListMicDevices,
  isSpeakerCaptureSupported: nativeIsSpeakerCaptureSupported,
} = nativeBinding;

export class AudioCapture {
  #native: any;

  constructor(config?: AudioCaptureConfig | null) {
    this.#native = new NativeAudioCapture(config);
  }

  onError(callback: ErrorCallback): void {
    this.#native.onError(callback);
  }

  start(callback: AudioChunkCallback): void {
    this.#native.start(callback);
  }

  pause(): void {
    this.#native.pause();
  }

  resume(): void {
    this.#native.resume();
  }

  stop(): void {
    this.#native.stop();
  }

  getState(): string {
    return this.#native.getState();
  }
}

export const listMicDevices: () => string[] = nativeListMicDevices;
export const isSpeakerCaptureSupported: () => boolean = nativeIsSpeakerCaptureSupported;
