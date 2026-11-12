const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const wrapperPath = path.resolve(__dirname, '../platforms/desktop/runtime/platforms/desktop/electron/index.js');
function wrapper(NativeAudioCapture, nativeMethods = {}, entry = 'AudioCapture') {
  const exports = {};
  vm.runInNewContext(fs.readFileSync(wrapperPath, 'utf8'), { exports, require(specifier) {
    if (specifier === './runtime/engine-runtime.js') return { prepareEngineRuntime: () => ({ nativeBinding: { AudioCapture: NativeAudioCapture, ...nativeMethods } }) };
    return specifier.startsWith('.') ? require(path.resolve(path.dirname(wrapperPath), specifier)) : require(specifier);
  } }, { filename: wrapperPath });
  return exports[entry];
}

test('desktop close-talk threshold requires a native engine with the setter', () => {
  const AudioCapture = wrapper(class { constructor(config) { this.config = config; } getStatus() { return {}; } });
  assert.throws(() => new AudioCapture({ closeTalkThresholdDb: 25 }), /close_talk_threshold_unsupported: install a native engine with close-talk threshold support/);
  const capture = new AudioCapture({});
  assert.throws(() => capture.setCloseTalkThresholdDb(25), /close_talk_threshold_unsupported/);
});

test('desktop close-talk threshold config and runtime changes reach the owning native capture', () => {
  const calls = [];
  const AudioCapture = wrapper(class {
    constructor(config) { this.config = config; }
    setCloseTalkThresholdDb(db) { calls.push(db); }
    getStatus() { return { closeTalkThresholdDb: 25 }; }
  });
  const capture = new AudioCapture({ closeTalkThresholdDb: 25 });
  assert.equal(capture.getStatus().closeTalkThresholdDb, 25);
  capture.setCloseTalkThresholdDb(22);
  assert.deepEqual(calls, [22]);
});

test('desktop passes the close-talk threshold config to the native constructor unchanged', () => {
  let configured;
  const AudioCapture = wrapper(class { constructor(config) { configured = config; } setCloseTalkThresholdDb() {} });
  new AudioCapture({ closeTalkThresholdDb: 25 });
  assert.equal(configured.closeTalkThresholdDb, 25);
});

test('desktop denoise attenuation limit requires a native engine with its own setter', () => {
  const AudioCapture = wrapper(class { constructor(config) { this.config = config; } setCloseTalkThresholdDb() {} getStatus() { return {}; } });
  assert.throws(() => new AudioCapture({ denoiseAttenuationLimitDb: 6 }), /denoise_attenuation_limit_unsupported: install a native engine with denoise attenuation limit support/);
  const capture = new AudioCapture({ closeTalkThresholdDb: 25 });
  assert.throws(() => capture.setDenoiseAttenuationLimitDb(6), /denoise_attenuation_limit_unsupported/);
});

test('desktop denoise attenuation limit config and runtime changes reach the owning native capture', () => {
  const calls = [];
  const AudioCapture = wrapper(class {
    constructor(config) { this.config = config; }
    setDenoiseAttenuationLimitDb(db) { calls.push(db); }
    getStatus() { return { denoiseAttenuationLimitDb: 6 }; }
  });
  const capture = new AudioCapture({ denoiseAttenuationLimitDb: 6 });
  assert.equal(capture.getStatus().denoiseAttenuationLimitDb, 6);
  capture.setDenoiseAttenuationLimitDb(9);
  assert.deepEqual(calls, [9]);
});

test('desktop passes the denoise attenuation limit config to the native constructor unchanged', () => {
  let configured;
  const AudioCapture = wrapper(class { constructor(config) { configured = config; } setDenoiseAttenuationLimitDb() {} });
  new AudioCapture({ denoiseAttenuationLimitDb: 6 });
  assert.equal(configured.denoiseAttenuationLimitDb, 6);
});
