import assert from 'node:assert/strict';
import test from 'node:test';
import { SpeechDetector } from '@tellus-ai/audio-sdk-web';

const encoder = new TextEncoder();
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
let instances = 0;

// The fake C ABI records calls and queues the next speech event on each push.
function detectorModule(calls, events) {
  const heap = new ArrayBuffer(1 << 16);
  const queue = [];
  let next = 8;
  const module = {
    HEAPU8: new Uint8Array(heap), HEAPU32: new Uint32Array(heap), HEAPF32: new Float32Array(heap),
    _malloc(size) { const pointer = next; next += Math.ceil(Math.max(size, 1) / 8) * 8; return pointer; },
    _free() {}, UTF8ToString: () => 'native_failed',
    ccall(name, _returnType, _argumentTypes, args) {
      calls.push(name);
      if (name === 'tellus_audio_speech_detector_create') module.HEAPU32[args[2] / 4] = 9;
      if (name === 'tellus_audio_speech_detector_push') {
        assert.equal(args[0], 9);
        if (events.length) queue.push(events.shift());
      }
      if (name === 'tellus_audio_speech_detector_poll_event') {
        const event = queue.shift();
        module.HEAPU8[args[1]] = event ? 1 : 0;
        if (event) {
          module.HEAPU8[args[2]] = event.speaking ? 1 : 0;
          new DataView(heap).setBigUint64(args[3], BigInt(event.timestampMs), true);
        }
      }
      return 0;
    },
  };
  return module;
}

// Run the detector worker against a new worker scope and a plaintext model response.
async function detectionWorker(events) {
  const calls = [];
  const posted = [];
  const responses = new Map();
  const scope = { postMessage: (message) => { posted.push(message); responses.get(message.id)(message); } };
  globalThis.self = scope;
  globalThis.tellusTestDetector = () => detectorModule(calls, events);
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => encoder.encode('silero').buffer });
  await import(`../../../platforms/web/runtime/platforms/web/speech-detection-worker.js?instance=${++instances}`);
  let id = 0;
  const send = (command) => new Promise((resolve) => {
    responses.set(++id, resolve);
    scope.onmessage({ data: { id, command } });
  });
  const assets = { engineModuleUrl: moduleUrl('export default () => globalThis.tellusTestDetector();'),
    wasmUrl: 'https://example.test/engine.wasm', ortModuleUrl: moduleUrl('export const env = { wasm: {} };'),
    ortWasmBaseUrl: 'https://example.test/ort/', speechDetectionModelUrl: 'https://example.test/speech-detection/silero_vad_v6.2.onnx' };
  assert.equal((await send({ operation: 'init', assets })).error, undefined);
  return { send, calls, posted };
}

test('the detector worker uses only the detection ABI and returns only speech state events', async () => {
  const { send, calls, posted } = await detectionWorker([{ speaking: false, timestampMs: 1024 }, { speaking: true, timestampMs: 2048 }]);
  assert.equal((await send({ operation: 'start' })).error, undefined);
  assert.deepEqual((await send({ operation: 'push', samples: new Float32Array(128), rate: 48000 })).events, [{ speaking: false, timestampMs: 1024 }]);
  assert.deepEqual((await send({ operation: 'push', samples: new Float32Array(128), rate: 48000 })).events, [{ speaking: true, timestampMs: 2048 }]);
  assert.equal((await send({ operation: 'stop' })).error, undefined);
  assert.match((await send({ operation: 'push', samples: new Float32Array(128), rate: 48000 })).error, /tellus_speech_detection_not_running/);
  assert.ok(calls.length > 0);
  for (const name of calls) assert.match(name, /^tellus_audio_speech_detector_(create|push|poll_event|destroy)$/);
  assert.deepEqual([...new Set(calls)], ['tellus_audio_speech_detector_create', 'tellus_audio_speech_detector_push', 'tellus_audio_speech_detector_poll_event', 'tellus_audio_speech_detector_destroy']);
  for (const message of posted) {
    for (const key of Object.keys(message)) assert.ok(['id', 'events', 'error'].includes(key), key);
    for (const event of message.events ?? []) assert.deepEqual(Object.keys(event).sort(), ['speaking', 'timestampMs']);
  }
});

const microphone = () => {
  const track = { stopped: false, stop() { this.stopped = true; }, addEventListener(_type, listener) { this.onended = listener; }, removeEventListener() { this.onended = undefined; } };
  return { track, getTracks: () => [track] };
};

// Simulate browser IO and respond to each push with the next list of speech events.
function environment(replies = []) {
  const commands = [];
  const taps = [];
  const constraints = [];
  const stream = microphone();
  globalThis.document = { baseURI: 'https://example.test/app/' };
  globalThis.AudioContext = class {
    destination = {};
    audioWorklet = { addModule: async () => {} };
    resume = async () => {};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async close() { this.closed = true; }
  };
  globalThis.AudioWorkletNode = class {
    constructor(_context, name, options) { this.name = name; this.options = options; taps.push(this); }
    controls = [];
    port = { postMessage: (message) => this.controls.push(message), close() {}, onmessage: null };
    connect() {} disconnect() {}
  };
  globalThis.Worker = class {
    postMessage({ id, command }) {
      commands.push(command);
      const events = command.operation === 'push' ? replies.shift() ?? [] : [];
      queueMicrotask(() => this.onmessage({ data: { id, events } }));
    }
    terminate() { this.terminated = true; }
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia: async (value) => { constraints.push(value); return stream; } },
  } });
  return { commands, taps, constraints, track: stream.track };
}

const assets = { engineModuleUrl: 'engine.mjs', wasmUrl: 'engine.wasm', ortWasmBaseUrl: 'ort/', speechDetectionModelUrl: 'speech-detection/silero_vad_v6.2.onnx' };
const frame = () => ({ data: { samples: new Float32Array(128), nativeRate: 48000, timestamp: 0, epoch: 1, generation: 0 } });

test('the public detector opens only the requested microphone and emits only speech state fields', async () => {
  const { commands, taps, constraints } = environment([[{ speaking: true, timestampMs: 1024, probability: 0.9, samples: [1] }]]);
  const detector = await SpeechDetector.init(assets);
  assert.equal(commands[0].assets.speechDetectionModelUrl, 'https://example.test/app/speech-detection/silero_vad_v6.2.onnx');
  const received = [];
  await detector.start((error, event) => received.push([error, event]), 'mic-b');
  assert.deepEqual(constraints, [{ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId: { exact: 'mic-b' } } }]);
  assert.equal(taps.length, 1);
  assert.equal(taps[0].options.processorOptions.render, false);
  taps[0].port.onmessage(frame());
  await flush();
  assert.deepEqual(received, [[null, { speaking: true, timestampMs: 1024 }]]);
  assert.deepEqual(commands.map((command) => command.operation), ['init', 'start', 'push']);
  assert.deepEqual(Object.keys(commands[2]).sort(), ['operation', 'rate', 'samples']);
  await detector.dispose();
});

test('stop closes the microphone and ignores late worklet frames', async () => {
  const { commands, taps, track } = environment();
  const detector = await SpeechDetector.init(assets);
  const received = [];
  await detector.start((error, event) => received.push([error, event]));
  const tap = taps[0];
  await detector.stop();
  assert.equal(track.stopped, true);
  tap.port.onmessage(frame());
  await flush();
  assert.deepEqual(commands.map((command) => command.operation), ['init', 'start', 'stop']);
  assert.deepEqual(received, []);
  await assert.rejects(detector.start(() => {}).then(() => detector.start(() => {})), /speech_detection_already_running/);
  await detector.dispose();
  await assert.rejects(detector.start(() => {}), /tellus_speech_detector_disposed/);
});

test('detection does not ask the worker for a permit or model keys', async () => {
  const { commands, taps } = environment([[{ speaking: false, timestampMs: 1024 }]]);
  const detector = await SpeechDetector.init(assets);
  await detector.start(() => {});
  taps[0].port.onmessage(frame());
  await flush();
  await detector.stop();
  await detector.dispose();
  for (const command of commands) assert.ok(['init', 'start', 'push', 'stop'].includes(command.operation), command.operation);
  assert.ok(!('encryptedModels' in commands[0].assets));
});

test('microphone loss closes the track and reports one terminal error', async () => {
  const { track } = environment();
  const detector = await SpeechDetector.init(assets);
  const errors = [];
  await detector.start((error) => errors.push(error));
  const ended = track.onended;
  ended();
  ended();
  await flush();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'tellus_microphone_device_ended');
  assert.equal(errors[0].deviceStatus.source, 'microphone');
  assert.equal(track.stopped, true);
  await detector.dispose();
});
