import type { BrowserEngineAssets } from '../../bindings/typescript/capture-types.js';
import type { SpeechDetectionEvent } from '../../bindings/typescript/speech-detection.js';

/** Engine and ORT assets for speech detection. Relative URLs resolve against the document base URL. */
export interface BrowserSpeechDetectorAssets extends Omit<BrowserEngineAssets, 'encryptedModels'> {
  /** The `speech-detection/silero_vad_v6.2.onnx` URL from the web engine distribution. */
  speechDetectionModelUrl: string;
}

export type SpeechDetectionCommand =
  | { operation: 'init'; assets: BrowserSpeechDetectorAssets }
  | { operation: 'start' }
  | { operation: 'push'; samples: Float32Array; rate: number }
  | { operation: 'stop' };

export interface SpeechDetectionRequest {
  id: number;
  command: SpeechDetectionCommand;
}

/** Carries speech state events or an error to the main thread. */
export interface SpeechDetectionResponse {
  id: number;
  events?: SpeechDetectionEvent[];
  error?: string;
}
