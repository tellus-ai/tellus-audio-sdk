import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Nitro는 JS 경계 double만 사용하며 실제 공개 wrapper를 실행한다.
function fixture(assets = ['fe-s16.temc', 'silero-vad.temc']) {
  const status = () => JSON.stringify({ state: 'authorized', remaining_ms: 1000 });
  const native = {
    epoch: 1n, authorized: true, inspected: [], loaded: [], acknowledged: 0,
    configure: async () => {},
    createModelKeyRequest: async () => JSON.stringify({ public_key: '0'.repeat(64) }),
    inspectModelFile: async path => {
      native.inspected.push(path);
      return JSON.stringify({ model_id: path.replace('.temc', ''), key_id: 'test' });
    },
    applyModelKey: async () => {}, loadModelFile: async path => { native.loaded.push(path); },
    applyAuthorization: async () => { native.authorized = true; return status(); },
    getAuthorizationStatus: async () => status(),
    invalidateAuthorization: () => { native.authorized = false; ++native.epoch; },
    start: async callback => { native.callback = callback; },
    resume: async () => {}, pause: async () => {}, reset: async () => { ++native.epoch; },
    stop: async () => {}, close: async () => {}, dispose: () => {},
    setRecordingNotification: async (title, contentText, pauseAction, resumeAction, onAction) => { native.notification = onAction; },
    canDeliver: epoch => native.authorized && epoch === native.epoch,
    acknowledgeChunk: () => { ++native.acknowledged; },
  };
  const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, Uint8Array, Map, Set, Error,
    require: name => { assert.equal(name, 'react-native-nitro-modules'); return { NitroModules: { createHybridObject: () => native } }; } });
  const create = async () => (await module.exports.AudioEngine.init({}, { encryptedModels: assets })).createCapture();
  const emit = () => native.callback(new Uint8Array([1]).buffer, JSON.stringify({ codec: 'opus', sample_rate: 16000,
    sample: 0, sample_count: 320, valid_sample_count: 320, timestamp: 0, rms: 0 }), native.epoch, 1n);
  return { native, create, emit };
}

test('재승인된 capture는 기존 모델과 callback을 재사용한다', async () => {
  const { native, create, emit } = fixture();
  const capture = await create();
  const requests = await capture.createModelKeyRequests();
  await capture.applyModelKeys(requests.map(({ modelId, keyId }) => ({ modelId, keyId, wrappedKey: 'A'.repeat(107) })));
  const received = [];
  await capture.start((error, chunk) => { assert.equal(error, null); received.push(chunk); });
  emit();
  capture.invalidateAuthorization();
  emit();
  await capture.applyAuthorization('permit');
  assert.equal((await capture.createModelKeyRequests()).length, 0);
  await capture.resume();
  emit();
  assert.equal(native.inspected.length, 2);
  assert.equal(native.loaded.length, 2);
  assert.equal(received.length, 2);
  assert.equal(native.acknowledged, 3);
});

test('동일 asset 목록의 모델 중복은 거부한다', async () => {
  const { create } = fixture(['fe-s16.temc', 'fe-s16.temc']);
  await assert.rejects((await create()).createModelKeyRequests(), /duplicate_encrypted_model/);
});

test('runtime denoise 전환에 필요한 레이트별 FE와 VAD 모델 구성을 검증한다', async () => {
  for (const assets of [['fe-s48.temc', 'silero-vad.temc'], ['silero-vad.temc']]) {
    const { create } = fixture(assets);
    await assert.rejects((await create()).createModelKeyRequests(), /encrypted_model_binding_invalid/);
  }
});

test('reset 완료가 뒤의 pause 또는 invalidate를 되살리지 않는다', async () => {
  for (const interrupt of ['pause', 'invalidateAuthorization']) {
    const { native, create, emit } = fixture();
    const capture = await create();
    let received = 0, complete;
    await capture.start(() => { ++received; });
    native.reset = () => new Promise(resolve => { complete = resolve; });
    const resetting = capture.reset();
    await capture[interrupt]();
    complete();
    await resetting;
    native.authorized = true;
    emit();
    assert.equal(received, 0);
  }
});

test('JS 전달 직전 승인 변경은 payload를 폐기한다', async () => {
  const { native, create, emit } = fixture();
  const capture = await create();
  let checks = 0, received = 0;
  await capture.start(() => { ++received; });
  native.canDeliver = () => ++checks === 1;
  emit();
  assert.equal(received, 0);
  assert.equal(native.acknowledged, 1);
});

test('알림 action은 사용자 pause 뒤 유지되고 stop·dispose·승인 취소 뒤 폐기된다', async () => {
  for (const interrupt of ['stop', 'dispose', 'invalidateAuthorization']) {
    const { native, create } = fixture();
    const capture = await create();
    let actions = 0;
    await capture.setRecordingNotification({ title: '녹음', contentText: '통역 중', onResume: () => { ++actions; } });
    await capture.start(() => {});
    await capture.pause();
    native.notification('resume');
    await new Promise(setImmediate);
    assert.equal(actions, 1);
    await capture[interrupt]();
    native.notification('resume');
    await new Promise(setImmediate);
    assert.equal(actions, 1);
  }
});

test('알림 승인 조회 완료가 뒤의 무효화 이후 action을 실행하지 않는다', async () => {
  const { native, create } = fixture();
  const capture = await create();
  let actions = 0, complete;
  await capture.setRecordingNotification({ title: '녹음', contentText: '', onPause: () => { ++actions; } });
  native.getAuthorizationStatus = () => new Promise(resolve => { complete = resolve; });
  native.notification('pause');
  await new Promise(setImmediate);
  capture.invalidateAuthorization();
  complete(JSON.stringify({ state: 'authorized', remaining_ms: 1000 }));
  await new Promise(setImmediate);
  assert.equal(actions, 0);
});

test('동일 capture 재시작은 알림을 재등록하고 이전 action 완료를 폐기한다', async () => {
  const { native, create } = fixture();
  const capture = await create();
  let actions = 0, complete;
  await capture.setRecordingNotification({ title: '녹음', contentText: '', onResume: () => { ++actions; } });
  await capture.start(() => {});
  const previous = native.notification, status = native.getAuthorizationStatus;
  native.getAuthorizationStatus = () => new Promise(resolve => { complete = resolve; });
  previous('resume');
  await new Promise(setImmediate);
  await capture.stop();
  await capture.start(() => {});
  native.getAuthorizationStatus = status;
  previous('resume');
  complete(await status());
  await new Promise(setImmediate);
  assert.equal(actions, 0);
  native.notification('resume');
  await new Promise(setImmediate);
  assert.equal(actions, 1);
});

test('알림 등록 대기 중 pause·stop·invalidate는 늦은 start와 resume을 차단한다', async () => {
  for (const operation of ['start', 'resume']) for (const interrupt of ['pause', 'stop', 'invalidateAuthorization']) {
    const { native, create } = fixture();
    const capture = await create();
    await capture.setRecordingNotification({ title: '녹음', contentText: '' });
    let complete, starts = 0;
    native.setRecordingNotification = () => new Promise(resolve => { complete = resolve; });
    native.start = native.resume = async () => { ++starts; };
    const pending = capture[operation](() => {});
    await new Promise(setImmediate);
    await capture[interrupt]();
    complete();
    await assert.rejects(pending, /capture_cancelled/);
    assert.equal(starts, 0);
  }
});
