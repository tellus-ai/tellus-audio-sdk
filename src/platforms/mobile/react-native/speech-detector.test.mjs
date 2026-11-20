import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as audioGain from '../../../../platforms/mobile/runtime/bindings/typescript/audio-gain.js';

// React Native SpeechDetector를 불러오고 Nitro 객체만 double로 바꾼다. double은 감지기 spec의 메서드만 갖고, 그 밖의 접근은 기록한다.
function fixture({ loadError } = {}) {
  const calls = [];
  const unexpected = [];
  const state = {
    loadModel: async path => { calls.push(['loadModel', path]); if (loadError) throw new Error(loadError); },
    start: async (micDeviceId, onEvent, onError) => { calls.push(['start', micDeviceId]); state.onEvent = onEvent; state.onError = onError; },
    stop: async () => { calls.push(['stop']); },
    dispose: () => { calls.push(['dispose']); },
  };
  const native = new Proxy(state, { get: (target, key) => {
    if (!['loadModel', 'start', 'stop', 'dispose', 'then'].includes(key)) unexpected.push(key);
    return target[key];
  } });
  const created = [];
  function load(file) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    new Function('exports', 'require', 'module', code)(module.exports, name => {
      if (name === './speech-detector.js') return load('./speech-detector.ts');
      if (name === '../../../bindings/typescript/audio-gain.js') return audioGain;
      assert.equal(name, 'react-native-nitro-modules');
      return { NitroModules: { createHybridObject: name => { created.push(name); return native; } } };
    }, module);
    return module.exports;
  }
  const { AudioEngine, SpeechDetector } = load('./index.ts');
  assert.equal(typeof SpeechDetector, 'function', 'mobile package root exports SpeechDetector');
  return { AudioEngine, SpeechDetector, state, calls, unexpected, created };
}

test('init은 감지기 Nitro 객체만 만들고 기본 SDK resource의 평문 Silero를 읽는다', async () => {
  const { SpeechDetector, calls, created } = fixture();
  await SpeechDetector.init();
  await SpeechDetector.init({ speechDetectionModel: 'file:///data/silero_vad_v6.2.onnx' });
  assert.deepEqual(created, ['TellusSpeechDetector', 'TellusSpeechDetector']);
  assert.deepEqual(calls, [['loadModel', 'silero_vad_v6.2.onnx'], ['loadModel', 'file:///data/silero_vad_v6.2.onnx']]);
});

test('모델을 읽지 못하면 init이 그 오류로 거부하고 native 객체를 닫는다', async () => {
  const { SpeechDetector, calls } = fixture({ loadError: 'speech_detection_model_not_found' });
  await assert.rejects(SpeechDetector.init(), /speech_detection_model_not_found/);
  assert.deepEqual(calls.at(-1), ['dispose']);
});

test('callback은 speaking·timestampMs 두 필드만 받고 감지 경로는 승인·모델 키·capture 메서드에 접근하지 않는다', async () => {
  const { SpeechDetector, state, calls, unexpected } = fixture();
  const detector = await SpeechDetector.init();
  const events = [];
  await detector.start((error, event) => events.push([error, event]), 'input-2');
  state.onEvent(false, 1024);
  state.onEvent(true, 2048);
  assert.deepEqual(events, [[null, { speaking: false, timestampMs: 1024 }], [null, { speaking: true, timestampMs: 2048 }]]);
  assert.deepEqual(Object.keys(events[0][1]), ['speaking', 'timestampMs']);
  await detector.dispose();
  assert.deepEqual(calls, [['loadModel', 'silero_vad_v6.2.onnx'], ['start', 'input-2'], ['stop'], ['dispose']]);
  assert.deepEqual(unexpected, []);
});

test('실행 중 start는 speech_detection_already_running으로 거부하고 stop 뒤 이벤트는 버린다', async () => {
  const { SpeechDetector, state, calls } = fixture();
  const detector = await SpeechDetector.init();
  const events = [];
  await detector.start((error, event) => events.push(event));
  const late = state.onEvent;
  await assert.rejects(detector.start(() => {}), /speech_detection_already_running/);
  await detector.stop();
  late(true, 1024);
  assert.deepEqual(events, []);
  await detector.stop();
  assert.deepEqual(calls.filter(([name]) => name === 'stop'), [['stop']]);
});

test('실행 중 오류는 한 번 알리고 감지를 끝내 다시 start할 수 있다', async () => {
  const { SpeechDetector, state } = fixture();
  const detector = await SpeechDetector.init();
  const errors = [];
  await detector.start(error => errors.push(error?.message));
  const onError = state.onError;
  onError('audio_interrupted');
  onError('audio_interrupted');
  assert.deepEqual(errors, ['audio_interrupted']);
  await detector.start(() => {});
});

test('잘못된 장치 ID와 dispose 뒤 start는 native 호출 없이 거부한다', async () => {
  const { SpeechDetector, calls } = fixture();
  const detector = await SpeechDetector.init();
  for (const id of ['', ' ', 'a\0b']) await assert.rejects(detector.start(() => {}, id), /invalid_audio_device_id/);
  await detector.dispose();
  await assert.rejects(detector.start(() => {}), /speech_detector_disposed/);
  assert.equal(calls.some(([name]) => name === 'start'), false);
});

test('선점된 시작은 Promise만 거부하고 지연 이벤트와 오류를 버린 뒤 수동 재시작할 수 있다', async () => {
  const { SpeechDetector, state } = fixture();
  const detector = await SpeechDetector.init();
  const nativeStart = state.start;
  state.start = async (...args) => {
    await nativeStart(...args);
    throw new Error('speech_detection_preempted_by_capture');
  };
  const received = [];
  await assert.rejects(detector.start((...args) => received.push(args)), /speech_detection_preempted_by_capture/);
  state.onEvent(true, 1024);
  state.onError('speech_detection_preempted_by_capture');
  assert.deepEqual(received, []);
  state.start = nativeStart;
  await detector.start((error, event) => received.push(error?.message ?? event));
  const late = state.onEvent;
  state.onError('speech_detection_preempted_by_capture');
  late(true, 2048);
  assert.deepEqual(received, ['speech_detection_preempted_by_capture']);
  await detector.start(() => {});
});

test('dispose drops both stale callbacks while pending start unwinds', async () => {
  const { SpeechDetector, state } = fixture();
  const detector = await SpeechDetector.init();
  const events = [];
  let finish;
  state.start = (_id, onEvent, onError) => {
    state.onEvent = onEvent;
    state.onError = onError;
    return new Promise((_resolve, reject) => { finish = reject; });
  };
  const rejected = assert.rejects(detector.start((...args) => events.push(args)), /speech_detection_cancelled/);
  await detector.dispose();
  state.onEvent(false, 1024);
  state.onError('audio_interrupted');
  finish(new Error('speech_detection_cancelled'));
  await rejected;
  assert.deepEqual(events, []);
});

test('an invalid capture configuration leaves running detection intact', async () => {
  const { AudioEngine, SpeechDetector, state, created } = fixture();
  const detector = await SpeechDetector.init();
  const events = [];
  await detector.start((error, event) => events.push([error, event]));
  await assert.rejects(AudioEngine.init({ processing: { sampleRate: 44101 } }), /invalid_processing_config/);
  state.onEvent(false, 1024);
  assert.deepEqual(events, [[null, { speaking: false, timestampMs: 1024 }]]);
  assert.deepEqual(created, ['TellusSpeechDetector']);
  await detector.dispose();
});
