import type { AudioCaptureConfig, BrowserEngineAssets } from '../platform/capture-types.js';
import { NativeEngine, type EngineModule, type NativeCapture } from './native.js';
import type { DeliveredChunk, WorkerCommand, WorkerRequest, WorkerResponse } from './protocol.js';

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
  // Asyncify는 재진입할 수 없다. ORT 추론 대기 중에도 위 취소 처리는 즉시 실행된다.
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
  const ortUrl = assets.ortModuleUrl ?? new URL('ort.wasm.bundle.min.mjs', assets.ortWasmBaseUrl).href;
  const ort = await import(/* @vite-ignore */ ortUrl);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = assets.ortWasmBaseUrl;
  const imported = await import(/* @vite-ignore */ assets.engineModuleUrl);
  if (typeof imported.default !== 'function') throw new Error('tellus_engine_module_invalid');
  const module: EngineModule = await imported.default({
    locateFile: (name: string) => name.endsWith('.wasm') ? assets.wasmUrl : new URL(name, assets.engineModuleUrl).href,
    tellusOrt: ort, tellusOrtWasmBaseUrl: assets.ortWasmBaseUrl, tellusCancellationGeneration: 0,
  });
  engine = new NativeEngine(module);
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

function requiredModels(config: AudioCaptureConfig): EncryptedModel[] {
  const family = (config.processing?.sampleRate ?? 16000) === 16000 ? 'fe-s16' : 'fe-s48';
  const selected = models.filter((model) => model.model_id === family || config.vadEnabled && model.model_id === 'silero-vad');
  for (const required of [config.denoiseEnabled ? family : undefined, config.vadEnabled ? 'silero-vad' : undefined]) {
    if (required && !selected.some((model) => model.model_id === required)) throw new Error('tellus_encrypted_model_missing');
  }
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
  if (request.epoch !== session.epoch && command.operation !== 'invalidate' && command.operation !== 'destroy') {
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
    case 'status': return native.json('get_status');
    case 'denoise': await native.call('set_denoise_enabled', [command.enabled ? 1 : 0]); return command.enabled;
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
  for (const model of session.models) await session.native.loadModel(model.bytes);
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
