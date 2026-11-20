const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const packageName = '@tellus-ai/audio-sdk-desktop';
const entry = require.resolve(packageName);
const engineRuntime = require(path.join(path.dirname(entry), 'runtime/engine-runtime.js'));

function loadDesktop(nativeBinding) {
  const prepareEngineRuntime = engineRuntime.prepareEngineRuntime;
  engineRuntime.prepareEngineRuntime = () => ({ nativeBinding });
  try {
    return require(packageName);
  } finally {
    delete require.cache[entry];
    engineRuntime.prepareEngineRuntime = prepareEngineRuntime;
  }
}

test('desktop root starts and stops speech detection with the selected device and no capture setup', () => {
  let emit;
  const calls = [];
  const { SpeechDetector } = loadDesktop({
    init() { assert.fail('speech detection initialized AudioEngine'); },
    preloadModels() { assert.fail('speech detection preloaded capture models'); },
    AudioCapture: class {
      constructor() { assert.fail('speech detection constructed AudioCapture'); }
    },
    SpeechDetector: class {
      constructor(...args) { assert.deepEqual(args, []); }
      start(callback, deviceId) {
        emit = callback;
        calls.push(['start', deviceId]);
      }
      stop() { calls.push(['stop']); }
    },
  });
  const detector = new SpeechDetector();
  const events = [];
  const callback = (error, event) => {
    assert.equal(error, null);
    events.push(event);
  };

  assert.equal(detector.start(callback, 'usb-microphone'), undefined);
  emit(null, { speaking: true, timestampMs: 1024 });
  assert.equal(detector.stop(), undefined);
  assert.equal(detector.start(callback), undefined);
  emit(null, { speaking: false, timestampMs: 1024 });
  assert.equal(detector.stop(), undefined);

  assert.deepEqual(calls, [['start', 'usb-microphone'], ['stop'], ['start', undefined], ['stop']]);
  assert.deepEqual(events, [
    { speaking: true, timestampMs: 1024 },
    { speaking: false, timestampMs: 1024 },
  ]);
});

test('desktop delivers the native terminal error without requiring a speech event', () => {
  let emit;
  const { SpeechDetector } = loadDesktop({
    SpeechDetector: class {
      start(callback) { emit = callback; }
    },
  });
  const detector = new SpeechDetector();
  const notifications = [];
  detector.start((...args) => notifications.push(args));
  const error = new Error('speech_detection_preempted_by_capture');
  emit(error);
  assert.deepEqual(notifications, [[error]]);
});

test('desktop propagates a native start failure synchronously', () => {
  const error = new Error('speech_detection_preempted_by_capture');
  const { SpeechDetector } = loadDesktop({
    SpeechDetector: class {
      start() { throw error; }
    },
  });
  const detector = new SpeechDetector();
  assert.throws(() => detector.start(() => assert.fail('start failure invoked the callback')), error);
});

test('desktop root remains importable with older engines and detector construction reports unsupported', () => {
  const { AudioEngine, SpeechDetector } = loadDesktop({ AudioCapture: class {} });
  assert.equal(typeof AudioEngine.init, 'function');
  assert.throws(() => new SpeechDetector(), /speech_detection_unsupported/);
});
