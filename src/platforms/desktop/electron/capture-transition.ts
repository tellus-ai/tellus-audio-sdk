/** Wait for native acknowledgement; a stopped or replaced session cannot satisfy an old request. */
export async function waitForCaptureTransition(
  getState: () => string,
  target: 'paused' | 'recording',
  isCurrent: () => boolean,
  stop: () => void,
  timeoutMs = 6000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (!isCurrent()) throw new Error('capture_transition_replaced');
    const state = getState();
    if (state === target) return;
    if (state !== 'pausing' && state !== 'resuming') throw new Error(`capture_transition_interrupted: ${state}`);
    if (Date.now() >= deadline) {
      stop();
      throw new Error('capture_transition_timeout');
    }
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}
