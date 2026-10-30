import assert from 'node:assert/strict';
import test from 'node:test';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
let instances = 0;

// C ABI boundary double. Reports container bytes as model_id and records the configure JSON and loaded models.
// Models in loadFailures fail to load; denoiseLoadFailed is the value core reports in its status.
function engineModule(configured, { loaded, loadFailures, denoiseLoadFailed }) {
  const heap = new ArrayBuffer(1 << 20);
  let next = 8;
  const module = {
    HEAPU8: new Uint8Array(heap), HEAPU32: new Uint32Array(heap), HEAPF32: new Float32Array(heap),
    tellusCancellationGeneration: 0,
    _malloc(size) { const pointer = next; next += Math.ceil(Math.max(size, 1) / 8) * 8; return pointer; },
    _free() {}, addFunction: () => 1, removeFunction() {}, UTF8ToString: () => 'native_failed',
    ccall(name, _returnType, _argumentTypes, args) {
      const text = (pointer, length) => decoder.decode(module.HEAPU8.subarray(pointer, pointer + length));
      const reply = (value, output, written) => {
        const bytes = encoder.encode(JSON.stringify(value));
        module.HEAPU8.set(bytes, output);
        module.HEAPU32[written / 4] = bytes.length;
      };
      if (name === 'tellus_audio_model_container_inspect') reply({ model_id: text(args[0], args[1]), key_id: 'release-1' }, args[2], args[4]);
      if (name === 'tellus_audio_session_create') module.HEAPU32[args[0] / 4] = 7;
      if (name === 'tellus_audio_session_configure') configured.push(JSON.parse(text(args[1], args[2])));
      if (name === 'tellus_audio_session_model_key_request') reply({ public_key: 'b'.repeat(64) }, args[1], args[3]);
      if (name === 'tellus_audio_session_get_status') {
        reply({ lifecycle: 'stopped', denoise_load_failed: denoiseLoadFailed, denoise_loaded: loaded.includes('denoise-48'), vad_loaded: loaded.includes('silero-vad') }, args[1], args[3]);
      }
      if (name === 'tellus_audio_session_load_model') {
        const model = text(args[1], args[2]);
        if (loadFailures.includes(model)) return 28;
        loaded.push(model);
      }
      return 0;
    },
  };
  return module;
}

// Runs the worker module on a fresh worker global and initializes it with only the given encrypted models.
async function worker(models, { loadFailures = [], denoiseLoadFailed = false } = {}) {
  const responses = new Map();
  const configured = [];
  const loaded = [];
  const scope = { postMessage: (response) => {
    const resolve = responses.get(response.id);
    if (typeof resolve !== 'function') throw new Error(`Unexpected worker response: ${response.id}`);
    resolve(response);
  } };
  globalThis.self = scope;
  globalThis.tellusTestEngine = () => engineModule(configured, { loaded, loadFailures, denoiseLoadFailed });
  globalThis.fetch = async (url) => ({ ok: true, arrayBuffer: async () => encoder.encode(new URL(url).pathname.slice(1).replace('.temc', '')).buffer });
  await import(`../../../platforms/web/runtime/platforms/web/worker.js?instance=${++instances}`);
  let id = 0;
  const send = (sessionId, command) => new Promise((resolve) => {
    responses.set(++id, resolve);
    scope.onmessage({ data: { id, sessionId, epoch: 0, command } });
  });
  const assets = { engineModuleUrl: moduleUrl('export default (options) => globalThis.tellusTestEngine(options);'),
    wasmUrl: 'https://example.test/engine.wasm', ortModuleUrl: moduleUrl('export const env = { wasm: {} };'),
    ortWasmBaseUrl: 'https://example.test/ort/', encryptedModels: models.map((model) => `https://example.test/${model}.temc`) };
  assert.equal((await send(0, { operation: 'init', assets })).error, undefined);
  return { send, configured, loaded };
}

// Builds wrapped keys from the modelRequests response and passes them to the worker.
async function applyKeys(send, sessionId) {
  const { result: requests } = await send(sessionId, { operation: 'modelRequests' });
  return send(sessionId, { operation: 'modelKeys', keys: requests.map(({ modelId, keyId }) => ({ modelId, keyId, wrappedKey: 'A'.repeat(107) })) });
}

// Collects console.warn calls and restores the original afterwards.
async function warnings(body) {
  const original = console.warn;
  const logged = [];
  console.warn = (...args) => { logged.push(args); };
  try { await body(); } finally { console.warn = original; }
  return logged;
}

test('each capture requests the denoise container for every mode and the VAD model only with VAD', async () => {
  const { send } = await worker(['denoise-48', 'silero-vad']);
  for (const [config, expected] of [
    [{ vadEnabled: true }, ['denoise-48', 'silero-vad']],
    [{ processing: { sampleRate: 48000 } }, ['denoise-48']],
    [{ denoiseMode: 'general', vadEnabled: true }, ['denoise-48', 'silero-vad']],
    [{ denoiseMode: 'CLOSE_TALK', processing: { sampleRate: 48000 } }, ['denoise-48']],
  ]) {
    const { result: sessionId } = await send(0, { operation: 'create', config });
    const { result: requests } = await send(sessionId, { operation: 'modelRequests' });
    assert.deepEqual(requests.map((request) => request.modelId), expected, JSON.stringify(config));
  }
});

test('the normalized denoise mode reaches native configuration', async () => {
  const { send, configured } = await worker(['denoise-48']);
  await send(0, { operation: 'create', config: {} });
  await send(0, { operation: 'create', config: { denoiseMode: ' General ' } });
  assert.deepEqual(configured.map((config) => config.denoiseMode), ['close_talk', 'general']);
});

test('an enabled capture without a denoise container fails before configuring native', async () => {
  const { send, configured } = await worker(['silero-vad']);
  const created = await send(0, { operation: 'create', config: { denoiseEnabled: true } });
  assert.equal(created.error, 'tellus_encrypted_model_missing');
  assert.deepEqual(configured, []);
});

test('a VAD capture without the VAD model fails before configuring native', async () => {
  const { send, configured } = await worker(['denoise-48']);
  const created = await send(0, { operation: 'create', config: { vadEnabled: true } });
  assert.equal(created.error, 'tellus_encrypted_model_missing');
  assert.deepEqual(configured, []);
});

test('an unknown denoise mode never reaches native configuration', async () => {
  const { send, configured } = await worker(['denoise-48', 'silero-vad']);
  assert.equal((await send(0, { operation: 'create', config: { denoiseMode: 'rnnoise' } })).error, 'tellus_denoise_mode_invalid');
  assert.deepEqual(configured, []);
});

test('a denoise model load failure logs, still loads the VAD model and leaves nothing to retry', async () => {
  const { send, loaded } = await worker(['denoise-48', 'silero-vad'], { loadFailures: ['denoise-48'], denoiseLoadFailed: true });
  const { result: sessionId } = await send(0, { operation: 'create', config: { denoiseEnabled: true, vadEnabled: true } });
  let applied;
  const logged = await warnings(async () => { applied = await applyKeys(send, sessionId); });
  assert.equal(applied.error, undefined);
  assert.deepEqual(loaded, ['silero-vad']);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /tellus_denoise_load_failed/);
  assert.deepEqual((await send(sessionId, { operation: 'modelRequests' })).result, []);
});

test('a load error native did not record as a denoise load failure rejects the keys', async () => {
  const { send } = await worker(['denoise-48'], { loadFailures: ['denoise-48'], denoiseLoadFailed: false });
  const { result: sessionId } = await send(0, { operation: 'create', config: { denoiseEnabled: true } });
  assert.equal((await applyKeys(send, sessionId)).error, 'native_failed');
});

test('a VAD model load failure rejects the keys even after the denoise model failed softly', async () => {
  const { send } = await worker(['denoise-48', 'silero-vad'], { loadFailures: ['denoise-48', 'silero-vad'], denoiseLoadFailed: true });
  const { result: sessionId } = await send(0, { operation: 'create', config: { denoiseEnabled: true, vadEnabled: true } });
  let applied;
  await warnings(async () => { applied = await applyKeys(send, sessionId); });
  assert.equal(applied.error, 'native_failed');
});

test('status reports only the models native loaded, by their container IDs', async () => {
  const { send } = await worker(['denoise-48', 'silero-vad'], { loadFailures: ['denoise-48'], denoiseLoadFailed: true });
  const { result: sessionId } = await send(0, { operation: 'create', config: { denoiseEnabled: true, vadEnabled: true } });
  assert.deepEqual((await send(sessionId, { operation: 'status' })).result.loadedModels, []);
  await warnings(() => applyKeys(send, sessionId));
  assert.deepEqual((await send(sessionId, { operation: 'status' })).result.loadedModels, ['silero-vad']);
});

test('an invalid output config never reaches native configuration', async () => {
  const { send, configured } = await worker(['denoise-48', 'silero-vad']);
  assert.equal((await send(0, { operation: 'create', config: { processing: { chunkDurationMs: 10 } } })).error, 'tellus_processing_config_invalid');
  assert.equal((await send(0, { operation: 'create', config: { processing: { sampleRate: 44100 } } })).error, 'tellus_opus_sample_rate_unsupported');
  assert.deepEqual(configured, []);
});
