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
    configureAudioDevices: async (mic, playback, route) => { native.selection = { mic, playback, route }; },
    getStatus: async () => JSON.stringify({ lifecycle: 'idle', denoise_enabled: true }),
    getAudioDeviceStatus: async () => JSON.stringify(native.devices),
    devices: [{ source: 'microphone', code: 'pending' }],
    listAudioDevices: async source => JSON.stringify({ status: { source, code: 'ready' }, devices: [{ id: 'input-2', label: 'USB' }] }),
    createModelKeyRequest: async () => JSON.stringify({ public_key: '0'.repeat(64) }),
    inspectModelFile: async path => {
      native.inspected.push(path);
      return JSON.stringify({ model_id: path.replace('.temc', ''), key_id: 'test' });
    },
    applyModelKey: async () => {}, loadModelFile: async path => { native.loaded.push(path); },
    applyAuthorization: async () => { native.authorized = true; return status(); },
    getAuthorizationStatus: async () => status(),
    invalidateAuthorization: () => { native.authorized = false; ++native.epoch; },
    start: async (callback, onError) => { native.callback = callback; native.onError = onError; },
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
  const create = async (config = {}) => (await module.exports.AudioEngine.init(config, { encryptedModels: assets })).createCapture();
  const emit = () => native.callback(new Uint8Array([1]).buffer, JSON.stringify({ codec: 'opus', sample_rate: 16000,
    sample: 0, sample_count: 320, valid_sample_count: 320, timestamp: 0, rms: 0 }), native.epoch, 1n);
  return { native, create, emit, list: module.exports.listAudioDevices };
}

test('모바일 선택값은 OS adapter에만 전달하고 Rust 처리 설정에는 넣지 않는다', async () => {
  const { native, create } = fixture();
  let processing;
  native.configure = async json => { processing = JSON.parse(json); };
  const capture = await create({ micDeviceId: 'input-2', playbackDeviceId: 'output-3' });
  await capture.start(() => {});
  assert.deepEqual(native.selection, { mic: 'input-2', playback: 'output-3', route: '' });
  assert.equal(processing.micDeviceId, undefined);
  assert.equal(processing.playbackDeviceId, undefined);
});

test('명시한 빈 ID와 모바일 시스템 오디오 선택을 시작 전에 거부한다', async () => {
  const { create } = fixture();
  for (const value of ['', ' ', '\t\n', 'input-2\0other']) for (const key of ['micDeviceId', 'playbackDeviceId']) {
    await assert.rejects(create({ [key]: value }), /invalid_audio_device_id/);
  }
  await assert.rejects(create({ systemAudioDeviceId: 'output-3' }), error => error.deviceStatus.source === 'system_audio' && error.deviceStatus.code === 'unsupported');
});

test('구형 native는 명시한 장치 선택을 무시하지 않고 지원 오류를 반환한다', async () => {
  const { native, create } = fixture();
  delete native.configureAudioDevices;
  const capture = await create({ micDeviceId: 'input-2' });
  await assert.rejects(capture.start(() => {}), error => error.deviceStatus.source === 'microphone' && error.deviceStatus.code === 'unsupported');
  const defaults = await create();
  await defaults.start(() => {});
});

test('선택 구성 실패 이후에도 core 상태와 구조화된 장치 상태를 읽는다', async () => {
  const { native, create } = fixture();
  native.devices = [{ source: 'playback', code: 'unsupported', requestedDeviceId: 'output-3' }];
  native.configureAudioDevices = async () => { throw new Error('platform_selection_rejected'); };
  const capture = await create({ playbackDeviceId: 'output-3' });
  await assert.rejects(capture.start(() => {}), error => error.deviceStatus.code === 'unsupported');
  const status = await capture.getStatus();
  assert.equal(status.state, 'idle');
  assert.deepEqual(JSON.parse(JSON.stringify(status.deviceStatus)), native.devices);
});

test('시작과 재생 오류는 문자열 해석 없이 native의 장치 상태를 첨부한다', async () => {
  for (const operation of ['start', 'resume', 'playback', 'playbackEncoded']) {
    const { native, create } = fixture();
    const capture = await create({ micDeviceId: 'input-2' });
    native.devices = [{ source: operation.startsWith('playback') ? 'playback' : 'microphone', code: 'route_mismatch', requestedDeviceId: 'input-2', actualDeviceId: 'input-1' }];
    native[operation] = async () => { throw new Error('OS failed without a device token'); };
    const args = operation === 'start' ? [() => {}] : operation === 'playback' ? [new Float32Array(320), 16000]
      : operation === 'playbackEncoded' ? [new Uint8Array([1]).buffer] : [];
    await assert.rejects(capture[operation](...args), error => error.message === 'OS failed without a device token' && error.deviceStatus.code === 'route_mismatch');
  }
});

test('출력 선택 불일치는 중단에 따른 마이크 unavailable보다 우선하며 원래 오류를 보존한다', async () => {
  for (const operation of ['configureAudioDevices', 'start', 'resume', 'playback', 'playbackEncoded', 'callback']) {
    const { native, create } = fixture();
    native.devices = [{ source: 'microphone', code: 'unavailable', requestedDeviceId: 'input-2' },
      { source: 'playback', code: 'route_mismatch', requestedDeviceId: 'output-3', actualDeviceId: 'output-1' }];
    const original = new Error('OS output route failed');
    if (operation !== 'callback') native[operation] = async () => { throw original; };
    const capture = await create({ micDeviceId: 'input-2', playbackDeviceId: 'output-3' });
    if (operation === 'callback') {
      let report;
      await capture.start(error => { report = error; });
      native.onError(original.message);
      await new Promise(setImmediate);
      assert.equal(report.message, original.message);
      assert.equal(report.deviceStatus.source, 'playback');
      assert.equal(report.deviceStatus.code, 'route_mismatch');
    } else {
      const method = operation === 'configureAudioDevices' ? 'start' : operation;
      const args = method === 'start' ? [() => {}] : method === 'playback' ? [new Float32Array(320), 16000]
        : method === 'playbackEncoded' ? [new Uint8Array([1]).buffer] : [];
      await assert.rejects(capture[method](...args), error => error === original && error.deviceStatus.source === 'playback' && error.deviceStatus.code === 'route_mismatch');
    }
  }
});

test('새 입력 권한 거부는 이전 재생 실패를 가리지 않고 현재 입력 오류로 전달한다', async () => {
  for (const operation of ['start', 'resume']) {
    const { native, create } = fixture();
    native.devices = [{ source: 'playback', code: 'route_mismatch', requestedDeviceId: 'output-3' },
      { source: 'microphone', code: 'permission_denied', requestedDeviceId: 'input-2' }];
    const original = new Error('New microphone permission failed');
    native[operation] = async () => { throw original; };
    const capture = await create({ micDeviceId: 'input-2' });
    await assert.rejects(capture[operation](() => {}), error => error === original && error.deviceStatus.source === 'microphone' && error.deviceStatus.code === 'permission_denied');
  }
});

test('OS 오류 callback에도 native 장치 상태를 제공한다', async () => {
  const { native, create } = fixture();
  const capture = await create({ micDeviceId: 'input-2' });
  const reported = new Promise(resolve => capture.start(resolve));
  await new Promise(setImmediate);
  native.devices = [{ source: 'microphone', code: 'unavailable', requestedDeviceId: 'input-2' }];
  native.onError('capture_route_changed');
  assert.equal((await reported).deviceStatus.code, 'unavailable');
});

test('장치 상태 조회를 기다린 오류 callback은 이후 제어 작업 뒤 전달하지 않는다', async () => {
  for (const interrupt of ['pause', 'stop', 'invalidateAuthorization', 'dispose']) {
    const { native, create } = fixture();
    const capture = await create();
    let complete, reported = 0;
    await capture.start(() => { ++reported; });
    native.getAudioDeviceStatus = () => new Promise(resolve => { complete = resolve; });
    native.onError('capture_route_changed');
    await capture[interrupt]();
    complete(JSON.stringify([{ source: 'microphone', code: 'unavailable' }]));
    await new Promise(setImmediate);
    assert.equal(reported, 0);
  }
});

test('장치 조회는 구조화된 목록을 반환하고 임시 native 세션을 정리한다', async () => {
  const { native, list } = fixture();
  let closed = 0, disposed = 0;
  native.close = async () => { ++closed; };
  native.dispose = () => { ++disposed; };
  const result = await list('microphone');
  assert.equal(result.status.code, 'ready');
  assert.deepEqual(JSON.parse(JSON.stringify(result.devices)), [{ id: 'input-2', label: 'USB' }]);
  assert.equal(closed, 1);
  assert.equal(disposed, 1);
  native.listAudioDevices = async () => { throw new Error('list failure'); };
  await assert.rejects(list('microphone'), /list failure/);
  assert.equal(closed, 2);
  assert.equal(disposed, 2);
});

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
