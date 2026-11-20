// Each capture holds independent priority in this browser runtime.
const captures = new Set<object>();
const detectors = new Set<() => (() => void) | undefined>();
const pendingDetectorInputs = new Set<Promise<unknown>>();

export const SPEECH_DETECTION_PREEMPTED = 'speech_detection_preempted_by_capture';

export function registerDetector(preempt: () => (() => void) | undefined): void {
  if (captures.size) throw new Error(SPEECH_DETECTION_PREEMPTED);
  detectors.add(preempt);
}

export function unregisterDetector(preempt: () => (() => void) | undefined): void {
  detectors.delete(preempt);
}

/** Browser permission requests cannot be canceled. Track them until any late tracks have closed. */
export function trackDetectorInput<T>(input: Promise<T>): Promise<T> {
  pendingDetectorInputs.add(input);
  return input.finally(() => { pendingDetectorInputs.delete(input); });
}

/** Record capture priority, close detector microphones, then invoke their terminal callbacks. */
export async function acquireCapturePriority(capture: object): Promise<void> {
  captures.add(capture);
  const notifications = [...detectors].map((preempt) => preempt());
  for (const notify of notifications) notify?.();
  await Promise.allSettled(pendingDetectorInputs);
}

export function hasCapturePriority(capture: object): boolean {
  return captures.has(capture);
}

export function releaseCapturePriority(capture: object): void {
  captures.delete(capture);
}
