import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserCapture } from '../../../platforms/web/runtime/platforms/web/capture.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const stream = (deviceId, settings = {}) => {
  const track = { readyState: 'live', stopped: false, getSettings: () => ({ deviceId, ...settings }),
    stop() { this.stopped = true; }, addEventListener(_type, listener) { this.onended = listener; }, removeEventListener() { this.onended = undefined; } };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
};

function environment(responses = {}, config = {}) {
  const nodes = [];
  const requests = [];
  const permissions = [];
  const rejections = [];
  globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia: (constraints) => {
      requests.push(constraints);
      return new Promise((resolve, reject) => { permissions.push(resolve); rejections.push(reject); });
    } },
  } });
  globalThis.AudioWorkletNode = class {
    constructor() { nodes.push(this); }
    controls = [];
    port = { postMessage: (message) => this.controls.push(message), close() {}, onmessage: null };
    connect() {} disconnect() {}
  };
  const context = { resume: responses.contextResume ?? (async () => {}), currentTime: 0, destination: {}, sampleRate: 48000,
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
      if (command.operation === 'status') return { lifecycle, denoise_enabled: false, denoise_loaded: false, vad_loaded: false, loadedModels: [] };
    },
  };
  return { capture: new BrowserCapture(client, context, config), permissions, rejections, requests, commands, nodes };
}

test('an exact microphone selection is pending until the actual input is acquired', async () => {
  const { capture, permissions, requests } = environment({}, { micDeviceId: 'mic-b' });
  const starting = capture.start(() => {});
  await flush();
  assert.deepEqual(requests[0].audio.deviceId, { exact: 'mic-b' });
  assert.deepEqual((await capture.getStatus()).deviceStatus, [{ source: 'microphone', code: 'pending', requestedDeviceId: 'mic-b' }]);
  permissions[0](stream('mic-b'));
  await starting;
  assert.deepEqual((await capture.getStatus()).deviceStatus, [{ source: 'microphone', code: 'ready', requestedDeviceId: 'mic-b', actualDeviceId: 'mic-b', nativeSampleRateHz: 48000 }]);
  await capture.dispose();
});

test('a ready microphone reports the track rate and the context rate when the track has none', async () => {
  for (const [settings, nativeSampleRateHz] of [[{ sampleRate: 44100 }, 44100], [{}, 48000]]) {
    const { capture, permissions } = environment();
    const starting = capture.start(() => {});
    await flush();
    assert.equal((await capture.getStatus()).deviceStatus[0].nativeSampleRateHz, undefined);
    permissions[0](stream('mic-a', settings));
    await starting;
    assert.deepEqual((await capture.getStatus()).deviceStatus, [{ source: 'microphone', code: 'ready', actualDeviceId: 'mic-a', nativeSampleRateHz }]);
    await capture.dispose();
  }
});

test('reopening the microphone replaces the reported rate', async () => {
  const { capture, permissions } = environment();
  const first = capture.start(() => {});
  await flush();
  permissions[0](stream('mic-a', { sampleRate: 48000 }));
  await first;
  await capture.stop();
  const second = capture.start(() => {});
  await flush();
  assert.equal((await capture.getStatus()).deviceStatus[0].nativeSampleRateHz, undefined);
  permissions[1](stream('mic-b', { sampleRate: 16000 }));
  await second;
  assert.equal((await capture.getStatus()).deviceStatus[0].nativeSampleRateHz, 16000);
  await capture.dispose();
});

test('an ended microphone no longer reports a rate', async () => {
  const { capture, permissions } = environment();
  const microphone = stream('mic-a', { sampleRate: 48000 });
  const starting = capture.start(() => {});
  await flush();
  permissions[0](microphone);
  await starting;
  microphone.track.onended();
  assert.equal((await capture.getStatus()).deviceStatus[0].code, 'unavailable');
  assert.equal((await capture.getStatus()).deviceStatus[0].nativeSampleRateHz, undefined);
  await capture.dispose();
});

test('an actual microphone mismatch closes the input and leaves a readable failure status', async () => {
  const { capture, permissions } = environment({}, { micDeviceId: 'mic-b' });
  const starting = capture.start(() => {});
  const rejection = assert.rejects(starting, (error) => {
    assert.deepEqual(error.deviceStatus, { source: 'microphone', code: 'route_mismatch', requestedDeviceId: 'mic-b', actualDeviceId: 'mic-a' });
    return true;
  });
  await flush();
  const input = stream('mic-a');
  permissions[0](input);
  await rejection;
  assert.equal(input.track.stopped, true);
  assert.equal((await capture.getStatus()).state, 'stopped');
  assert.equal((await capture.getStatus()).deviceStatus[0].code, 'route_mismatch');
  await capture.dispose();
});

test('a denied microphone request reports permission state without poisoning core status', async () => {
  const { capture, rejections } = environment({}, { micDeviceId: 'mic-b' });
  const starting = capture.start(() => {});
  const rejection = assert.rejects(starting, (error) => error.deviceStatus?.code === 'permission_denied');
  await flush();
  rejections[0](new DOMException('denied', 'NotAllowedError'));
  await rejection;
  assert.equal((await capture.getStatus()).deviceStatus[0].code, 'permission_denied');
  await capture.dispose();
});

test('an empty microphone ID never opens the default device', async () => {
  const { capture, requests } = environment({}, { micDeviceId: '' });
  await assert.rejects(capture.start(() => {}), (error) => error.deviceStatus?.code === 'unavailable');
  assert.deepEqual(requests, []);
  await capture.dispose();
});

test('a selected microphone ending reports unavailable through callback and status', async () => {
  const { capture, permissions } = environment({}, { micDeviceId: 'mic-b' });
  let failure;
  const starting = capture.start((error) => { failure = error; });
  await flush();
  const input = stream('mic-b');
  permissions[0](input);
  await starting;
  input.track.onended();
  await flush();
  assert.equal(failure.deviceStatus.code, 'unavailable');
  assert.equal((await capture.getStatus()).deviceStatus[0].code, 'unavailable');
  assert.equal(input.track.stopped, true);
  await capture.dispose();
});

test('stop while exact input permission is pending closes the late stream without marking it ready', async () => {
  const { capture, permissions } = environment({}, { micDeviceId: 'mic-b' });
  const starting = capture.start(() => {});
  await flush();
  await capture.stop();
  const input = stream('mic-b');
  permissions[0](input);
  await starting;
  assert.equal(input.track.stopped, true);
  assert.notEqual((await capture.getStatus()).deviceStatus[0].code, 'ready');
  await capture.dispose();
});

test('a missing exact microphone reports unavailable without opening another input', async () => {
  const { capture, requests, rejections } = environment({}, { micDeviceId: 'missing-mic' });
  const starting = capture.start(() => {});
  const rejection = assert.rejects(starting, (error) => error.deviceStatus?.code === 'unavailable');
  await flush();
  rejections[0](new DOMException('missing device', 'NotFoundError'));
  await rejection;
  assert.equal(requests.length, 1);
  assert.equal((await capture.getStatus()).deviceStatus[0].requestedDeviceId, 'missing-mic');
  await capture.dispose();
});

test('a late rejected exact input cannot stop the replacement input after pause and resume', async () => {
  const { capture, permissions, rejections } = environment({}, { micDeviceId: 'mic-b' });
  const starting = capture.start(() => {});
  await flush();
  await capture.pause();
  const resuming = capture.resume();
  await flush();
  permissions[1](stream('mic-b'));
  await resuming;
  rejections[0](new DOMException('stale permission denial', 'NotAllowedError'));
  await starting;
  assert.equal((await capture.getStatus()).state, 'running');
  assert.equal((await capture.getStatus()).deviceStatus[0].code, 'ready');
  await capture.dispose();
});

test('a failed context resume closes the acquired exact microphone', async () => {
  const { capture, permissions } = environment({ contextResume: async () => { throw new Error('context_resume_failed'); } }, { micDeviceId: 'mic-b' });
  const starting = capture.start(() => {});
  const rejection = assert.rejects(starting, /context_resume_failed/);
  await new Promise(setImmediate);
  const input = stream('mic-b');
  permissions[0](input);
  await rejection;
  assert.equal(input.track.stopped, true);
  await capture.dispose();
});

test('pause while the context is resuming closes the acquired input and reacquires on resume', async () => {
  const resumes = [];
  const { capture, permissions, requests } = environment({ contextResume: () => new Promise((resolve) => resumes.push(resolve)) }, { micDeviceId: 'mic-b' });
  const starting = capture.start(() => {});
  await flush();
  const firstInput = stream('mic-b');
  permissions[0](firstInput);
  await flush();
  await capture.pause();
  const resuming = capture.resume();
  await flush();
  assert.equal(requests.length, 2);
  assert.equal(firstInput.track.stopped, true);
  resumes.forEach((resolve) => resolve());
  permissions[1](stream('mic-b'));
  await Promise.all([starting, resuming]);
  assert.equal((await capture.getStatus()).state, 'running');
  await capture.dispose();
});

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

test('status reports the loaded models the worker resolved', async () => {
  const { capture } = environment({ status: () => ({ lifecycle: 'stopped', denoise_enabled: true, denoise_loaded: true, vad_loaded: true, loadedModels: ['dfn3-48', 'silero-vad'] }) });
  assert.deepEqual((await capture.getStatus()).modelsLoaded, ['dfn3-48', 'silero-vad']);
  await capture.dispose();
});

test('status reports the applied denoise mode and a DeepFilterNet3 load failure as native reported them', async () => {
  const native = { lifecycle: 'stopped', denoise_enabled: false, denoise_loaded: false, denoise_load_failed: true, denoise_mode: 'general', vad_loaded: false, loadedModels: [] };
  const { capture } = environment({ status: () => native }, { denoiseMode: 'general' });
  const status = await capture.getStatus();
  assert.deepEqual([status.denoiseEnabled, status.denoiseMode, status.denoiseLoadFailed, status.modelsLoaded], [false, 'general', true, []]);
  await capture.dispose();
});

test('queue loss is reported at the 16 kHz default output rate when processing.sampleRate is omitted', async () => {
  for (const [config, expected] of [[{}, 160], [{ processing: {} }, 160], [{ processing: { sampleRate: 48000 } }, 480]]) {
    const dropped = [];
    let release;
    const { capture, permissions, nodes } = environment({
      capture: (command) => {
        dropped.push(command.droppedSamples);
        return dropped.length === 1 ? new Promise((resolve) => { release = () => resolve([]); }) : [];
      },
    }, config);
    await capture.applyAuthorization('permit');
    const starting = capture.start(() => {});
    await flush();
    permissions[0](stream());
    await starting;
    // While the first frame waits for the Worker, 11 frames queue up, so a queue of capacity 10 drops one 10 ms frame (480 samples at 48 kHz).
    for (let frame = 0; frame < 12; frame++) {
      nodes[0].port.onmessage({ data: { samples: new Float32Array(480), nativeRate: 48000, timestamp: frame, epoch: 0 } });
    }
    await flush();
    release();
    await flush();
    assert.equal(dropped[1], expected, JSON.stringify(config));
    await capture.dispose();
  }
});
