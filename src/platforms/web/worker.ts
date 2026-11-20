import type { AudioCaptureConfig, BrowserEngineAssets } from '../../bindings/typescript/capture-types.js';
import { validateGainDb } from '../../bindings/typescript/audio-gain.js';
import { loadEngineModule, NativeEngine, type NativeCapture } from './native.js';
import { isVadModel, type DeliveredChunk, type NativeStatus, validateCloseTalkHoldMs, validateCloseTalkKeepGapDb, validateCloseTalkLearnedLevelDbfs, validateCloseTalkLevelMarginDb, validateCloseTalkLevelMinDbfs, validateCloseTalkThresholdDb, validateDenoiseAttenuationLimitDb, validateGeneralDenoiseAttenuationLimitDb, type WorkerCommand, type WorkerRequest, type WorkerResponse, WorkerStatus } from './protocol.js';

interface EncryptedModel {
  model_id: string;
  key_id: string;
  bytes: Uint8Array;
}

interface Session {
  native: NativeCapture;
  models: EncryptedModel[];
  loaded: boolean;
  epoch: number;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
const sessions = new Map<number, Session>();
let engine: NativeEngine;
let models: EncryptedModel[] = [];
let nextSessionId = 0;
let activeSessionId = 0;
let operations: Promise<void> = Promise.resolve();

scope.onmessage = (event: MessageEvent<WorkerRequest | { cancel: number; epoch: number }>) => {
  const message = event.data;
  if ('cancel' in message) {
    const session = sessions.get(message.cancel);
    if (session) session.epoch = message.epoch;
    if (engine && activeSessionId === message.cancel) engine.module.tellusCancellationGeneration++;
    return;
  }
  // Asyncify is not reentrant. The cancellation handling above runs immediately even while waiting on ORT inference.
  operations = operations.then(async () => {
    try {
      activeSessionId = message.sessionId;
      const result = await dispatch(message);
      const response: WorkerResponse = { id: message.id, result };
      const transfers = Array.isArray(result) ? result.flatMap((value: DeliveredChunk) => value.chunk?.data.microphone ? [value.chunk.data.microphone.buffer] : []) : [];
      scope.postMessage(response, transfers);
    } catch (error) {
      scope.postMessage({ id: message.id, error: error instanceof Error ? error.message : 'tellus_worker_failed' } satisfies WorkerResponse);
    } finally { activeSessionId = 0; }
  });
};

async function initialize(assets: BrowserEngineAssets): Promise<void> {
  engine = new NativeEngine(await loadEngineModule(assets));
  const containers = await Promise.all(assets.encryptedModels.map(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('tellus_model_download_failed');
    return new Uint8Array(await response.arrayBuffer());
  }));
  for (const bytes of containers) {
    const metadata = await engine.bytes(bytes, (pointer, length) => engine.json<{ model_id: string; key_id: string }>('model_container_inspect', [pointer, length]));
    if (models.some((model) => model.model_id === metadata.model_id)) throw new Error('tellus_duplicate_model');
    models.push({ ...metadata, bytes });
  }
}

// The engine owns the denoise model choice, so any container that is not the VAD model counts as the denoise model. Core rejects one it does not support.
function requiredModels(config: AudioCaptureConfig): EncryptedModel[] {
  const selected = models.filter((model) => config.vadEnabled || !isVadModel(model.model_id));
  const hasDenoise = selected.some((model) => !isVadModel(model.model_id));
  const hasVad = selected.some((model) => isVadModel(model.model_id));
  if ((config.denoiseEnabled && !hasDenoise) || (config.vadEnabled && !hasVad)) throw new Error('tellus_encrypted_model_missing');
  return selected;
}

async function dispatch(request: WorkerRequest): Promise<unknown> {
  const command = request.command;
  if (command.operation === 'init') { await initialize(command.assets); return; }
  if (command.operation === 'create') {
    const selected = requiredModels(command.config);
    const sessionId = ++nextSessionId;
    sessions.set(sessionId, { native: await engine.create(command.config), models: selected, loaded: false, epoch: 0 });
    return sessionId;
  }
  const session = sessions.get(request.sessionId);
  if (!session) throw new Error('tellus_capture_disposed');
  // Hold and release are idempotent state changes, so they apply in call order even after the epoch changes. Cancelling would leave the engine held after reset() or drop the hold.
  const epochExempt = command.operation === 'invalidate' || command.operation === 'destroy' || command.operation === 'holdInput' || command.operation === 'releaseInput';
  if (request.epoch !== session.epoch && !epochExempt) {
    if (command.operation === 'micGainDb' || command.operation === 'closeTalkThresholdDb' || command.operation === 'denoiseAttenuationLimitDb' || command.operation === 'generalDenoiseAttenuationLimitDb' || command.operation.startsWith('closeTalk')) throw new Error('tellus_capture_cancelled');
    return command.operation === 'capture' || command.operation === 'stop' ? [] : undefined;
  }
  const native = session.native;
  switch (command.operation) {
    case 'authorizationRequest': return native.authorizationRequest(command.conversationId);
    case 'authorizationStatus': return native.json('get_authorization_status');
    case 'applyAuthorization': await native.text('apply_authorization', command.token); return native.json('get_authorization_status');
    case 'invalidate': {
      await native.call('invalidate_authorization');
      const status = await native.json<{ lifecycle: string }>('get_status');
      if (status.lifecycle !== 'stopped') {
        try { await native.stop(); }
        catch (error) { if (!(error instanceof Error && error.message.startsWith('engine_authorization_'))) throw error; }
      }
      return;
    }
    case 'modelRequests': {
      if (session.loaded || session.models.length === 0) return [];
      const request = await native.json<{ public_key: string }>('model_key_request');
      return session.models.map((model) => ({ modelId: model.model_id, keyId: model.key_id, publicKey: request.public_key }));
    }
    case 'modelKeys': await loadModels(session, command); return;
    case 'start': return native.call('start');
    case 'pause': return native.call('pause');
    case 'resume': return native.call('resume');
    case 'reset': return native.call('reset');
    case 'destroy': await native.destroy(); sessions.delete(request.sessionId); return;
    case 'status': {
      const status = await native.json<NativeStatus>('get_status');
      const loadedModels = session.models.map((model) => model.model_id)
        .filter((id) => isVadModel(id) ? status.vad_loaded : status.denoise_loaded);
      // Adds the last failure explanation; null on old engines.
      return { ...status, loadedModels, last_error_message: await native.lastError() } satisfies WorkerStatus;
    }
    case 'denoise': await native.call('set_denoise_enabled', [command.enabled ? 1 : 0]); return command.enabled;
    case 'micGainDb': return native.call('set_mic_gain_db', [validateGainDb(command.db)]);
    case 'closeTalkThresholdDb':
      if (!engine.supports('session_set_close_talk_threshold_db')) throw new Error('tellus_close_talk_threshold_unsupported');
      return native.call('set_close_talk_threshold_db', [validateCloseTalkThresholdDb(command.db)]);
    case 'closeTalkHoldMs':
      if (!engine.supports('session_set_close_talk_hold_ms')) throw new Error('tellus_close_talk_hold_unsupported');
      return native.call('set_close_talk_hold_ms', [validateCloseTalkHoldMs(command.ms)]);
    case 'closeTalkKeepGapDb':
      if (!engine.supports('session_set_close_talk_keep_gap_db')) throw new Error('tellus_close_talk_keep_gap_unsupported');
      return native.call('set_close_talk_keep_gap_db', [validateCloseTalkKeepGapDb(command.db)]);
    case 'closeTalkLevelMarginDb':
      if (!engine.supports('session_set_close_talk_level_margin_db')) throw new Error('tellus_close_talk_level_margin_unsupported');
      return native.call('set_close_talk_level_margin_db', [validateCloseTalkLevelMarginDb(command.db)]);
    case 'closeTalkLevelMinDbfs':
      if (!engine.supports('session_set_close_talk_level_min_dbfs')) throw new Error('tellus_close_talk_level_min_unsupported');
      return native.call('set_close_talk_level_min_dbfs', [validateCloseTalkLevelMinDbfs(command.dbfs)]);
    case 'closeTalkLearnedLevelDbfs': {
      // null goes to the C clear function. NaN sent to the float setter is INVALID_ARGUMENT, not null.
      const dbfs = validateCloseTalkLearnedLevelDbfs(command.dbfs);
      if (!engine.supports(dbfs === null ? 'session_clear_close_talk_learned_level' : 'session_set_close_talk_learned_level_dbfs')) throw new Error('tellus_close_talk_learned_level_unsupported');
      return dbfs === null ? native.call('clear_close_talk_learned_level') : native.call('set_close_talk_learned_level_dbfs', [dbfs]);
    }
    case 'generalDenoiseAttenuationLimitDb': {
      // null goes to the C clear function. NaN sent to the float setter is INVALID_ARGUMENT, not null.
      const db = validateGeneralDenoiseAttenuationLimitDb(command.db);
      if (!engine.supports(db === null ? 'session_clear_general_denoise_attenuation_limit' : 'session_set_general_denoise_attenuation_limit_db')) throw new Error('tellus_general_denoise_attenuation_limit_unsupported');
      return db === null ? native.call('clear_general_denoise_attenuation_limit') : native.call('set_general_denoise_attenuation_limit_db', [db]);
    }
    case 'denoiseAttenuationLimitDb':
      if (!engine.supports('session_set_denoise_attenuation_limit_db')) throw new Error('tellus_denoise_attenuation_limit_unsupported');
      return native.call('set_denoise_attenuation_limit_db', [validateDenoiseAttenuationLimitDb(command.db)]);
    case 'holdInput':
      if (!engine.supports('session_hold_input')) throw new Error('tellus_input_hold_unsupported');
      return native.call('hold_input');
    case 'releaseInput':
      if (!engine.supports('session_release_input')) throw new Error('tellus_input_hold_unsupported');
      return native.call('release_input');
    case 'clearRender': return native.call('clear_render');
    case 'canDeliver': return native.canDeliver(command.nativeEpoch, command.authorizationGeneration);
    case 'render': await native.push(command.samples, command.rate); return;
    case 'capture': {
      if (command.droppedSamples) await native.call('mark_discontinuity', [BigInt(command.droppedSamples)]);
      const chunks = await native.push(command.samples, command.rate, command.timestamp);
      return deliverable(session, request.epoch, chunks);
    }
    case 'stop': {
      const status = await native.json<{ lifecycle: string }>('get_status');
      return status.lifecycle === 'stopped' ? [] : deliverable(session, request.epoch, await native.stop());
    }
  }
}

async function loadModels(session: Session, command: Extract<WorkerCommand, { operation: 'modelKeys' }>): Promise<void> {
  if (session.loaded) throw new Error('tellus_models_already_loaded');
  if (command.keys.length !== session.models.length) throw new Error('tellus_model_keys_mismatch');
  const seen = new Set<string>();
  for (const model of session.models) {
    const key = command.keys.find((item) => item.modelId === model.model_id && item.keyId === model.key_id);
    if (!key || seen.has(key.modelId) || !/^[A-Za-z0-9_-]+$/.test(key.wrappedKey)) throw new Error('tellus_model_keys_mismatch');
    seen.add(key.modelId);
    const decoded = Uint8Array.from(atob(key.wrappedKey.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
    if (decoded.length !== 80) throw new Error('tellus_model_key_invalid');
    await session.native.applyModelKey(key.modelId, key.keyId, decoded);
  }
  for (const model of session.models) {
    try { await session.native.loadModel(model.bytes); }
    catch (error) {
      // Capture continues without denoise if the denoise model fails to load. Only a failure core recorded that way is tolerated; key and container errors still throw.
      if (isVadModel(model.model_id) || !(await session.native.json<NativeStatus>('get_status')).denoise_load_failed) throw error;
      console.warn('tellus_denoise_load_failed: capture continues without denoise', error);
    }
  }
  session.loaded = true;
}

async function deliverable(session: Session, epoch: number, chunks: DeliveredChunk[]): Promise<DeliveredChunk[]> {
  const valid: DeliveredChunk[] = [];
  for (const chunk of chunks) {
    if (session.epoch !== epoch) break;
    if (await session.native.canDeliver(chunk.epoch, chunk.authorizationGeneration)) valid.push(chunk);
  }
  return session.epoch === epoch ? valid : [];
}
