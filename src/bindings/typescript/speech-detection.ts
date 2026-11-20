/** Emitted after the first complete window and when the speech state changes. */
export interface SpeechDetectionEvent {
  speaking: boolean;
  /** Elapsed microphone audio processed since start, in milliseconds. */
  timestampMs: number;
}
