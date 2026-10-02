import type {
  AuthorizableAudioCapture,
  EngineAuthorizationController,
  EngineAuthorizationOptions,
  EngineAuthorizationSocket,
} from './contracts';

export type {
  AuthorizableAudioCapture,
  EngineAuthorizationController,
  EngineAuthorizationOptions,
  EngineAuthorizationRequest,
  EngineAuthorizationSocket,
  EngineAuthorizationStatus,
} from './contracts';

const MAX_RENEW_INTERVAL_MS = 480_000;
const RETRY_DELAY_MS = 1_000;

/** Bind authorization and renewal to an existing /audio WebSocket. No audio frames are required. */
export function attachEngineAuthorization(
  socket: EngineAuthorizationSocket,
  capture: AuthorizableAudioCapture,
  options: EngineAuthorizationOptions,
): EngineAuthorizationController {
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  if (!options.conversationId || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('engine_authorization_invalid_options');
  }
  // Reject unsupported native builds before installing listeners or starting requests.
  capture.getAuthorizationStatus();
  let disposed = false;
  let approved = false;
  let pendingSequence: number | null = null;
  let attempt = 0;
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function clearTimers(): void {
    clearTimeout(responseTimer);
    clearTimeout(renewalTimer);
    responseTimer = undefined;
    renewalTimer = undefined;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearTimers();
    socket.removeEventListener('open', onOpen);
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('close', onClose);
    socket.removeEventListener('error', onError);
    capture.invalidateAuthorization();
    if (!approved) rejectReady(new Error('engine_authorization_disposed'));
  }

  // Authorization failures stop only the native engine; the caller's socket stays open.
  function fail(value: unknown): void {
    if (disposed) return;
    const error = value instanceof Error ? value : new Error('engine_authorization_failed');
    const wasApproved = approved;
    if (!approved) rejectReady(error);
    dispose();
    if (wasApproved) options.onError?.(error);
  }

  function scheduleRenewal(delayMs: number): void {
    const status = capture.getAuthorizationStatus();
    if (status.state !== 'authorized' || status.remainingMs <= 0) {
      throw new Error('engine_authorization_expired');
    }
    clearTimeout(renewalTimer);
    renewalTimer = setTimeout(() => { void request('engine.renew'); },
      Math.max(1, Math.min(delayMs, MAX_RENEW_INTERVAL_MS, Math.floor(status.remainingMs * 9 / 10))));
  }

  // Abandons the current attempt. Once approved, renewal retries until native permission expires.
  function retryOrFail(error: unknown): void {
    attempt++;
    clearTimeout(responseTimer);
    pendingSequence = null;
    if (!approved) {
      fail(error);
      return;
    }
    try { scheduleRenewal(RETRY_DELAY_MS); }
    catch (expired) { fail(expired); }
  }

  function onResponseTimeout(): void {
    if (disposed) return;
    retryOrFail(new Error('engine_authorization_timeout'));
  }

  async function request(type: 'audio.authenticate' | 'engine.renew'): Promise<void> {
    if (disposed || pendingSequence !== null) return;
    const current = ++attempt;
    responseTimer = setTimeout(onResponseTimeout, requestTimeoutMs);
    try {
      const challenge = capture.createAuthorizationRequest(options.conversationId);
      pendingSequence = challenge.sequence;
      const accessToken = await options.getAccessToken();
      if (disposed || current !== attempt) return;
      if (socket.readyState !== 1 || !accessToken) throw new Error('engine_authentication_required');
      socket.send(JSON.stringify({
        type, version: 1, access_token: accessToken,
        engine: { native_instance_id: challenge.nativeInstanceId, nonce: challenge.nonce, sequence: challenge.sequence },
      }));
    } catch (error) {
      if (!disposed && current === attempt) retryOrFail(error);
    }
  }

  function onMessage(event: { data?: unknown }): void {
    if (disposed || typeof event.data !== 'string') return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch { return; }
    if (message.type === 'system.error') {
      fail(new Error('engine_authorization_server_error'));
      return;
    }
    if (!['engine.authorized', 'engine.renewed', 'engine.denied'].includes(String(message.type))) return;
    try {
      // Late replies to an abandoned challenge cannot renew native permission.
      if (typeof message.sequence === 'number' && approved &&
          (pendingSequence === null || message.sequence < pendingSequence)) return;
      if (message.version !== 1 || message.sequence !== pendingSequence || pendingSequence === null) {
        throw new Error('engine_authorization_response_mismatch');
      }
      clearTimeout(responseTimer);
      pendingSequence = null;
      if (message.type === 'engine.denied') {
        if (approved && message.retryable === true) {
          scheduleRenewal(RETRY_DELAY_MS);
          return;
        }
        throw new Error(typeof message.code === 'string' ? message.code : 'engine_access_denied');
      }
      if (message.type !== (approved ? 'engine.renewed' : 'engine.authorized') ||
          typeof message.token !== 'string' || typeof message.renew_after_ms !== 'number' ||
          !Number.isFinite(message.renew_after_ms) || message.renew_after_ms <= 0) {
        throw new Error('engine_authorization_response_invalid');
      }
      const status = capture.applyAuthorization(message.token);
      if (status.state !== 'authorized' || status.remainingMs <= 0) throw new Error('engine_authorization_expired');
      scheduleRenewal(message.renew_after_ms);
      if (!approved) { approved = true; resolveReady(); }
    } catch (error) { fail(error); }
  }

  function onOpen(): void { void request('audio.authenticate'); }
  function onClose(): void { fail(new Error('engine_authorization_connection_closed')); }
  function onError(): void { fail(new Error('engine_authorization_connection_failed')); }

  socket.addEventListener('open', onOpen);
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onError);
  if (socket.readyState === 1) queueMicrotask(onOpen);
  else if (socket.readyState >= 2) queueMicrotask(onClose);
  return { ready, dispose };
}
