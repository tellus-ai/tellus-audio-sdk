import type {
  AuthorizableAudioCapture,
  EngineAuthorizationController,
  EngineAuthorizationOptions,
  EngineAuthorizationSocket,
  EngineModelKey,
  EngineModelKeyRequest,
  MaybePromise,
} from './contracts';

export type {
  AuthorizableAudioCapture,
  EngineAuthorizationController,
  EngineAuthorizationOptions,
  EngineAuthorizationRequest,
  EngineAuthorizationSocket,
  EngineAuthorizationStatus,
  EngineModelKey,
  EngineModelKeyRequest,
  MaybePromise,
} from './contracts';

const MAX_RENEW_INTERVAL_MS = 480_000;
const RETRY_DELAY_MS = 1_000;
const MODEL_IDS = ['fe-s16', 'fe-s48', 'silero-vad'];
const IDENTIFIER = /^[A-Za-z0-9._-]{1,64}(?![\s\S])/;

function modelRequests(requests: EngineModelKeyRequest[]): EngineModelKeyRequest[] {
  if (!Array.isArray(requests) || requests.length > 3) throw new Error('engine_model_key_request_invalid');
  const models = new Set<string>();
  for (const request of requests) {
    if (!request || !MODEL_IDS.includes(request.modelId) || typeof request.keyId !== 'string' ||
        !IDENTIFIER.test(request.keyId) || typeof request.publicKey !== 'string' ||
        request.publicKey.length !== 64 || !/^[0-9a-f]{64}$/.test(request.publicKey) || models.has(request.modelId)) {
      throw new Error('engine_model_key_request_invalid');
    }
    models.add(request.modelId);
  }
  return requests.map(request => ({ ...request }));
}

function modelKeys(value: unknown, requests: EngineModelKeyRequest[]): EngineModelKey[] {
  if (requests.length === 0 && value === undefined) return [];
  if (!Array.isArray(value) || value.length !== requests.length || requests.length === 0) {
    throw new Error('engine_model_key_response_invalid');
  }
  const models = new Set<string>();
  return value.map((key: unknown) => {
    if (typeof key !== 'object' || key === null || Array.isArray(key)) throw new Error('engine_model_key_response_invalid');
    const reply = key as Record<string, unknown>;
    const request = requests.find(request => request.modelId === reply.model_id && request.keyId === reply.key_id);
    // 80바이트는 정확히 107문자이며 마지막 base64url 문자의 하위 2비트는 0이다.
    if (!request || models.has(request.modelId) || typeof reply.wrapped_key !== 'string' ||
        reply.wrapped_key.length !== 107 || !/^[A-Za-z0-9_-]{106}[AEIMQUYcgkosw048]$/.test(reply.wrapped_key)) {
      throw new Error('engine_model_key_response_invalid');
    }
    models.add(request.modelId);
    return { modelId: request.modelId, keyId: request.keyId, wrappedKey: reply.wrapped_key };
  });
}

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
  // 동기 desktop의 미지원 빌드 오류는 이전처럼 attach 호출자에게 즉시 전달한다.
  const initialStatus = capture.getAuthorizationStatus();
  let disposed = false;
  let approved = false;
  let pending: { sequence: number | null; applying: boolean; keys: EngineModelKeyRequest[] } | null = null;
  let attempt = 0;
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

  function active(current: number): boolean { return !disposed && current === attempt; }

  // 동기 응답은 같은 호출에서 이어가고 Promise만 비동기로 처리하여 desktop 계약을 보존한다.
  function continueWith<T>(value: MaybePromise<T>, current: number, next: (value: T) => void): void {
    if (value && typeof (value as Promise<T>).then === 'function') {
      void Promise.resolve(value).then(next).catch(error => { if (active(current)) fail(error); });
    } else next(value as T);
  }

  function invalidateNative(): void {
    const result = capture.invalidateAuthorization();
    if (result && typeof result.then === 'function') {
      void result.catch(error => options.onError?.(error instanceof Error ? error : new Error('engine_authorization_failed')));
    }
  }

  function clearTimers(): void {
    clearTimeout(responseTimer);
    clearTimeout(renewalTimer);
    responseTimer = undefined;
    renewalTimer = undefined;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    attempt++;
    pending = null;
    clearTimers();
    socket.removeEventListener('open', onOpen);
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('close', onClose);
    socket.removeEventListener('error', onError);
    if (!approved) rejectReady(new Error('engine_authorization_disposed'));
    invalidateNative();
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

  function scheduleRenewal(delayMs: number, current: number, scheduled?: () => void): void {
    continueWith(capture.getAuthorizationStatus(), current, status => {
      if (!active(current)) return;
      if (status.state !== 'authorized' || status.remainingMs <= 0) throw new Error('engine_authorization_expired');
      clearTimeout(renewalTimer);
      renewalTimer = setTimeout(() => { void request('engine.renew'); },
        Math.max(1, Math.min(delayMs, MAX_RENEW_INTERVAL_MS, Math.floor(status.remainingMs * 9 / 10))));
      scheduled?.();
    });
  }

  function retryOrFail(error: unknown): void {
    const current = ++attempt;
    clearTimeout(responseTimer);
    pending = null;
    if (!approved) { fail(error); return; }
    try { scheduleRenewal(RETRY_DELAY_MS, current); }
    catch (expired) { fail(expired); }
  }

  function onResponseTimeout(): void {
    if (!disposed) retryOrFail(new Error('engine_authorization_timeout'));
  }

  async function request(type: 'audio.authenticate' | 'engine.renew'): Promise<void> {
    if (disposed || pending !== null) return;
    const current = ++attempt;
    const operation = { sequence: null as number | null, applying: false, keys: [] as EngineModelKeyRequest[] };
    pending = operation;
    responseTimer = setTimeout(onResponseTimeout, requestTimeoutMs);
    try {
      await initialStatus;
      if (!active(current)) return;
      const challenge = await capture.createAuthorizationRequest(options.conversationId);
      if (!active(current)) return;
      operation.sequence = challenge.sequence;
      if (type === 'audio.authenticate' && capture.createModelKeyRequests) {
        const keys = await capture.createModelKeyRequests();
        if (!active(current)) return;
        operation.keys = modelRequests(keys);
        if (operation.keys.length && !capture.applyModelKeys) throw new Error('engine_model_key_request_invalid');
      }
      const accessToken = await options.getAccessToken();
      if (!active(current)) return;
      if (socket.readyState !== 1 || !accessToken) throw new Error('engine_authentication_required');
      socket.send(JSON.stringify({
        type, version: 1, access_token: accessToken,
        engine: { native_instance_id: challenge.nativeInstanceId, nonce: challenge.nonce, sequence: challenge.sequence },
        ...(operation.keys.length ? { model_keys: operation.keys.map(key => ({
          model_id: key.modelId, key_id: key.keyId, public_key: key.publicKey,
        })) } : {}),
      }));
    } catch (error) { if (active(current)) retryOrFail(error); }
  }

  function onMessage(event: { data?: unknown }): void {
    if (disposed || typeof event.data !== 'string') return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch { return; }
    if (message.type === 'system.error') { fail(new Error('engine_authorization_server_error')); return; }
    if (!['engine.authorized', 'engine.renewed', 'engine.denied'].includes(String(message.type))) return;
    const current = attempt;
    try {
      if (typeof message.sequence === 'number' && approved &&
          (pending === null || pending.sequence !== null && message.sequence < pending.sequence)) return;
      if (message.version !== 1 || pending === null || pending.sequence === null || message.sequence !== pending.sequence) {
        throw new Error('engine_authorization_response_mismatch');
      }
      if (message.type === 'engine.denied') {
        clearTimeout(responseTimer);
        pending = null;
        if (approved && message.retryable === true) { scheduleRenewal(RETRY_DELAY_MS, current); return; }
        throw new Error(typeof message.code === 'string' ? message.code : 'engine_access_denied');
      }
      if (pending.applying) return;
      if (message.type !== (approved ? 'engine.renewed' : 'engine.authorized') ||
          typeof message.token !== 'string' || typeof message.renew_after_ms !== 'number' ||
          !Number.isFinite(message.renew_after_ms) || message.renew_after_ms <= 0) {
        throw new Error('engine_authorization_response_invalid');
      }
      const keys = modelKeys(message.model_keys, pending.keys);
      pending.applying = true;
      const complete = () => {
        if (!active(current)) return;
        scheduleRenewal(message.renew_after_ms as number, current, () => {
          if (!active(current)) return;
          clearTimeout(responseTimer);
          pending = null;
          if (!approved) { approved = true; resolveReady(); }
        });
      };
      continueWith(capture.applyAuthorization(message.token), current, status => {
        if (disposed) { invalidateNative(); return; }
        if (!active(current)) return;
        if (status.state !== 'authorized' || status.remainingMs <= 0) throw new Error('engine_authorization_expired');
        if (keys.length) continueWith(capture.applyModelKeys!(keys), current, complete);
        else complete();
      });
    } catch (error) { if (active(current)) fail(error); }
  }

  function onOpen(): void { void request(approved ? 'engine.renew' : 'audio.authenticate'); }
  function onClose(): void { fail(new Error('engine_authorization_connection_closed')); }
  function onError(): void { fail(new Error('engine_authorization_connection_failed')); }

  socket.addEventListener('open', onOpen);
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onError);
  // 연결이 아직 열리지 않아 request가 대기하지 않는 동안에도 비동기 preflight 실패를 소비한다.
  continueWith(initialStatus, attempt, () => {});
  if (socket.readyState === 1) queueMicrotask(onOpen);
  else if (socket.readyState >= 2) queueMicrotask(onClose);
  return { ready, dispose };
}
