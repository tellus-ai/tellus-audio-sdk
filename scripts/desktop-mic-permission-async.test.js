const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const wrapperPath = path.resolve(__dirname, '../platforms/desktop/runtime/platforms/desktop/electron/index.js');
function wrapper(nativeBinding) {
  const exports = {};
  vm.runInNewContext(fs.readFileSync(wrapperPath, 'utf8'), { exports, require(specifier) {
    if (specifier === './runtime/engine-runtime.js') return { prepareEngineRuntime: () => ({ nativeBinding }) };
    return specifier.startsWith('.') ? require(path.resolve(path.dirname(wrapperPath), specifier)) : require(specifier);
  } }, { filename: wrapperPath });
  return exports;
}

const granted = {
  granted: true, request: 'microphone', permissionScope: 'microphone', trackSource: 'microphone', backend: 'cpal_microphone',
  status: 'granted', message: 'Microphone capture permission is granted and the capture stream can be opened.',
  rawStatus: 'StreamOpenSucceeded', rawResult: { api: 'cpal.microphone.stream_open', value: true },
};

test('desktop checkMicCapturePermissionInfoAsync resolves the native worker-thread result and does not run the sync check', async () => {
  const calls = [];
  const { checkMicCapturePermissionInfoAsync } = wrapper({
    checkMicCapturePermissionInfo() { calls.push('sync'); return granted; },
    checkMicCapturePermissionInfoAsync() { calls.push('async'); return Promise.resolve(granted); },
  });

  const pending = checkMicCapturePermissionInfoAsync();

  // The wrapper runs in its own vm realm, so check the thenable shape instead of `instanceof Promise`.
  assert.equal(typeof pending.then, 'function');
  assert.deepEqual(await pending, granted);
  assert.deepEqual(calls, ['async']);
});

test('desktop checkMicCapturePermissionInfoAsync falls back to the sync check on an engine without the async export', async () => {
  const calls = [];
  const { checkMicCapturePermissionInfoAsync } = wrapper({
    checkMicCapturePermissionInfo() { calls.push('sync'); return granted; },
  });

  assert.deepEqual(await checkMicCapturePermissionInfoAsync(), granted);
  assert.deepEqual(calls, ['sync']);
});

test('desktop checkMicCapturePermissionInfoAsync resolves a native rejection to the same failure result as the sync check', async () => {
  const failure = new Error('Microphone permission denied');
  const { checkMicCapturePermissionInfo, checkMicCapturePermissionInfoAsync } = wrapper({
    checkMicCapturePermissionInfo() { throw failure; },
    checkMicCapturePermissionInfoAsync() { return Promise.reject(failure); },
  });

  const result = await checkMicCapturePermissionInfoAsync();

  assert.deepEqual(result, checkMicCapturePermissionInfo());
  assert.equal(result.granted, false);
  assert.equal(result.status, 'denied');
  assert.match(result.error, /Microphone permission denied$/);
});
