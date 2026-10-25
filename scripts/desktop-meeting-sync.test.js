const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

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

test('the accessibility permission check returns the native result and fails fast on engines without it', () => {
  const granted = { granted: true, required: true, status: 'granted', message: 'ok' };
  const supported = loadWrapper({ AudioCapture: class NativeAudioCapture {}, checkAccessibilityPermissionInfo: () => granted });
  const unsupported = loadWrapper({ AudioCapture: class NativeAudioCapture {} });

  assert.deepEqual(supported.checkAccessibilityPermissionInfo(), granted);
  assert.throws(() => unsupported.checkAccessibilityPermissionInfo(), /accessibility_permission_unsupported/);
});

test('the accessibility permission request reports what was opened like the other permission requests', () => {
  const opened = loadWrapper({ AudioCapture: class NativeAudioCapture {}, requestAccessibilityPermission: () => ({ opened: true }) });
  const failing = loadWrapper({ AudioCapture: class NativeAudioCapture {}, requestAccessibilityPermission: () => { throw new Error('settings open failed'); } });
  const unsupported = loadWrapper({ AudioCapture: class NativeAudioCapture {} });

  assert.equal(opened.requestAccessibilityPermission().opened, true);
  const failed = failing.requestAccessibilityPermission();
  assert.equal(failed.opened, false);
  assert.match(failed.error, /settings open failed/);
  const result = unsupported.requestAccessibilityPermission();
  assert.equal(result.opened, false);
  assert.match(result.error, /accessibility_permission_unsupported/);
});

// 엔진 0.4.0이 돌려주는 회의 앱 ID와 needs_link·lost 사유(엔진 src/platforms/desktop/meeting의 mod.rs·observation.rs).
const ENGINE_MEETING_APP_IDS = ['zoom', 'google_meet'];
const ENGINE_MEETING_SYNC_REASONS = ['accessibility_permission', 'control_not_found', 'unknown_label',
  'app_not_running', 'read_failed', 'meeting_hidden'];

test('desktop meeting sync types accept every app ID and reason the 0.4.0 engine reports', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-sdk-meeting-types-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const usage = path.join(directory, 'meeting-sync.ts');
  fs.writeFileSync(usage, `import type { MeetingAppId, MeetingCandidate, MeetingSyncEvent, MeetingSyncOptions, MeetingSyncReason } from ${JSON.stringify(wrapperPath)};
const apps: MeetingAppId[] = ${JSON.stringify(ENGINE_MEETING_APP_IDS)};
const reasons: MeetingSyncReason[] = ${JSON.stringify(ENGINE_MEETING_SYNC_REASONS)};
const options: MeetingSyncOptions = { mode: 'manual', targetAppId: 'google_meet' };
const candidate: MeetingCandidate = { processId: 7, appName: 'Google Chrome', bundleId: 'com.google.Chrome', appId: 'google_meet' };
const event: MeetingSyncEvent = { state: 'needs_link', mode: 'auto', appId: 'google_meet', reason: 'meeting_hidden', micMuted: false, micControlled: false, observedAtMs: 1 };
void apps; void reasons; void options; void candidate; void event;
`);
  const program = ts.createProgram([usage], { noEmit: true, strict: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});
