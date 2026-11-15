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

test('desktop input hold forwards each call to the native capture exactly once, in order, before start', () => {
  const calls = [];
  const AudioCapture = wrapper(class {
    holdInput() { calls.push('hold'); }
    releaseInput() { calls.push('release'); }
    start() { calls.push('start'); }
    getStatus() { return {}; }
  });
  const capture = new AudioCapture({});
  assert.equal(capture.holdInput(), undefined);
  assert.deepEqual(calls, ['hold']);
  assert.equal(capture.releaseInput(), undefined);
  assert.deepEqual(calls, ['hold', 'release']);
});

test('desktop input hold rejects a native engine without the methods and calls nothing else', () => {
  const calls = [];
  const AudioCapture = wrapper(class {
    start() { calls.push('start'); }
    stop() { calls.push('stop'); }
    getStatus() { calls.push('getStatus'); return {}; }
  });
  const capture = new AudioCapture({});
  const message = 'input_hold_unsupported: install a native engine with input hold support';
  assert.throws(() => capture.holdInput(), { message });
  assert.throws(() => capture.releaseInput(), { message });
  assert.deepEqual(calls, []);
});

test('desktop input hold requires both native methods', () => {
  const calls = [];
  const AudioCapture = wrapper(class { holdInput() { calls.push('hold'); } });
  const capture = new AudioCapture({});
  assert.throws(() => capture.holdInput(), /input_hold_unsupported/);
  assert.deepEqual(calls, []);
});

test('desktop status passes inputHeld through unchanged and leaves it absent when the native omits it', () => {
  const held = wrapper(class { getStatus() { return { inputHeld: true }; } });
  assert.equal(new held({}).getStatus().inputHeld, true);
  const released = wrapper(class { getStatus() { return { inputHeld: false }; } });
  assert.equal(new released({}).getStatus().inputHeld, false);
  const older = wrapper(class { getStatus() { return {}; } });
  const status = new older({}).getStatus();
  assert.equal(status.inputHeld, undefined);
  assert.equal('inputHeld' in status, false);
});
