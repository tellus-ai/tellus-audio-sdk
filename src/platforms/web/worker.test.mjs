import assert from 'node:assert/strict';
import test from 'node:test';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
let instances = 0;

// C ABI boundary double. Reports container bytes as model_id and records the configure JSON and loaded models.
// Models in loadFailures fail to load; denoiseLoadFailed is the value core reports in its status.
// closeTalkThreshold and denoiseAttenuationLimit add the wasm exports an engine with each setting has.
function engineModule(configured, { loaded, loadFailures, denoiseLoadFailed, gains, thresholds, limits, closeTalkThreshold, denoiseAttenuationLimit }) {
  const heap = new ArrayBuffer(1 << 20);
  let next = 8;
  const module = {
    HEAPU8: new Uint8Array(heap), HEAPU32: new Uint32Array(heap), HEAPF32: new Float32Array(heap),
    tellusCancellationGeneration: 0,
    _malloc(size) { const pointer = next; next += Math.ceil(Math.max(size, 1) / 8) * 8; return pointer; },
    _free() {}, addFunction: () => 1, removeFunction() {}, UTF8ToString: () => 'native_failed',
    ...(closeTalkThreshold ? { _tellus_audio_session_set_close_talk_threshold_db() {} } : {}),
    ...(denoiseAttenuationLimit ? { _tellus_audio_session_set_denoise_attenuation_limit_db() {} } : {}),
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
      if (name === 'tellus_audio_session_set_mic_gain_db') gains.push([...args]);
      if (name === 'tellus_audio_session_set_close_talk_threshold_db') thresholds.push([...args]);
      if (name === 'tellus_audio_session_set_denoise_attenuation_limit_db') limits.push([...args]);
      if (name === 'tellus_audio_session_model_key_request') reply({ public_key: 'b'.repeat(64) }, args[1], args[3]);
      if (name === 'tellus_audio_session_get_status') {
        reply({ lifecycle: 'stopped', denoise_load_failed: denoiseLoadFailed, denoise_loaded: loaded.includes('denoise-48'), vad_loaded: loaded.includes('vad') }, args[1], args[3]);
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
async function worker(models, { loadFailures = [], denoiseLoadFailed = false, closeTalkThreshold = false, denoiseAttenuationLimit = false } = {}) {
  const responses = new Map();
  const configured = [];
  const loaded = [];
  const gains = [];
  const thresholds = [];
  const limits = [];
  const scope = { postMessage: (response) => {
    const resolve = responses.get(response.id);
    if (typeof resolve !== 'function') throw new Error(`Unexpected worker response: ${response.id}`);
    resolve(response);
  } };
  globalThis.self = scope;
  globalThis.tellusTestEngine = () => engineModule(configured, { loaded, loadFailures, denoiseLoadFailed, gains, thresholds, limits, closeTalkThreshold, denoiseAttenuationLimit });
  globalThis.fetch = async (url) => ({ ok: true, arrayBuffer: async () => encoder.encode(new URL(url).pathname.slice(1).replace('.temc', '')).buffer });
  await import(`../../../platforms/web/runtime/platforms/web/worker.js?instance=${++instances}`);
  let id = 0;
  const send = (sessionId, command, epoch = 0) => new Promise((resolve) => {
    responses.set(++id, resolve);
    scope.onmessage({ data: { id, sessionId, epoch, command } });
  });
  const assets = { engineModuleUrl: moduleUrl('export default (options) => globalThis.tellusTestEngine(options);'),
    wasmUrl: 'https://example.test/engine.wasm', ortModuleUrl: moduleUrl('export const env = { wasm: {} };'),
    ortWasmBaseUrl: 'https://example.test/ort/', encryptedModels: models.map((model) => `https://example.test/${model}.temc`) };
  assert.equal((await send(0, { operation: 'init', assets })).error, undefined);
  return { send, configured, loaded, gains, thresholds, limits, cancel: (sessionId, epoch) => scope.onmessage({ data: { cancel: sessionId, epoch } }) };
}

test('gain settings survive the worker native serializer and explicit auto gain overrides the old opt-in', async () => {
  const { send, configured } = await worker([]);
  for (const config of [{}, { micAgc2Enabled: true }, { micAgc2Enabled: true, micGainDb: -6, autoGainControl: { enabled: false, maxGainDb: 9 } }]) {
    assert.equal((await send(0, { operation: 'create', config })).error, undefined);
  }
  assert.deepEqual(configured.map(c => c.micGainDb), [0, 0, -6]);
  assert.ok(configured.every(c => !('speakerGainDb' in c)), 'microphone C ABI rejects system audio gain fields');
  assert.deepEqual(configured.map(c => c.autoGainControl.enabled), [false, true, false]);
  assert.deepEqual(configured[2].autoGainControl, { enabled: false, maxGainDb: 9, maxOutputNoiseLevelDbfs: -50, maxGainChangeDbPerSecond: 3, headroomDb: 6, peakLevelDbfs: -3 });
});

test('runtime gain reaches the native session only for a valid live capture epoch', async () => {
  const { send, gains, cancel } = await worker([]);
  const { result: id } = await send(0, { operation: 'create', config: {} });
  assert.equal((await send(id, { operation: 'micGainDb', db: -6 })).error, undefined);
  assert.deepEqual(gains, [[7, -6]]);
  assert.match((await send(id, { operation: 'micGainDb', db: Infinity })).error, /gain.*invalid|invalid.*gain/);
  cancel(id, 1);
  assert.match((await send(id, { operation: 'micGainDb', db: 2 })).error, /tellus_capture_cancelled/);
  assert.deepEqual(gains, [[7, -6]]);
  await send(id, { operation: 'micGainDb', db: 3 }, 1);
  assert.deepEqual(gains, [[7, -6], [7, 3]]);
  await send(id, { operation: 'destroy' }, 1);
  assert.match((await send(id, { operation: 'micGainDb', db: 4 }, 1)).error, /capture_disposed/);
});

test('runtime close-talk threshold reaches the native session only for a valid live capture epoch', async () => {
  const { send, configured, thresholds, cancel } = await worker([], { closeTalkThreshold: true });
  const { result: id } = await send(0, { operation: 'create', config: { closeTalkThresholdDb: 25 } });
  assert.ok(!('closeTalkThresholdDb' in configured[0]), 'configure JSON stays readable by engines without the key');
  assert.equal((await send(id, { operation: 'closeTalkThresholdDb', db: 25 })).error, undefined);
  assert.deepEqual(thresholds, [[7, 25]]);
  cancel(id, 1);
  assert.match((await send(id, { operation: 'closeTalkThresholdDb', db: 22 })).error, /tellus_capture_cancelled/);
  assert.deepEqual(thresholds, [[7, 25]]);
});

test('an engine without the close-talk threshold export rejects the change without calling native', async () => {
  const { send, thresholds } = await worker([]);
  const { result: id } = await send(0, { operation: 'create', config: {} });
  assert.match((await send(id, { operation: 'closeTalkThresholdDb', db: 25 })).error, /tellus_close_talk_threshold_unsupported/);
  assert.deepEqual(thresholds, []);
});

test('runtime denoise attenuation limit reaches the native session only for a valid live capture epoch', async () => {
  const { send, configured, limits, cancel } = await worker([], { denoiseAttenuationLimit: true });
  const { result: id } = await send(0, { operation: 'create', config: { denoiseAttenuationLimitDb: 6 } });
  assert.ok(!('denoiseAttenuationLimitDb' in configured[0]), 'configure JSON stays readable by engines without the key');
  assert.equal((await send(id, { operation: 'denoiseAttenuationLimitDb', db: 6 })).error, undefined);
  assert.deepEqual(limits, [[7, 6]]);
  cancel(id, 1);
  assert.match((await send(id, { operation: 'denoiseAttenuationLimitDb', db: 9 })).error, /tellus_capture_cancelled/);
  assert.deepEqual(limits, [[7, 6]]);
});

test('an engine without the denoise attenuation limit export rejects the change without calling native', async () => {
  const { send, thresholds, limits } = await worker([], { closeTalkThreshold: true });
  const { result: id } = await send(0, { operation: 'create', config: {} });
  assert.match((await send(id, { operation: 'denoiseAttenuationLimitDb', db: 6 })).error, /tellus_denoise_attenuation_limit_unsupported/);
  assert.deepEqual(limits, []);
  assert.equal((await send(id, { operation: 'closeTalkThresholdDb', db: 25 })).error, undefined);
  assert.deepEqual(thresholds, [[7, 25]], 'each setting checks its own export');
});

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
  const { send } = await worker(['denoise-48', 'vad']);
  for (const [config, expected] of [
    [{ vadEnabled: true }, ['denoise-48', 'vad']],
    [{ processing: { sampleRate: 48000 } }, ['denoise-48']],
    [{ denoiseMode: 'general', vadEnabled: true }, ['denoise-48', 'vad']],
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
  const { send, configured } = await worker(['vad']);
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
  const { send, configured } = await worker(['denoise-48', 'vad']);
  assert.equal((await send(0, { operation: 'create', config: { denoiseMode: 'rnnoise' } })).error, 'tellus_denoise_mode_invalid');
  assert.deepEqual(configured, []);
});

test('a denoise model load failure logs, still loads the VAD model and leaves nothing to retry', async () => {
  const { send, loaded } = await worker(['denoise-48', 'vad'], { loadFailures: ['denoise-48'], denoiseLoadFailed: true });
  const { result: sessionId } = await send(0, { operation: 'create', config: { denoiseEnabled: true, vadEnabled: true } });
  let applied;
  const logged = await warnings(async () => { applied = await applyKeys(send, sessionId); });
  assert.equal(applied.error, undefined);
  assert.deepEqual(loaded, ['vad']);
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
  const { send } = await worker(['denoise-48', 'vad'], { loadFailures: ['denoise-48', 'vad'], denoiseLoadFailed: true });
  const { result: sessionId } = await send(0, { operation: 'create', config: { denoiseEnabled: true, vadEnabled: true } });
  let applied;
  await warnings(async () => { applied = await applyKeys(send, sessionId); });
  assert.equal(applied.error, 'native_failed');
});

test('status reports only the models native loaded, by their container IDs', async () => {
  const { send } = await worker(['denoise-48', 'vad'], { loadFailures: ['denoise-48'], denoiseLoadFailed: true });
  const { result: sessionId } = await send(0, { operation: 'create', config: { denoiseEnabled: true, vadEnabled: true } });
  assert.deepEqual((await send(sessionId, { operation: 'status' })).result.loadedModels, []);
  await warnings(() => applyKeys(send, sessionId));
  assert.deepEqual((await send(sessionId, { operation: 'status' })).result.loadedModels, ['vad']);
});

test('an invalid output config never reaches native configuration', async () => {
  const { send, configured } = await worker(['denoise-48', 'vad']);
  assert.equal((await send(0, { operation: 'create', config: { processing: { chunkDurationMs: 10 } } })).error, 'tellus_processing_config_invalid');
  assert.equal((await send(0, { operation: 'create', config: { processing: { sampleRate: 44100 } } })).error, 'tellus_opus_sample_rate_unsupported');
  assert.deepEqual(configured, []);
});
