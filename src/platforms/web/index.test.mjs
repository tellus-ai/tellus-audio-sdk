import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioEngine, listAudioDevices } from '../../../platforms/web/runtime/platforms/web/index.js';
import { NativeEngine } from '../../../platforms/web/runtime/platforms/web/native.js';

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
  assert.deepEqual(configured, { sampleRate: 16000, denoise: false, vad: false, echoCancellation: true, micAgc2: false, transport: { codec: 'opus' } });
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
