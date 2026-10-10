import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserCapture } from '../../../platforms/web/runtime/platforms/web/capture.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const stream = () => ({ getTracks: () => [{ readyState: 'live', stop() {}, addEventListener() {}, removeEventListener() {} }] });

function environment(responses = {}) {
  const nodes = [];
  const requests = [];
  const permissions = [];
  globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia: (constraints) => {
      requests.push(constraints);
      return new Promise((resolve) => permissions.push(resolve));
    } },
  } });
  globalThis.AudioWorkletNode = class {
    constructor() { nodes.push(this); }
    controls = [];
    port = { postMessage: (message) => this.controls.push(message), close() {}, onmessage: null };
    connect() {} disconnect() {}
  };
  const context = { resume: async () => {}, currentTime: 0, destination: {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    decodeAudioData: (bytes) => responses.decodeAudioData(bytes) };
  let lifecycle = 'stopped';
  const commands = [];
  const client = {
    cancel() {},
    request: async (_id, _epoch, command) => {
      commands.push(command.operation);
      if (responses[command.operation]) return responses[command.operation](command);
      if (command.operation === 'create') return 1;
      if (command.operation === 'start' || command.operation === 'resume') lifecycle = 'running';
      if (command.operation === 'pause') lifecycle = 'paused';
      if (command.operation === 'stop') { lifecycle = 'stopped'; return []; }
      if (command.operation === 'denoise') return command.enabled;
      if (command.operation === 'applyAuthorization') return { state: 'authorized', remaining_ms: 100000 };
      if (command.operation === 'status') return { lifecycle, denoise_enabled: false, denoise_loaded: false, vad_loaded: false };
    },
  };
  return { capture: new BrowserCapture(client, context, {}), permissions, requests, commands, nodes };
}

test('pause while microphone permission is pending reacquires real input on resume', async () => {
  const { capture, permissions, requests, commands } = environment();
  await capture.applyAuthorization('permit');
  const starting = capture.start(() => {});
  await flush();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].audio, { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  await capture.pause();
  const resuming = capture.resume();
  await flush();
  assert.equal(requests.length, 2);
  permissions[0](stream());
  permissions[1](stream());
  await Promise.all([starting, resuming]);
  assert.equal((await capture.getStatus()).state, 'running');
  assert.equal(commands.filter((command) => command === 'start').length, 2);
  await capture.dispose();
});


test('a rejected denoise enable restores the running OS input tap', async () => {
  const { capture, permissions, nodes, commands } = environment({ denoise: () => { throw new Error('model_required'); } });
  await capture.applyAuthorization('permit');
  const starting = capture.start(() => {});
  await flush();
  permissions[0](stream());
  await starting;
  await assert.rejects(capture.setDenoiseEnabled(true), /model_required/);
  assert.deepEqual(nodes[0].controls.at(-1), { active: true, epoch: 1 });
  assert.equal((await capture.getStatus()).state, 'running');
  await capture.setDenoiseEnabled(false);
  assert.equal(commands.filter((command) => command === 'denoise').length, 1);
  await capture.dispose();
});

test('pause invalidates an output whose final native delivery check is still pending', async () => {
  let allow;
  const validation = new Promise((resolve) => { allow = resolve; });
  const output = { epoch: '1', authorizationGeneration: '1', chunk: {
    data: { microphone: new Uint8Array([1]) }, sampleCount: 320, validSampleCount: 320,
  } };
  const { capture, permissions, nodes, commands } = environment({
    capture: () => [output], canDeliver: () => validation,
  });
  await capture.applyAuthorization('permit');
  const received = [];
  const starting = capture.start((error, chunk) => received.push({ error, chunk }));
  await flush();
  permissions[0](stream());
  await starting;
  nodes[0].port.onmessage({ data: { samples: new Float32Array(128), nativeRate: 48000, timestamp: 1, epoch: 0 } });
  await flush();
  assert.ok(commands.includes('canDeliver'));
  await capture.pause();
  allow(true);
  await flush();
  assert.deepEqual(received, []);
  await capture.dispose();
});


test('cancel during OS decode never starts playback and keeps caller bytes intact', async () => {
  let decoded;
  let decoding;
  const completion = new Promise((resolve) => { decoded = resolve; });
  const { capture, permissions, nodes } = environment({ decodeAudioData: (bytes) => { decoding = bytes; return completion; } });
  await capture.applyAuthorization('permit');
  const starting = capture.start(() => {});
  await flush();
  permissions[0](stream());
  await starting;
  const data = new ArrayBuffer(44);
  const playback = capture.playbackEncoded(data);
  await flush();
  assert.notEqual(decoding, data);
  await capture.cancelPlayback();
  decoded({ numberOfChannels: 1, sampleRate: 48000, getChannelData: () => new Float32Array(480) });
  await playback;
  assert.equal(data.byteLength, 44);
  assert.equal(nodes.length, 1);
  await capture.dispose();
});

test('reset drops a pending delivery and reactivates the same microphone with a new epoch', async () => {
  let allow;
  let checks = 0;
  const validation = new Promise((resolve) => { allow = resolve; });
  const output = { epoch: '1', authorizationGeneration: '1', chunk: {
    data: { microphone: new Uint8Array([1]) }, sampleCount: 320, validSampleCount: 320,
  } };
  const { capture, permissions, nodes } = environment({
    capture: () => [output], canDeliver: () => ++checks === 1 ? validation : true,
  });
  await capture.applyAuthorization('permit');
  const received = [];
  const starting = capture.start((error, chunk) => received.push({ error, chunk }));
  await flush();
  permissions[0](stream());
  await starting;
  const frame = (epoch) => ({ data: { samples: new Float32Array(128), nativeRate: 48000, timestamp: 1, epoch } });
  nodes[0].port.onmessage(frame(0));
  await flush();
  await capture.reset();
  assert.deepEqual(nodes[0].controls.at(-1), { active: true, epoch: 1 });
  allow(true);
  await flush();
  assert.deepEqual(received, []);
  nodes[0].port.onmessage(frame(1));
  await flush();
  assert.equal(received.length, 1);
  await capture.dispose();
});

test('encoded playback rejects byte and decoded sample limits before copying or mono allocation', async () => {
  let decodes = 0;
  let remixes = 0;
  globalThis.OfflineAudioContext = class { constructor() { remixes++; } };
  const { capture, permissions } = environment({ decodeAudioData: async () => {
    decodes++;
    return { numberOfChannels: 2, length: 4 * 1024 * 1024, sampleRate: 16000 };
  } });
  await capture.applyAuthorization('permit');
  const starting = capture.start(() => {});
  await flush();
  permissions[0](stream());
  await starting;
  await assert.rejects(capture.playbackEncoded(new ArrayBuffer(16 * 1024 * 1024 + 1)), /tellus_playback_encoded_too_large/);
  assert.equal(decodes, 0);
  await assert.rejects(capture.playbackEncoded(new ArrayBuffer(44)), /tellus_playback_decoded_too_large/);
  assert.equal(decodes, 1);
  assert.equal(remixes, 0);
  await capture.dispose();
});

test('setting the current denoise value preserves an output awaiting its final delivery check', async () => {
  let allow;
  const validation = new Promise((resolve) => { allow = resolve; });
  const output = { epoch: '1', authorizationGeneration: '1', chunk: {
    data: { microphone: new Uint8Array([1]) }, sampleCount: 320, validSampleCount: 320,
  } };
  const { capture, permissions, nodes, commands } = environment({ capture: () => [output], canDeliver: () => validation });
  await capture.applyAuthorization('permit');
  const received = [];
  const starting = capture.start((error, chunk) => received.push({ error, chunk }));
  await flush();
  permissions[0](stream());
  await starting;
  nodes[0].port.onmessage({ data: { samples: new Float32Array(128), nativeRate: 48000, timestamp: 1, epoch: 0 } });
  await flush();
  await capture.setDenoiseEnabled(false);
  allow(true);
  await flush();
  assert.equal(received.length, 1);
  assert.equal(commands.includes('denoise'), false);
  assert.deepEqual(nodes[0].controls.at(-1), { active: true, epoch: 0 });
  await capture.dispose();
});


test('a denoise update back to the initial value keeps the latest pending caller intent', async () => {
  const updates = [];
  const { capture } = environment({ denoise: (command) => new Promise((resolve) => {
    updates.push({ enabled: command.enabled, resolve });
  }) });
  const enabling = capture.setDenoiseEnabled(true);
  await flush();
  const disabling = capture.setDenoiseEnabled(false);
  await flush();
  assert.deepEqual(updates.map((update) => update.enabled), [true, false]);
  updates[0].resolve(true);
  updates[1].resolve(false);
  await Promise.all([enabling, disabling]);
  await capture.setDenoiseEnabled(false);
  assert.equal(updates.length, 2);
  await capture.dispose();
});
