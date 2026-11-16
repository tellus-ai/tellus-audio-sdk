import assert from 'node:assert/strict';
import test from 'node:test';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
let instances = 0;

// C ABI boundary double. Reports container bytes as model_id and records the configure JSON and loaded models.
// Models in loadFailures fail to load; denoiseLoadFailed is the value core reports in its status.
// closeTalkThreshold and denoiseAttenuationLimit add the wasm exports an engine with each setting has.
function engineModule(configured, { loaded, loadFailures, denoiseLoadFailed, gains, thresholds, limits, closeTalkThreshold, denoiseAttenuationLimit, inputHold, holds, tuning, tuningCalls, lastError, failStart }) {
  const heap = new ArrayBuffer(1 << 20);
  let next = 8;
  const module = {
    HEAPU8: new Uint8Array(heap), HEAPU32: new Uint32Array(heap), HEAPF32: new Float32Array(heap),
    tellusCancellationGeneration: 0,
    _malloc(size) { const pointer = next; next += Math.ceil(Math.max(size, 1) / 8) * 8; return pointer; },
    _free() {}, addFunction: () => 1, removeFunction() {}, UTF8ToString: () => 'native_failed',
    ...(closeTalkThreshold ? { _tellus_audio_session_set_close_talk_threshold_db() {} } : {}),
    ...(denoiseAttenuationLimit ? { _tellus_audio_session_set_denoise_attenuation_limit_db() {} } : {}),
    ...Object.fromEntries((tuning ?? []).map((name) => [`_tellus_audio_session_${name}`, () => {}])),
    ...(inputHold ? { _tellus_audio_session_hold_input() {}, _tellus_audio_session_release_input() {} } : {}),
    ...(lastError === undefined ? {} : { _tellus_audio_session_copy_last_error() {} }),
    ccall(name, _returnType, _argumentTypes, args) {
      const text = (pointer, length) => decoder.decode(module.HEAPU8.subarray(pointer, pointer + length));
      const reply = (value, output, written) => {
        const bytes = encoder.encode(JSON.stringify(value));
        module.HEAPU8.set(bytes, output);
        module.HEAPU32[written / 4] = bytes.length;
      };
      if (name === 'tellus_audio_session_start' && failStart) return 3;
      if (name === 'tellus_audio_session_copy_last_error') {
        const bytes = encoder.encode(lastError);
        module.HEAPU8.set([...bytes, 0], args[1]);
        return bytes.length;
      }
      if (name === 'tellus_audio_model_container_inspect') reply({ model_id: text(args[0], args[1]), key_id: 'release-1' }, args[2], args[4]);
      if (name === 'tellus_audio_session_create') module.HEAPU32[args[0] / 4] = 7;
      if (name === 'tellus_audio_session_configure') configured.push(JSON.parse(text(args[1], args[2])));
      if (name === 'tellus_audio_session_hold_input' || name === 'tellus_audio_session_release_input') holds.push([name, ...args]);
      if (name === 'tellus_audio_session_set_mic_gain_db') gains.push([...args]);
      if (/^tellus_audio_session_(set_close_talk_(hold_ms|keep_gap_db|level_margin_db|level_min_dbfs|learned_level_dbfs)|clear_close_talk_learned_level|set_general_denoise_attenuation_limit_db|clear_general_denoise_attenuation_limit)$/.test(name)) tuningCalls.push([name.slice('tellus_audio_session_'.length), ...args.slice(1)]);
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
async function worker(models, { loadFailures = [], denoiseLoadFailed = false, closeTalkThreshold = false, denoiseAttenuationLimit = false, inputHold = false, tuning = [], lastError, failStart = false } = {}) {
  const responses = new Map();
  const configured = [];
  const loaded = [];
  const gains = [];
  const thresholds = [];
  const limits = [];
  const holds = [];
  const tuningCalls = [];
  const scope = { postMessage: (response) => {
    const resolve = responses.get(response.id);
    if (typeof resolve !== 'function') throw new Error(`Unexpected worker response: ${response.id}`);
    resolve(response);
  } };
  globalThis.self = scope;
  globalThis.tellusTestEngine = () => engineModule(configured, { loaded, loadFailures, denoiseLoadFailed, gains, thresholds, limits, closeTalkThreshold, denoiseAttenuationLimit, inputHold, holds, tuning, tuningCalls, lastError, failStart });
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
  return { send, configured, loaded, gains, thresholds, limits, holds, tuningCalls, cancel: (sessionId, epoch) => scope.onmessage({ data: { cancel: sessionId, epoch } }) };
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

test('input hold and release reach the native session when the engine exports them', async () => {
  const { send, holds } = await worker([], { inputHold: true });
  const { result: id } = await send(0, { operation: 'create', config: {} });
  assert.equal((await send(id, { operation: 'holdInput' })).error, undefined);
  assert.equal((await send(id, { operation: 'releaseInput' })).error, undefined);
  assert.deepEqual(holds, [['tellus_audio_session_hold_input', 7], ['tellus_audio_session_release_input', 7]]);
});

// Mutation to catch: restoring the stale-epoch rejection for either command turns the next two tests RED.
test('a hold request from a previous epoch is not cancelled and reaches native', async () => {
  const { send, holds } = await worker([], { inputHold: true });
  const { result: id } = await send(0, { operation: 'create', config: {} });
  assert.equal((await send(id, { operation: 'holdInput' }, 3)).error, undefined);
  assert.deepEqual(holds, [['tellus_audio_session_hold_input', 7]]);
});

test('a release request from a previous epoch is not cancelled and reaches native', async () => {
  const { send, holds } = await worker([], { inputHold: true });
  const { result: id } = await send(0, { operation: 'create', config: {} });
  assert.equal((await send(id, { operation: 'releaseInput' }, 3)).error, undefined);
  assert.deepEqual(holds, [['tellus_audio_session_release_input', 7]]);
});

test('an engine without the input hold exports rejects hold and release without calling native', async () => {
  const { send, holds } = await worker([]);
  const { result: id } = await send(0, { operation: 'create', config: {} });
  assert.match((await send(id, { operation: 'holdInput' })).error, /^tellus_input_hold_unsupported$/);
  assert.match((await send(id, { operation: 'releaseInput' })).error, /^tellus_input_hold_unsupported$/);
  assert.deepEqual(holds, []);
});

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

const TUNING_EXPORTS = ['set_close_talk_hold_ms', 'set_close_talk_keep_gap_db', 'set_close_talk_level_margin_db', 'set_close_talk_level_min_dbfs', 'set_close_talk_learned_level_dbfs', 'clear_close_talk_learned_level'];

test('close_talk 튜닝 setter는 export가 있으면 검증 후 native에 전달되고 이전 epoch 요청은 취소된다', async () => {
  const { send, configured, tuningCalls } = await worker([], { tuning: TUNING_EXPORTS.map((name) => name) });
  const { result: id } = await send(0, { operation: 'create', config: { closeTalkHoldMs: 300, closeTalkLearnedLevelDbfs: -40 } });
  for (const key of ['closeTalkHoldMs', 'closeTalkKeepGapDb', 'closeTalkLevelMarginDb', 'closeTalkLevelMinDbfs', 'closeTalkLearnedLevelDbfs']) assert.ok(!(key in configured[0]), `${key}는 configure JSON에 들어가지 않는다`);
  for (const command of [
    { operation: 'closeTalkHoldMs', ms: 300 }, { operation: 'closeTalkKeepGapDb', db: 5 }, { operation: 'closeTalkLevelMarginDb', db: 3 },
    { operation: 'closeTalkLevelMinDbfs', dbfs: -32 }, { operation: 'closeTalkLearnedLevelDbfs', dbfs: -40 }, { operation: 'closeTalkLearnedLevelDbfs', dbfs: null },
  ]) assert.equal((await send(id, command)).error, undefined);
  assert.deepEqual(tuningCalls, [['set_close_talk_hold_ms', 300], ['set_close_talk_keep_gap_db', 5], ['set_close_talk_level_margin_db', 3], ['set_close_talk_level_min_dbfs', -32], ['set_close_talk_learned_level_dbfs', -40], ['clear_close_talk_learned_level']]);
  for (const command of [{ operation: 'closeTalkHoldMs', ms: 300 }, { operation: 'closeTalkKeepGapDb', db: 5 }, { operation: 'closeTalkLevelMarginDb', db: 3 }, { operation: 'closeTalkLevelMinDbfs', dbfs: -32 }, { operation: 'closeTalkLearnedLevelDbfs', dbfs: null }]) {
    assert.match((await send(id, command, 1)).error, /tellus_capture_cancelled/);
  }
  for (const [command, pattern] of [
    [{ operation: 'closeTalkHoldMs', ms: 2001 }, /invalid_close_talk_hold_ms: expected a finite value within 0\.\.=2000/],
    [{ operation: 'closeTalkKeepGapDb', db: 21 }, /invalid_close_talk_keep_gap_db: expected a finite value within 0\.\.=20/],
    [{ operation: 'closeTalkLevelMarginDb', db: -1 }, /invalid_close_talk_level_margin_db: expected a finite value within 0\.\.=20/],
    [{ operation: 'closeTalkLevelMinDbfs', dbfs: -101 }, /invalid_close_talk_level_min_dbfs: expected a finite value within -100\.\.=0/],
    [{ operation: 'closeTalkLevelMinDbfs', dbfs: undefined }, /invalid_close_talk_level_min_dbfs/],
    [{ operation: 'closeTalkLearnedLevelDbfs', dbfs: 1 }, /invalid_close_talk_learned_level_dbfs: expected a finite value within -100\.\.=0 or null/],
    [{ operation: 'closeTalkLearnedLevelDbfs', dbfs: Number.NaN }, /invalid_close_talk_learned_level_dbfs/],
  ]) assert.match((await send(id, command)).error, pattern);
  assert.equal(tuningCalls.length, 6);
});

test('general 모드 감쇠 한도 setter는 값은 set, null은 clear로 보내고 검증·취소·미지원을 처리한다', async () => {
  const { send, tuningCalls } = await worker([], { tuning: ['set_general_denoise_attenuation_limit_db', 'clear_general_denoise_attenuation_limit'] });
  const { result: id } = await send(0, { operation: 'create', config: {} });
  for (const db of [6, 0, 60, null]) assert.equal((await send(id, { operation: 'generalDenoiseAttenuationLimitDb', db })).error, undefined);
  assert.deepEqual(tuningCalls, [['set_general_denoise_attenuation_limit_db', 6], ['set_general_denoise_attenuation_limit_db', 0], ['set_general_denoise_attenuation_limit_db', 60], ['clear_general_denoise_attenuation_limit']]);
  assert.match((await send(id, { operation: 'generalDenoiseAttenuationLimitDb', db: null }, 1)).error, /tellus_capture_cancelled/);
  for (const db of [-1, 61, Number.NaN, '6', undefined]) assert.match((await send(id, { operation: 'generalDenoiseAttenuationLimitDb', db })).error, /invalid_general_denoise_attenuation_limit_db: expected a finite value within 0\.\.=60 or null/);
  assert.equal(tuningCalls.length, 4);
  const old = await worker([]);
  const { result: other } = await old.send(0, { operation: 'create', config: {} });
  for (const db of [6, null]) assert.match((await old.send(other, { operation: 'generalDenoiseAttenuationLimitDb', db })).error, /tellus_general_denoise_attenuation_limit_unsupported/);
  assert.deepEqual(old.tuningCalls, []);
});

test('close_talk 튜닝 export가 없는 엔진은 native 호출 없이 각 setter를 거부한다', async () => {
  const { send, tuningCalls } = await worker([], { tuning: ['set_close_talk_hold_ms'] });
  const { result: id } = await send(0, { operation: 'create', config: {} });
  assert.equal((await send(id, { operation: 'closeTalkHoldMs', ms: 250 })).error, undefined);
  assert.match((await send(id, { operation: 'closeTalkKeepGapDb', db: 4 })).error, /tellus_close_talk_keep_gap_unsupported/);
  assert.match((await send(id, { operation: 'closeTalkLevelMarginDb', db: 2 })).error, /tellus_close_talk_level_margin_unsupported/);
  assert.match((await send(id, { operation: 'closeTalkLevelMinDbfs', dbfs: -32 })).error, /tellus_close_talk_level_min_unsupported/);
  assert.match((await send(id, { operation: 'closeTalkLearnedLevelDbfs', dbfs: -40 })).error, /tellus_close_talk_learned_level_unsupported/);
  assert.match((await send(id, { operation: 'closeTalkLearnedLevelDbfs', dbfs: null })).error, /tellus_close_talk_learned_level_unsupported/);
  const none = await worker([]);
  const { result: other } = await none.send(0, { operation: 'create', config: {} });
  assert.match((await none.send(other, { operation: 'closeTalkHoldMs', ms: 250 })).error, /tellus_close_talk_hold_unsupported/);
  assert.deepEqual(tuningCalls, [['set_close_talk_hold_ms', 250]]);
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

test('worker errors keep the status name prefix, append the engine explanation, and status carries last_error_message', async () => {
  const { send } = await worker([], { lastError: 'panic: pipeline exploded', failStart: true });
  const { result: id } = await send(0, { operation: 'create', config: {} });
  assert.equal((await send(id, { operation: 'start' })).error, 'native_failed: panic: pipeline exploded');
  assert.equal((await send(id, { operation: 'status' })).result.last_error_message, 'panic: pipeline exploded');
});

test('an engine without the copy_last_error export throws only the status name and reports a null last_error_message', async () => {
  const { send } = await worker([], { failStart: true });
  const { result: id } = await send(0, { operation: 'create', config: {} });
  assert.equal((await send(id, { operation: 'start' })).error, 'native_failed');
  assert.equal((await send(id, { operation: 'status' })).result.last_error_message, null);
});
