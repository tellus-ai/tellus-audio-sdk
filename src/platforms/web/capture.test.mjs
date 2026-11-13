import assert from 'node:assert/strict';
import test from 'node:test';

test('microphone runtime gain validates and forwards through the capture owner while system gain is unsupported', async () => {
  const applied = [];
  const { capture } = environment({ micGainDb: command => { applied.push(command.db); } });
  await capture.setMicGainDb(-4);
  await capture.setMicGainDb(12);
  for (const db of [NaN, Infinity, -61, 13, null, '3']) await assert.rejects(capture.setMicGainDb(db), /gain.*invalid|invalid.*gain/);
  await assert.rejects(capture.setSpeakerGainDb(0), /speaker_gain_unsupported/);
  assert.deepEqual(applied, [-4, 12]);
  await capture.dispose();
  await assert.rejects(capture.setMicGainDb(0), /capture_disposed/);
  assert.deepEqual(applied, [-4, 12]);
});
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
  const { capture } = environment({ status: () => ({ lifecycle: 'stopped', denoise_enabled: true, denoise_loaded: true, vad_loaded: true, loadedModels: ['denoise', 'vad'] }) });
  assert.deepEqual((await capture.getStatus()).modelsLoaded, ['denoise', 'vad']);
  await capture.dispose();
});

test('status reports the applied denoise mode and a denoise model load failure as native reported them', async () => {
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

test('runtime close-talk threshold validates before reaching the worker', async () => {
  const values = [];
  const { capture, commands } = environment({ closeTalkThresholdDb: (command) => { values.push(command.db); } });
  for (const db of [61, -1, NaN, Infinity, null, '25']) await assert.rejects(capture.setCloseTalkThresholdDb(db), /tellus_close_talk_threshold_db_invalid/);
  assert.equal(commands.includes('closeTalkThresholdDb'), false);
  await capture.setCloseTalkThresholdDb(0);
  await capture.setCloseTalkThresholdDb(60);
  assert.deepEqual(values, [0, 60]);
  await capture.dispose();
});

test('a configured close-talk threshold is applied once after session creation and before start', async () => {
  const values = [];
  const { capture, permissions, commands } = environment({ closeTalkThresholdDb: (command) => { values.push(command.db); } }, { closeTalkThresholdDb: 25 });
  const starting = capture.start(() => {});
  await flush();
  permissions[0](stream('mic-a'));
  await starting;
  assert.deepEqual(commands.filter((command) => ['create', 'closeTalkThresholdDb', 'start'].includes(command)), ['create', 'closeTalkThresholdDb', 'start']);
  assert.deepEqual(values, [25]);
  await capture.setCloseTalkThresholdDb(20);
  await capture.stop();
  const restarting = capture.start(() => {});
  await flush();
  permissions[1](stream('mic-a'));
  await restarting;
  assert.deepEqual(values, [25, 20], 'a restart keeps the runtime value native already holds');
  await capture.dispose();
  const early = environment({ closeTalkThresholdDb: (command) => { values.push(command.db); } }, { closeTalkThresholdDb: 25 });
  await early.capture.setCloseTalkThresholdDb(18);
  const earlyStart = early.capture.start(() => {});
  await flush();
  early.permissions[0](stream('mic-a'));
  await earlyStart;
  assert.deepEqual(values, [25, 20, 18], 'the configured value never overwrites an earlier runtime change');
  await early.capture.dispose();
  const unsupported = environment({ closeTalkThresholdDb: () => { throw new Error('tellus_close_talk_threshold_unsupported'); } }, { closeTalkThresholdDb: 25 });
  await assert.rejects(unsupported.capture.start(() => {}), /tellus_close_talk_threshold_unsupported/);
  assert.equal(unsupported.commands.includes('start'), false);
  await unsupported.capture.dispose();
});

test('status reports the applied close-talk threshold from the worker', async () => {
  const { capture } = environment({ status: () => ({ lifecycle: 'stopped', denoise_enabled: false, denoise_loaded: false, vad_loaded: false, close_talk_threshold_db: 22, loadedModels: [] }) });
  assert.equal((await capture.getStatus()).closeTalkThresholdDb, 22);
  await capture.dispose();
});

test('runtime denoise attenuation limit validates before reaching the worker', async () => {
  const values = [];
  const { capture, commands } = environment({ denoiseAttenuationLimitDb: (command) => { values.push(command.db); } });
  for (const db of [61, -1, NaN, Infinity, null, '6']) await assert.rejects(capture.setDenoiseAttenuationLimitDb(db), /tellus_denoise_attenuation_limit_db_invalid/);
  assert.equal(commands.includes('denoiseAttenuationLimitDb'), false);
  await capture.setDenoiseAttenuationLimitDb(0);
  await capture.setDenoiseAttenuationLimitDb(60);
  assert.deepEqual(values, [0, 60]);
  await capture.dispose();
});

test('a configured denoise attenuation limit is applied once after the close-talk threshold and before start', async () => {
  const values = [];
  const settings = { closeTalkThresholdDb: () => {}, denoiseAttenuationLimitDb: (command) => { values.push(command.db); } };
  const { capture, permissions, commands } = environment(settings, { closeTalkThresholdDb: 25, denoiseAttenuationLimitDb: 6 });
  const starting = capture.start(() => {});
  await flush();
  permissions[0](stream('mic-a'));
  await starting;
  const order = ['create', 'closeTalkThresholdDb', 'denoiseAttenuationLimitDb', 'start'];
  assert.deepEqual(commands.filter((command) => order.includes(command)), order);
  assert.deepEqual(values, [6]);
  await capture.setDenoiseAttenuationLimitDb(9);
  await capture.stop();
  const restarting = capture.start(() => {});
  await flush();
  permissions[1](stream('mic-a'));
  await restarting;
  assert.deepEqual(values, [6, 9], 'a restart keeps the runtime value native already holds');
  await capture.dispose();
  const early = environment(settings, { denoiseAttenuationLimitDb: 6 });
  await early.capture.setDenoiseAttenuationLimitDb(4);
  const earlyStart = early.capture.start(() => {});
  await flush();
  early.permissions[0](stream('mic-a'));
  await earlyStart;
  assert.deepEqual(values, [6, 9, 4], 'the configured value never overwrites an earlier runtime change');
  await early.capture.dispose();
  const unsupported = environment({ denoiseAttenuationLimitDb: () => { throw new Error('tellus_denoise_attenuation_limit_unsupported'); } }, { denoiseAttenuationLimitDb: 6 });
  await assert.rejects(unsupported.capture.start(() => {}), /tellus_denoise_attenuation_limit_unsupported/);
  assert.equal(unsupported.commands.includes('start'), false);
  await unsupported.capture.dispose();
});

test('status reports the applied denoise attenuation limit, and engines without the settings leave both absent', async () => {
  const { capture } = environment({ status: () => ({ lifecycle: 'stopped', denoise_enabled: false, denoise_loaded: false, vad_loaded: false,
    close_talk_threshold_db: 22, denoise_attenuation_limit_db: 6, loadedModels: [] }) });
  const status = await capture.getStatus();
  assert.equal(status.closeTalkThresholdDb, 22);
  assert.equal(status.denoiseAttenuationLimitDb, 6);
  await capture.dispose();
  const old = environment();
  const oldStatus = await old.capture.getStatus();
  assert.equal(oldStatus.closeTalkThresholdDb, undefined);
  assert.equal(oldStatus.denoiseAttenuationLimitDb, undefined);
  await old.capture.dispose();
});

test('a runtime change that fails leaves the configured value for the next start unless a newer change replaced it', async () => {
  for (const [operation, setter, configured, failed, newer] of [
    ['closeTalkThresholdDb', 'setCloseTalkThresholdDb', 25, 20, 18],
    ['denoiseAttenuationLimitDb', 'setDenoiseAttenuationLimitDb', 6, 9, 4],
  ]) {
    const values = [];
    let rejectChange;
    const respond = (command) => {
      if (command.db !== failed) { values.push(command.db); return; }
      return new Promise((_resolve, reject) => { rejectChange = reject; });
    };
    const kept = environment({ [operation]: respond }, { [operation]: configured });
    const failing = kept.capture[setter](failed);
    await flush();
    rejectChange(new Error('tellus_capture_cancelled'));
    await assert.rejects(failing, /tellus_capture_cancelled/);
    const starting = kept.capture.start(() => {});
    await flush();
    kept.permissions[0](stream('mic-a'));
    await starting;
    assert.deepEqual(values, [configured], `${operation}: the failed change leaves the configured value`);
    await kept.capture.dispose();
    values.length = 0;
    const replaced = environment({ [operation]: respond }, { [operation]: configured });
    const superseded = replaced.capture[setter](failed);
    await flush();
    await replaced.capture[setter](newer);
    rejectChange(new Error('tellus_capture_cancelled'));
    await assert.rejects(superseded, /tellus_capture_cancelled/);
    const restarting = replaced.capture.start(() => {});
    await flush();
    replaced.permissions[0](stream('mic-a'));
    await restarting;
    assert.deepEqual(values, [newer], `${operation}: the newer change still replaces the configured value`);
    await replaced.capture.dispose();
  }
});

test('overlapping runtime changes that all fail keep the configured value for start, and a successful one supersedes it', async () => {
  for (const [operation, setter, configured, first, second, unsupported] of [
    ['closeTalkThresholdDb', 'setCloseTalkThresholdDb', 25, 20, 18, /tellus_close_talk_threshold_unsupported/],
    ['denoiseAttenuationLimitDb', 'setDenoiseAttenuationLimitDb', 6, 9, 4, /tellus_denoise_attenuation_limit_unsupported/],
  ]) {
    const sent = [];
    const settle = new Map();
    const respond = (command) => {
      sent.push(command.db);
      if (command.db === configured) return;
      return new Promise((resolve, reject) => { settle.set(command.db, { resolve, reject }); });
    };
    const failed = environment({ [operation]: respond }, { [operation]: configured });
    const changes = [failed.capture[setter](first), failed.capture[setter](second)];
    await flush();
    settle.get(first).reject(new Error('tellus_capture_cancelled'));
    settle.get(second).reject(new Error('tellus_capture_cancelled'));
    await Promise.all(changes.map((change) => assert.rejects(change, /tellus_capture_cancelled/)));
    const starting = failed.capture.start(() => {});
    await flush();
    failed.permissions[0](stream('mic-a'));
    await starting;
    assert.deepEqual(sent, [first, second, configured], `${operation}: start sends the configured value once after both failures`);
    assert.deepEqual(failed.commands.filter((command) => [operation, 'start'].includes(command)), [operation, operation, operation, 'start']);
    await failed.capture.dispose();

    const oldKit = environment({ [operation]: () => { throw new Error(unsupported.source); } }, { [operation]: configured });
    await Promise.all([oldKit.capture[setter](first), oldKit.capture[setter](second)].map((change) => assert.rejects(change, unsupported)));
    const oldStart = oldKit.capture.start(() => {});
    await flush();
    oldKit.permissions[0]?.(stream('mic-a'));
    await assert.rejects(oldStart, unsupported, `${operation}: an old kit still fails start instead of silently using the engine default`);
    assert.equal(oldKit.commands.includes('start'), false);
    await oldKit.capture.dispose();

    sent.length = 0;
    settle.clear();
    const superseded = environment({ [operation]: respond }, { [operation]: configured });
    const overlapping = [superseded.capture[setter](first), superseded.capture[setter](second)];
    await flush();
    settle.get(first).reject(new Error('tellus_capture_cancelled'));
    settle.get(second).resolve();
    await assert.rejects(overlapping[0], /tellus_capture_cancelled/);
    await overlapping[1];
    const restarting = superseded.capture.start(() => {});
    await flush();
    superseded.permissions[0](stream('mic-a'));
    await restarting;
    assert.deepEqual(sent, [first, second], `${operation}: a successful runtime change supersedes the configured value`);
    await superseded.capture.dispose();
  }
});

test('start waits for runtime changes still in flight and never sends the configured value after a newer runtime value', async () => {
  for (const [operation, setter, configured, first, second] of [
    ['closeTalkThresholdDb', 'setCloseTalkThresholdDb', 25, 20, 18],
    ['denoiseAttenuationLimitDb', 'setDenoiseAttenuationLimitDb', 6, 9, 4],
  ]) {
    const deferred = () => {
      const sent = [];
      const settle = new Map();
      const respond = (command) => {
        sent.push(command.db);
        if (command.db === configured) return;
        return new Promise((resolve, reject) => { settle.set(command.db, { resolve, reject }); });
      };
      return { sent, settle, ...environment({ [operation]: respond }, { [operation]: configured }) };
    };
    const order = (commands) => commands.filter((command) => [operation, 'start'].includes(command));

    const succeeded = deferred();
    const change = succeeded.capture[setter](first);
    await flush();
    const starting = succeeded.capture.start(() => {});
    await flush();
    assert.deepEqual(order(succeeded.commands), [operation], `${operation}: start sends nothing while the runtime change is in flight`);
    succeeded.settle.get(first).resolve();
    await change;
    await flush();
    succeeded.permissions[0](stream('mic-a'));
    await starting;
    assert.deepEqual(succeeded.sent, [first], `${operation}: a successful runtime change is never overwritten by the configured value`);
    assert.deepEqual(order(succeeded.commands), [operation, 'start']);
    await succeeded.capture.dispose();

    const failed = deferred();
    const failing = failed.capture[setter](first);
    await flush();
    const restarting = failed.capture.start(() => {});
    await flush();
    assert.deepEqual(failed.sent, [first], `${operation}: start sends nothing while the runtime change is in flight`);
    failed.settle.get(first).reject(new Error('tellus_capture_cancelled'));
    await assert.rejects(failing, /tellus_capture_cancelled/);
    await flush();
    failed.permissions[0](stream('mic-a'));
    await restarting;
    assert.deepEqual(failed.sent, [first, configured], `${operation}: start applies the configured value once the runtime change failed`);
    assert.deepEqual(order(failed.commands), [operation, operation, 'start']);
    await failed.capture.dispose();

    const queued = deferred();
    const older = queued.capture[setter](first);
    await flush();
    const queuedStart = queued.capture.start(() => {});
    await flush();
    const newer = queued.capture[setter](second);
    await flush();
    queued.settle.get(first).reject(new Error('tellus_capture_cancelled'));
    await assert.rejects(older, /tellus_capture_cancelled/);
    await flush();
    assert.deepEqual(queued.sent, [first, second], `${operation}: start keeps waiting for a change made while it waited`);
    queued.settle.get(second).resolve();
    await newer;
    await flush();
    queued.permissions[0](stream('mic-a'));
    await queuedStart;
    assert.deepEqual(queued.sent, [first, second], `${operation}: the newer change made while start waited supersedes the configured value`);
    await queued.capture.dispose();
  }
});

test('start waits before each configured value, so a runtime change made while an earlier one applies is never overwritten', async () => {
  const sent = [];
  const settle = new Map();
  const respond = (command) => {
    sent.push([command.operation, command.db]);
    return new Promise((resolve, reject) => { settle.set(command.db, { resolve, reject }); });
  };
  const { capture, permissions, commands } = environment({ closeTalkThresholdDb: respond, denoiseAttenuationLimitDb: respond }, { closeTalkThresholdDb: 25, denoiseAttenuationLimitDb: 6 });
  const starting = capture.start(() => {});
  await flush();
  const change = capture.setDenoiseAttenuationLimitDb(4);
  await flush();
  settle.get(25).resolve();
  await flush();
  assert.deepEqual(sent, [['closeTalkThresholdDb', 25], ['denoiseAttenuationLimitDb', 4]], 'start waits for the runtime change before the next configured value');
  settle.get(4).resolve();
  await change;
  await flush();
  permissions[0](stream('mic-a'));
  await starting;
  assert.deepEqual(sent, [['closeTalkThresholdDb', 25], ['denoiseAttenuationLimitDb', 4]]);
  assert.deepEqual(commands.filter((command) => ['closeTalkThresholdDb', 'denoiseAttenuationLimitDb', 'start'].includes(command)), ['closeTalkThresholdDb', 'denoiseAttenuationLimitDb', 'start']);
  await capture.dispose();
});
