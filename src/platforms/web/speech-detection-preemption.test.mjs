import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioEngine, SpeechDetector } from '@tellus-ai/audio-sdk-web';

const preempted = 'speech_detection_preempted_by_capture';
const isPreempted = (error) => error.message === preempted;
const assets = { engineModuleUrl: 'engine.mjs', wasmUrl: 'engine.wasm', ortWasmBaseUrl: 'ort/', encryptedModels: [], speechDetectionModelUrl: 'silero.onnx' };
const flush = () => new Promise(setImmediate);
const frame = { data: { samples: new Float32Array(128), nativeRate: 48000 } };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function environment(t) {
  const effects = [];
  const inputs = new Map();
  const streams = new Map();
  const taps = [];
  const workers = [];
  const replies = new Map();
  let sessionId = 0;
  globalThis.document = { baseURI: 'https://example.test/', visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.AudioContext = class {
    destination = {};
    currentTime = 0;
    sampleRate = 48000;
    audioWorklet = { addModule: async () => {} };
    resume = async () => {};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async close() {}
  };
  globalThis.AudioWorkletNode = class {
    constructor() { taps.push(this); }
    port = { postMessage() {}, close() {}, onmessage: null };
    connect() {}
    disconnect() {}
  };
  globalThis.Worker = class {
    constructor(url) {
      this.kind = url.pathname.endsWith('/speech-detection-worker.js') ? 'detector' : 'capture';
      workers.push(this);
    }
    postMessage({ id, command, cancel }) {
      if (cancel) return replies.get(this.kind + '/cancel')?.();
      const value = () => {
        const custom = replies.get(this.kind + '/' + command.operation);
        if (custom) return custom(command);
        switch (command.operation) {
          case 'create': return ++sessionId;
          case 'applyAuthorization': return { state: 'authorized', remaining_ms: 120000 };
          case 'stop': return [];
        }
      };
      void Promise.resolve().then(value).then(
        (reply) => this.onmessage({ data: this.kind === 'detector' ? { id, events: reply } : { id, result: reply } }),
        (error) => this.onmessage({ data: { id, error: error.message } }),
      );
    }
    terminate() {}
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { async getUserMedia({ audio }) {
      const name = audio.deviceId.exact;
      effects.push('open ' + name);
      const track = {
        readyState: 'live', enabled: true, getSettings: () => ({ deviceId: name }),
        stop() { this.readyState = 'ended'; effects.push('close ' + name); },
        addEventListener() {}, removeEventListener() {},
      };
      const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
      streams.set(name, stream);
      await inputs.get(name)?.promise;
      return stream;
    } },
  } });
  async function detector() {
    const value = await SpeechDetector.init(assets);
    t.after(() => value.dispose().catch(() => {}));
    return value;
  }
  async function capture(name, authorize = true) {
    const engine = await AudioEngine.init({ micDeviceId: name }, assets);
    t.after(() => engine.dispose().catch(() => {}));
    const value = engine.createCapture();
    if (authorize) await value.applyAuthorization('permit');
    return value;
  }
  return { detector, capture, effects, inputs, replies, streams, taps, workers };
}

test('capture closes every detector microphone and sends one terminal error per running detector', async (t) => {
  const env = environment(t);
  const first = await env.detector();
  const second = await env.detector();
  const rejected = await env.detector();
  const capture = await env.capture('capture');
  const received = [];
  await first.start((error, event) => received.push([error?.message, event]), 'first');
  await second.start((error, event) => received.push([error?.message, event]), 'second');
  const latePush = deferred();
  env.replies.set('detector/push', () => latePush.promise);
  env.taps[0].port.onmessage(frame);
  await capture.start(() => {});
  assert.deepEqual(env.effects, ['open first', 'open second', 'close first', 'close second', 'open capture']);
  await assert.rejects(rejected.start(() => {}, 'rejected'), isPreempted);
  latePush.resolve([{ speaking: true, timestampMs: 1024 }]);
  env.taps[0].port.onmessage(frame);
  await flush();
  assert.deepEqual(received, [[preempted, undefined], [preempted, undefined]]);
  await capture.stop();
  assert.deepEqual(env.effects.at(-1), 'close capture');
  await first.start(() => {}, 'first-restarted');
  assert.deepEqual(env.effects.at(-1), 'open first-restarted');
});

test('capture waits for a late detector permission result and closes its track before opening a microphone', async (t) => {
  const env = environment(t);
  const pendingInput = deferred();
  env.inputs.set('detector', pendingInput);
  const detector = await env.detector();
  const capture = await env.capture('capture');
  let outcome;
  const callbacks = [];
  const detecting = detector.start((error) => callbacks.push(error), 'detector').catch((error) => { outcome = error.message; });
  await flush();
  const starting = capture.start(() => {});
  await flush();
  assert.deepEqual(env.effects, ['open detector']);
  assert.equal(outcome, preempted);
  pendingInput.resolve();
  await Promise.all([detecting, starting]);
  assert.deepEqual(env.effects, ['open detector', 'close detector', 'open capture']);
  assert.deepEqual(callbacks, []);
});

test('preemption before microphone permission ignores a late detector worker start', async (t) => {
  const env = environment(t);
  const workerStart = deferred();
  env.replies.set('detector/start', () => workerStart.promise);
  const detector = await env.detector();
  const capture = await env.capture('capture');
  const detecting = detector.start(() => assert.fail('pending detector callback'), 'detector');
  const outcome = detecting.then(() => undefined, (error) => error.message);
  await flush();
  await capture.start(() => {});
  await flush();
  assert.deepEqual(env.effects, ['open capture']);
  const result = await Promise.race([outcome, Promise.resolve('unfinished')]);
  assert.equal(result, preempted);
  workerStart.resolve();
  await flush();
  assert.deepEqual(env.effects, ['open capture']);
});

test('a throwing or reentrant detector callback cannot block capture', async (t) => {
  const env = environment(t);
  const detector = await env.detector();
  const capture = await env.capture('capture');
  const errors = [];
  const log = t.mock.method(console, 'error', () => {});
  let retry;
  await detector.start((error) => {
    errors.push(error.message);
    retry = detector.start(() => {}, 'reentrant').catch((failure) => failure.message);
    throw new Error('test callback failure');
  }, 'detector');
  await capture.start(() => {});
  assert.deepEqual(errors, [preempted]);
  assert.equal(await retry, preempted);
  assert.equal(log.mock.callCount(), 1);
  assert.deepEqual(env.effects, ['open detector', 'close detector', 'open capture']);
});

test('capture authorization and configuration failures leave a detector running', async (t) => {
  const env = environment(t);
  const detector = await env.detector();
  const capture = await env.capture('capture', false);
  const errors = [];
  await detector.start((error) => errors.push(error), 'detector');
  env.replies.set('capture/start', () => { throw new Error('engine_authorization_required'); });
  await assert.rejects(capture.start(() => {}), /engine_authorization_required/);
  await assert.rejects(AudioEngine.init({ micDeviceId: '' }, assets), (error) => error.deviceStatus.code === 'unavailable');
  assert.deepEqual(errors, []);
  assert.deepEqual(env.effects, ['open detector']);
});

test('a paused capture keeps priority when another capture stops and a duplicate start rejects', async (t) => {
  const env = environment(t);
  const detector = await env.detector();
  const first = await env.capture('first');
  const second = await env.capture('second');
  await Promise.all([first.start(() => {}), second.start(() => {})]);
  await second.pause();
  await first.stop();
  await assert.rejects(second.start(() => {}), /tellus_capture_already_running/);
  await assert.rejects(detector.start(() => {}, 'detector'), isPreempted);
  assert.equal(env.streams.get('second').getTracks()[0].readyState, 'live');
  assert.equal(env.streams.get('second').getTracks()[0].enabled, false);
  await second.stop();
  await detector.start(() => {}, 'detector');
});

for (const stop of ['stop', 'dispose']) {
  test(`capture ${stop} cancels start and closes a late microphone track`, async (t) => {
    const env = environment(t);
    const pendingInput = deferred();
    env.inputs.set('capture', pendingInput);
    const detector = await env.detector();
    const capture = await env.capture('capture');
    const chunks = [];
    const starting = capture.start((error, chunk) => chunks.push([error, chunk]));
    await flush();
    await assert.rejects(detector.start(() => {}, 'blocked'), isPreempted);
    await capture[stop]();
    await detector.start(() => {}, 'detector');
    pendingInput.resolve();
    await starting;
    await flush();
    assert.deepEqual(chunks, []);
    assert.deepEqual(env.effects, ['open capture', 'open detector', 'close capture']);
  });
}

test('denied capture microphone permission releases priority without restarting the detector', async (t) => {
  const env = environment(t);
  const pendingInput = deferred();
  env.inputs.set('capture', pendingInput);
  const detector = await env.detector();
  const capture = await env.capture('capture');
  const errors = [];
  await detector.start((error) => errors.push(error.message), 'detector');
  const rejected = assert.rejects(capture.start(() => {}), (error) => error.deviceStatus.code === 'permission_denied');
  await flush();
  pendingInput.reject(new DOMException('denied', 'NotAllowedError'));
  await rejected;
  assert.deepEqual(errors, [preempted]);
  assert.deepEqual(env.effects, ['open detector', 'close detector', 'open capture']);
  await detector.start(() => {}, 'detector-retry');
});

for (const operation of ['stop', 'destroy']) {
  test(`capture worker ${operation} failure releases the microphone and priority`, async (t) => {
    const env = environment(t);
    const detector = await env.detector();
    const capture = await env.capture('capture');
    await capture.start(() => {});
    env.replies.set('capture/' + operation, () => { throw new Error('worker request failed'); });
    const releasing = operation === 'stop' ? capture.stop() : capture.dispose();
    await assert.rejects(releasing, /worker request failed/);
    if (operation === 'destroy') await assert.rejects(capture.start(() => {}), /tellus_capture_disposed/);
    assert.deepEqual(env.effects, ['open capture', 'close capture']);
    await detector.start(() => {}, 'detector');
  });
}

test('a detector worker stop failure cannot block microphone handoff', async (t) => {
  const env = environment(t);
  const detector = await env.detector();
  const capture = await env.capture('capture');
  const errors = [];
  env.replies.set('detector/stop', () => { throw new Error('worker stop failed'); });
  await detector.start((error) => errors.push(error.message), 'detector');
  await capture.start(() => {});
  await flush();
  assert.deepEqual(errors, [preempted]);
  assert.deepEqual(env.effects, ['open detector', 'close detector', 'open capture']);
});

test('a fatal detector worker error closes the microphone and reports once', async (t) => {
  const env = environment(t);
  const detector = await env.detector();
  const capture = await env.capture('capture');
  const errors = [];
  await detector.start((error) => errors.push(error.message), 'detector');
  env.workers[0].onmessageerror();
  env.workers[0].onerror();
  await capture.start(() => {});
  assert.deepEqual(errors, ['tellus_worker_message_invalid']);
  assert.deepEqual(env.effects, ['open detector', 'close detector', 'open capture']);
});

test('a fatal paused capture worker error releases the microphone without waiting for audio', async (t) => {
  const env = environment(t);
  const capture = await env.capture('capture');
  const detector = await env.detector();
  const errors = [];
  await capture.start((error) => errors.push(error.message));
  await capture.pause();
  env.workers[0].onerror();
  env.workers[0].onmessageerror();
  assert.deepEqual(errors, ['tellus_worker_failed']);
  assert.deepEqual(env.effects, ['open capture', 'close capture']);
  await detector.start(() => {}, 'detector');
});

test('a fatal capture worker error rejects start while microphone permission is pending', async (t) => {
  const env = environment(t);
  const pendingInput = deferred();
  env.inputs.set('capture', pendingInput);
  const capture = await env.capture('capture');
  const detector = await env.detector();
  const started = capture.start(() => assert.fail('pending capture callback'));
  let outcome;
  void started.catch((error) => { outcome = error.message; });
  await flush();
  env.workers[0].onerror();
  await flush();
  assert.equal(outcome, 'tellus_worker_failed');
  await detector.start(() => {}, 'detector');
  pendingInput.resolve();
  await flush();
  assert.deepEqual(env.effects, ['open capture', 'open detector', 'close capture']);
});

test('authorization expiry releases paused capture microphone and priority without waiting for audio', async (t) => {
  const env = environment(t);
  env.replies.set('capture/applyAuthorization', () => ({ state: 'authorized', remaining_ms: 120 }));
  const capture = await env.capture('capture');
  const detector = await env.detector();
  const terminal = deferred();
  await capture.start((error) => terminal.resolve(error.message));
  await capture.pause();
  const deadline = setTimeout(() => terminal.resolve('no expiry callback'), 500);
  assert.equal(await terminal.promise.finally(() => clearTimeout(deadline)), 'engine_authorization_expired');
  assert.deepEqual(env.effects, ['open capture', 'close capture']);
  await detector.start(() => {}, 'detector');
});


test('capture waits for a late permission result from a detector that already stopped', async (t) => {
  const env = environment(t);
  const pendingInput = deferred();
  env.inputs.set('detector', pendingInput);
  const detector = await env.detector();
  const capture = await env.capture('capture');
  const detecting = detector.start(() => {}, 'detector');
  await flush();
  await detector.stop();
  const starting = capture.start(() => {});
  await flush();
  assert.deepEqual(env.effects, ['open detector']);
  pendingInput.resolve();
  await Promise.all([detecting, starting]);
  assert.deepEqual(env.effects, ['open detector', 'close detector', 'open capture']);
});

for (const method of ['stop', 'dispose']) {
  test('detector ' + method + ' discards a late worker result', async (t) => {
    const env = environment(t);
    const detector = await env.detector();
    const latePush = deferred();
    env.replies.set('detector/push', () => latePush.promise);
    const received = [];
    await detector.start((error, event) => received.push([error, event]), 'detector');
    env.taps[0].port.onmessage(frame);
    await flush();
    await detector[method]();
    if (method === 'stop') {
      await detector.start((error, event) => received.push([error, event]), 'replacement');
    }
    latePush.resolve([{ speaking: true, timestampMs: 1024 }]);
    await flush();
    assert.deepEqual(received, []);
    assert.deepEqual(env.effects, [
      'open detector', 'close detector', ...(method === 'stop' ? ['open replacement'] : []),
    ]);
  });
}

test('stopping capture from a detector callback cancels microphone acquisition', async (t) => {
  const env = environment(t);
  const first = await env.detector();
  const second = await env.detector();
  const capture = await env.capture('capture');
  let stopping, tracksBeforeCallback;
  await first.start(() => {
    tracksBeforeCallback = [...env.effects];
    stopping = capture.stop();
  }, 'first');
  await second.start(() => {}, 'second');
  await capture.start(() => {});
  await stopping;
  assert.deepEqual(tracksBeforeCallback, ['open first', 'open second', 'close first', 'close second']);
  assert.deepEqual(env.effects, tracksBeforeCallback);
  await first.start(() => {}, 'detector-restarted');
});

test('a permit that expires during microphone handoff cannot open capture input', async (t) => {
  const env = environment(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const pendingInput = deferred();
  env.inputs.set('detector', pendingInput);
  const detector = await env.detector();
  const capture = await env.capture('capture');
  const detecting = assert.rejects(detector.start(() => {}, 'detector'), isPreempted);
  await flush();
  const starting = assert.rejects(capture.start(() => {}), /engine_authorization_expired/);
  await detecting;
  now += 120001;
  pendingInput.resolve();
  await starting;
  assert.deepEqual(env.effects, ['open detector', 'close detector']);
  await detector.start(() => {}, 'detector-restarted');
});

for (const control of ['reset', 'setDenoiseEnabled']) {
  test(`${control} during microphone setup does not cancel capture start`, async (t) => {
    const env = environment(t);
    const pendingInput = deferred();
    env.inputs.set('capture', pendingInput);
    const capture = await env.capture('capture');
    const detector = await env.detector();
    const starting = capture.start(() => {});
    await flush();
    await capture[control](true);
    pendingInput.resolve();
    await starting;
    assert.equal(env.streams.get('capture').getTracks()[0].readyState, 'live');
    assert.equal(env.taps.length, 1);
    await assert.rejects(detector.start(() => {}, 'blocked'), isPreempted);
    await capture.stop();
    await detector.start(() => {}, 'detector');
  });
}

test('a failed capture worker cancel still closes the track and releases priority', async (t) => {
  const env = environment(t);
  const capture = await env.capture('capture');
  const detector = await env.detector();
  await capture.start(() => {});
  env.replies.set('capture/cancel', () => { throw new Error('worker is unavailable'); });
  await assert.rejects(capture.stop(), /worker is unavailable/);
  assert.deepEqual(env.effects, ['open capture', 'close capture']);
  await detector.start(() => {}, 'detector');
});
