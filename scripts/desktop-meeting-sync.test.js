const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const wrapperPath = path.resolve(__dirname,
  '../platforms/desktop/runtime/platforms/desktop/electron/index.js');

// 빌드된 Desktop 래퍼를 가짜 native 바인딩과 함께 불러온다.
function loadWrapper(nativeBinding) {
  const exports = {};
  vm.runInNewContext(fs.readFileSync(wrapperPath, 'utf8'), {
    exports,
    require(specifier) {
      if (specifier === './runtime/engine-runtime.js') {
        return { prepareEngineRuntime: () => ({ nativeBinding }) };
      }
      return specifier.startsWith('.') ? require(path.resolve(path.dirname(wrapperPath), specifier)) : require(specifier);
    },
  }, { filename: wrapperPath });
  return exports;
}

// 회의 앱 동기화를 지원하는 엔진처럼 호출을 기록한다.
function meetingSyncNative(calls) {
  return class NativeAudioCapture {
    setMeetingSync(options) { calls.push(['setMeetingSync', options]); }
    getMeetingSyncState() { calls.push(['getMeetingSyncState']); return { state: 'synced', mode: 'auto', micMuted: true, micControlled: true, observedAtMs: 1 }; }
    onMeetingSync(callback) { calls.push(['onMeetingSync', callback]); }
    start(callback) { calls.push(['start', typeof callback]); }
    stop() { calls.push(['stop']); }
  };
}

test('desktop meeting sync requests reach a native engine that supports them', () => {
  const calls = [];
  const { AudioCapture } = loadWrapper({ AudioCapture: meetingSyncNative(calls) });
  const capture = new AudioCapture({ micEnabled: true, speakerEnabled: true });

  capture.setMeetingSync({ mode: 'manual', targetAppId: 'zoom' });
  const state = capture.getMeetingSyncState();

  assert.deepEqual(calls, [['setMeetingSync', { mode: 'manual', targetAppId: 'zoom' }], ['getMeetingSyncState']]);
  assert.equal(state.state, 'synced');
});

test('desktop meeting sync fails fast on a native engine without meeting sync support', () => {
  const { AudioCapture } = loadWrapper({ AudioCapture: class NativeAudioCapture {} });
  const capture = new AudioCapture({ micEnabled: true, speakerEnabled: true });

  assert.throws(() => capture.setMeetingSync({ mode: 'auto' }), /meeting_sync_unsupported/);
  assert.throws(() => capture.getMeetingSyncState(), /meeting_sync_unsupported/);
  assert.throws(() => capture.onMeetingSync(() => {}), /meeting_sync_unsupported/);
});

test('the meeting sync callback is registered again before every start because the engine releases it on stop', () => {
  const calls = [];
  const { AudioCapture } = loadWrapper({ AudioCapture: meetingSyncNative(calls) });
  const capture = new AudioCapture({ micEnabled: true, speakerEnabled: true });
  const callback = () => {};

  capture.onMeetingSync(callback);
  capture.start(() => {});
  capture.stop();
  capture.start(() => {});

  assert.deepEqual(calls.map(([name]) => name), ['onMeetingSync', 'onMeetingSync', 'start', 'stop', 'onMeetingSync', 'start']);
  assert.ok(calls.filter(([name]) => name === 'onMeetingSync').every(([, registered]) => registered === callback));
});

test('starting without a meeting sync callback leaves older engines untouched', () => {
  const calls = [];
  const { AudioCapture } = loadWrapper({ AudioCapture: class NativeAudioCapture { start() { calls.push('start'); } } });
  const capture = new AudioCapture({ micEnabled: true, speakerEnabled: true });

  capture.start(() => {});

  assert.deepEqual(calls, ['start']);
});

test('meeting candidates come from the native engine and are rejected on engines without them', async () => {
  const candidates = [{ processId: 7, appName: 'zoom.us', bundleId: 'us.zoom.xos', appId: 'zoom' }];
  const supported = loadWrapper({ AudioCapture: class NativeAudioCapture {}, getMeetingCandidates: async () => candidates });
  const unsupported = loadWrapper({ AudioCapture: class NativeAudioCapture {} });

  assert.deepEqual(await supported.getMeetingCandidates(), candidates);
  await assert.rejects(unsupported.getMeetingCandidates(), /meeting_sync_unsupported/);
});
