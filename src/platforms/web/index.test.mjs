import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioEngine, listAudioDevices } from '../../../platforms/web/runtime/platforms/web/index.js';
import { NativeEngine } from '../../../platforms/web/runtime/platforms/web/native.js';
import { outputSampleRate } from '../../../platforms/web/runtime/platforms/web/protocol.js';

const assets = { engineModuleUrl: 'engine.mjs', wasmUrl: 'engine.wasm', ortWasmBaseUrl: 'ort/', encryptedModels: [] };

function environment(setSinkId) {
  const contexts = [];
  const workers = [];
  globalThis.document = { baseURI: 'https://example.test/', addEventListener() {}, removeEventListener() {} };
  globalThis.AudioContext = class {
    constructor() { contexts.push(this); }
    sinkId = '';
    setSinkId = setSinkId;
    audioWorklet = { addModule: async () => {} };
    async close() { this.closed = true; }
  };
  globalThis.Worker = class {
    constructor() { workers.push(this); }
    postMessage(message) {
      if (!message.command) return;
      const value = message.command.operation === 'create' ? 1 : message.command.operation === 'status' ? {} : undefined;
      queueMicrotask(() => this.onmessage({ data: { id: message.id, result: value } }));
    }
    terminate() { this.terminated = true; }
  };
  return { contexts, workers };
}

test('an explicit output is applied once to the shared context and reported by every capture', async () => {
  const selected = [];
  const { contexts } = environment(async function (id) { selected.push(id); this.sinkId = id; });
  const engine = await AudioEngine.init({ playbackDeviceId: 'speaker-b' }, assets);
  const first = engine.createCapture();
  const second = engine.createCapture();
  assert.deepEqual(selected, ['speaker-b']);
  assert.equal(contexts.length, 1);
  assert.deepEqual((await first.getStatus()).deviceStatus, [{ source: 'microphone', code: 'pending' }, { source: 'playback', code: 'ready', requestedDeviceId: 'speaker-b', actualDeviceId: 'speaker-b' }]);
  assert.deepEqual((await second.getStatus()).deviceStatus, (await first.getStatus()).deviceStatus);
  await engine.dispose();
});

test('an unsupported explicit output rejects with status and closes init resources', async () => {
  const { contexts, workers } = environment();
  await assert.rejects(AudioEngine.init({ playbackDeviceId: 'speaker-b' }, assets), (error) => error.deviceStatus?.code === 'unsupported');
  assert.equal(contexts[0].closed, true);
  assert.equal(workers[0].terminated, true);
});

test('a denied output rejects with permission state and closes init resources', async () => {
  const { contexts, workers } = environment(async () => { throw new DOMException('denied', 'NotAllowedError'); });
  await assert.rejects(AudioEngine.init({ playbackDeviceId: 'speaker-b' }, assets), (error) => {
    assert.deepEqual(error.deviceStatus, { source: 'playback', code: 'permission_denied', requestedDeviceId: 'speaker-b' });
    return true;
  });
  assert.equal(contexts[0].closed, true);
  assert.equal(workers[0].terminated, true);
});

test('an actual output mismatch never falls back to the default output', async () => {
  const { contexts, workers } = environment(async function () { this.sinkId = 'speaker-a'; });
  await assert.rejects(AudioEngine.init({ playbackDeviceId: 'speaker-b' }, assets), (error) => error.deviceStatus?.code === 'route_mismatch');
  assert.equal(contexts[0].closed, true);
  assert.equal(workers[0].terminated, true);
});

test('an empty output ID is rejected before attempting default output selection', async () => {
  let selections = 0;
  const { contexts } = environment(async () => { selections++; });
  await assert.rejects(AudioEngine.init({ playbackDeviceId: '' }, assets), (error) => error.deviceStatus?.code === 'unavailable');
  assert.equal(selections, 0);
  assert.equal(contexts[0].closed, true);
});

test('browser init rejects selectors belonging to unsupported platform sources', async () => {
  environment();
  await assert.rejects(AudioEngine.init({ systemAudioDeviceId: 'sink-b' }, assets), (error) => error.deviceStatus?.source === 'system_audio' && error.deviceStatus.code === 'unsupported');
  await assert.rejects(AudioEngine.init({ iosOutputRoute: 'speaker' }, assets), (error) => error.deviceStatus?.source === 'playback' && error.deviceStatus.code === 'unsupported');
});

test('invalid microphone IDs are rejected by init before a capture is created', async () => {
  const { contexts, workers } = environment();
  for (const micDeviceId of ['', '   ', 7, null]) {
    await assert.rejects(AudioEngine.init({ micDeviceId }, assets), (error) => error.deviceStatus?.source === 'microphone' && error.deviceStatus.code === 'unavailable');
  }
  assert.ok(contexts.every((context) => context.closed));
  assert.ok(workers.every((worker) => worker.terminated));
});

test('device enumeration returns actual visible IDs and labels without prompting for permission', async () => {
  let requests = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia() { requests++; throw new Error('permission_must_not_be_requested'); },
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'mic-b', label: '' },
      { kind: 'audioinput', deviceId: '', label: 'hidden' },
      { kind: 'audiooutput', deviceId: 'speaker-b', label: 'USB speaker' },
      { kind: 'videoinput', deviceId: 'camera-b', label: 'camera' },
    ],
  } } });
  assert.deepEqual(await listAudioDevices('microphone'), { status: { source: 'microphone', code: 'ready' }, devices: [{ id: 'mic-b', label: '' }] });
  assert.deepEqual(await listAudioDevices('playback'), { status: { source: 'playback', code: 'ready' }, devices: [{ id: 'speaker-b', label: 'USB speaker' }] });
  assert.deepEqual(await listAudioDevices('system_audio'), { status: { source: 'system_audio', code: 'unsupported' }, devices: [] });
  assert.equal(requests, 0);
});

test('device enumeration distinguishes denied and unsupported access from a normal empty list', async () => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    enumerateDevices: async () => { throw new DOMException('denied', 'NotAllowedError'); },
  } } });
  assert.deepEqual(await listAudioDevices('microphone'), { status: { source: 'microphone', code: 'permission_denied' }, devices: [] });
  navigator.mediaDevices.enumerateDevices = async () => [];
  assert.deepEqual(await listAudioDevices('microphone'), { status: { source: 'microphone', code: 'ready' }, devices: [] });
  delete navigator.mediaDevices;
  assert.deepEqual(await listAudioDevices('microphone'), { status: { source: 'microphone', code: 'unsupported' }, devices: [] });
});

test('an invalid device source cannot enumerate audio outputs', async () => {
  let enumerations = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    enumerateDevices: async () => { enumerations++; return []; },
  } } });
  await assert.rejects(listAudioDevices('camera'), /tellus_audio_device_source_invalid/);
  assert.equal(enumerations, 0);
});

test('device selectors never enter the Rust processing configuration', async () => {
  const heap = new ArrayBuffer(4096);
  let next = 4;
  let configured;
  const module = {
    HEAPU8: new Uint8Array(heap), HEAPU32: new Uint32Array(heap),
    _malloc(size) { const pointer = next; next += Math.ceil(size / 4) * 4; return pointer; },
    _free() {}, addFunction: () => 1,
    ccall(name, _returnType, _argumentTypes, args) {
      if (name === 'tellus_audio_session_create') this.HEAPU32[args[0] / 4] = 1;
      if (name === 'tellus_audio_session_configure') configured = JSON.parse(new TextDecoder().decode(this.HEAPU8.subarray(args[1], args[1] + args[2])));
      return 0;
    },
  };
  await new NativeEngine(module).create({ micDeviceId: 'mic-b', playbackDeviceId: 'speaker-b', systemAudioDeviceId: 'sink-b', iosOutputRoute: 'speaker' });
  assert.deepEqual(configured, { sampleRate: 16000, denoise: false, denoiseMode: 'close_talk', vad: false, echoCancellation: true, micAgc2: false, transport: { codec: 'opus' } });
  await new NativeEngine(module).create({ denoiseMode: ' General ', processing: { sampleRate: 16000 } });
  assert.deepEqual([configured.denoiseMode, configured.sampleRate], ['general', 16000]);
  assert.equal('denoiseModel' in configured, false);
});

test('an omitted processing.sampleRate configures the 16 kHz engine output and any other output rate reaches the native rule unchanged', async () => {
  const heap = new ArrayBuffer(4096);
  let next = 4;
  const configured = [];
  const module = {
    HEAPU8: new Uint8Array(heap), HEAPU32: new Uint32Array(heap),
    _malloc(size) { const pointer = next; next += Math.ceil(size / 4) * 4; return pointer; },
    _free() {}, addFunction: () => 1,
    ccall(name, _returnType, _argumentTypes, args) {
      if (name === 'tellus_audio_session_create') this.HEAPU32[args[0] / 4] = 1;
      if (name === 'tellus_audio_session_configure') configured.push(JSON.parse(new TextDecoder().decode(this.HEAPU8.subarray(args[1], args[1] + args[2]))).sampleRate);
      return 0;
    },
  };
  for (const config of [{}, { processing: {} }, { processing: { sampleRate: 44100 }, transport: { codec: 'pcm_f32le' } }, { processing: { sampleRate: 24000 } }]) {
    await new NativeEngine(module).create(config);
  }
  assert.deepEqual(configured, [16000, 16000, 44100, 24000]);
});

test('an unknown denoise mode rejects init and closes init resources', async () => {
  const { contexts, workers } = environment();
  for (const denoiseMode of ['rnnoise', '', 'close-talk', 'denoise', 3]) {
    await assert.rejects(AudioEngine.init({ denoiseMode }, assets), /tellus_denoise_mode_invalid/);
  }
  assert.ok(contexts.every((context) => context.closed));
  assert.ok(workers.every((worker) => worker.terminated));
});

test('every integer output rate follows the core rule for PCM and the libopus rates for the default codec', () => {
  const opusRates = [8000, 12000, 16000, 24000, 48000];
  for (let sampleRate = 0; sampleRate <= 200000; sampleRate++) {
    const exact = sampleRate >= 8000 && sampleRate <= 192000 && (sampleRate * 20) % 1000 === 0;
    const pcm = { processing: { sampleRate }, transport: { codec: 'pcm_f32le' } };
    const opus = { processing: { sampleRate } };
    if (exact) assert.equal(outputSampleRate(pcm), sampleRate);
    else assert.throws(() => outputSampleRate(pcm), /tellus_processing_config_invalid/, String(sampleRate));
    if (!exact) assert.throws(() => outputSampleRate(opus), /tellus_processing_config_invalid/, String(sampleRate));
    else if (opusRates.includes(sampleRate)) assert.equal(outputSampleRate(opus), sampleRate);
    else assert.throws(() => outputSampleRate(opus), /tellus_opus_sample_rate_unsupported/, String(sampleRate));
  }
});

test('an omitted output rate is the 16 kHz default and only the fixed 20 ms chunk passes', () => {
  for (const config of [{}, { processing: {} }, { processing: { sampleRate: null } }, { processing: { chunkDurationMs: 20 } }]) {
    assert.equal(outputSampleRate(config), 16000);
  }
  for (const chunkDurationMs of [0, 10, 19.5, 40, null, '20']) {
    assert.throws(() => outputSampleRate({ processing: { chunkDurationMs } }), /tellus_processing_config_invalid/, String(chunkDurationMs));
  }
});

test('a malformed output rate is a processing config error, not an Opus error', () => {
  for (const sampleRate of [16000.5, NaN, Infinity, -16000, '16000', {}]) {
    assert.throws(() => outputSampleRate({ processing: { sampleRate } }), /tellus_processing_config_invalid/, String(sampleRate));
  }
});

test('the Opus rate limit uses the core codec spelling rule and leaves PCM rates alone', () => {
  for (const transport of [undefined, {}, { codec: null }, { codec: 'opus' }, { codec: ' OPUS ' }]) {
    assert.throws(() => outputSampleRate({ processing: { sampleRate: 44100 }, transport }), /tellus_opus_sample_rate_unsupported/, JSON.stringify(transport));
  }
  for (const codec of ['pcm_s16le', 'pcm_f32le', ' PCM_F32LE ']) {
    assert.equal(outputSampleRate({ processing: { sampleRate: 44100 }, transport: { codec } }), 44100);
  }
});

test('an invalid output rate or chunk duration rejects init before an AudioContext or Worker exists', async () => {
  const { contexts, workers } = environment();
  for (const [config, expected] of [
    [{ processing: { sampleRate: 11025 }, transport: { codec: 'pcm_f32le' } }, /tellus_processing_config_invalid/],
    [{ processing: { chunkDurationMs: 0 } }, /tellus_processing_config_invalid/],
    [{ processing: { sampleRate: 44100 } }, /tellus_opus_sample_rate_unsupported/],
  ]) {
    await assert.rejects(AudioEngine.init(config, assets), expected);
  }
  assert.equal(contexts.length, 0);
  assert.equal(workers.length, 0);
});

test('a 44.1 kHz PCM output passes init', async () => {
  const { contexts, workers } = environment();
  const engine = await AudioEngine.init({ processing: { sampleRate: 44100 }, transport: { codec: 'pcm_s16le' } }, assets);
  assert.equal(contexts.length, 1);
  assert.equal(workers.length, 1);
  await engine.dispose();
});

test('init completes before a gesture even when AudioContext resume cannot complete', async () => {
  let resumes = 0;
  let closed = false;
  globalThis.document = { baseURI: 'https://example.test/' };
  globalThis.AudioContext = class {
    audioWorklet = { addModule: async () => {} };
    resume() { resumes++; return new Promise(() => {}); }
    async close() { closed = true; }
  };
  globalThis.Worker = class {
    postMessage(message) { queueMicrotask(() => this.onmessage({ data: { id: message.id } })); }
    terminate() {}
  };
  let timer;
  const initialization = AudioEngine.init({}, { engineModuleUrl: 'engine.mjs', wasmUrl: 'engine.wasm', ortWasmBaseUrl: 'ort/', encryptedModels: [] });
  const engine = await Promise.race([initialization, new Promise((resolve) => { timer = setTimeout(() => resolve('waiting_for_gesture'), 100); })]);
  clearTimeout(timer);
  assert.notEqual(engine, 'waiting_for_gesture');
  assert.equal(resumes, 0);
  await engine.dispose();
  assert.equal(closed, true);
});
