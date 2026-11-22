const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const wrapperPath = path.resolve(__dirname, '../platforms/desktop/runtime/platforms/desktop/electron/index.js');
function wrapper(NativeAudioCapture) {
  const exports = {};
  vm.runInNewContext(fs.readFileSync(wrapperPath, 'utf8'), { exports, require(specifier) {
    if (specifier === './runtime/engine-runtime.js') return { prepareEngineRuntime: () => ({ nativeBinding: { AudioCapture: NativeAudioCapture } }) };
    return specifier.startsWith('.') ? require(path.resolve(path.dirname(wrapperPath), specifier)) : require(specifier);
  } }, { filename: wrapperPath });
  return exports.AudioCapture;
}

test('desktop setDenoiseEnabled forwards each value once, in call order, and passes the native resolution and rejection through', async () => {
  const calls = [];
  const rejection = new Error('model_required: denoise model file not found');
  const results = [() => Promise.resolve(), () => Promise.reject(rejection)];
  const AudioCapture = wrapper(class {
    setDenoiseEnabled(enabled) { calls.push(['denoise', enabled]); return results.shift()(); }
    getStatus() { calls.push(['getStatus']); return {}; }
  });
  const capture = new AudioCapture({});

  const enabling = capture.setDenoiseEnabled(true);
  const disabling = capture.setDenoiseEnabled(false);
  // Both calls reach the native capture before either settles, so overlapping calls keep their order and the last call wins in the engine.
  assert.deepEqual(calls, [['denoise', true], ['denoise', false]]);
  assert.equal(await enabling, undefined);
  await assert.rejects(disabling, error => error === rejection);
  assert.deepEqual(calls, [['denoise', true], ['denoise', false]]);
});

test('desktop setDenoiseEnabled rejects on a native engine without the method and calls nothing', async () => {
  const calls = [];
  const AudioCapture = wrapper(class {
    start() { calls.push('start'); }
    stop() { calls.push('stop'); }
    getStatus() { calls.push('getStatus'); return {}; }
  });
  const capture = new AudioCapture({});
  const message = 'denoise_toggle_unsupported: install a native engine with runtime denoise toggle support';
  let pending;
  assert.doesNotThrow(() => { pending = capture.setDenoiseEnabled(true); }, 'an older engine rejects instead of throwing synchronously');
  await assert.rejects(pending, { message });
  await assert.rejects(capture.setDenoiseEnabled(false), { message });
  assert.deepEqual(calls, []);
});

test('desktop status passes denoiseActive through unchanged', () => {
  for (const denoiseActive of [true, false]) {
    const AudioCapture = wrapper(class { getStatus() { return { denoiseActive }; } });
    assert.equal(new AudioCapture({}).getStatus().denoiseActive, denoiseActive);
  }
});
