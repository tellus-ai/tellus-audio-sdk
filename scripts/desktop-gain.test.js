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

test('desktop initialization validates before invoking native initialization or preload', () => {
  for (const entry of ['init', 'preloadModels']) {
    const configured = [];
    const initialize = wrapper(class {}, { [entry]: config => { configured.push(config); return {}; } }, entry);
    assert.throws(() => initialize({ micGainDb: NaN }), /invalid_audio_gain_db/);
    assert.throws(() => initialize({ autoGainControl: { maxGainDb: 31 } }), /invalid_auto_gain_control/);
    assert.equal(configured.length, 0);
    initialize({ micGainDb: -2, autoGainControl: { enabled: true } });
    assert.equal(configured[0].micGainDb, -2);
    assert.equal(configured[0].autoGainControl.maxGainDb, 12);
  }
});

test('desktop gain configuration and runtime changes reach the owning native capture', () => {
  let configured;
  const values = [];
  const AudioCapture = wrapper(class {
    constructor(config) { configured = config; }
    setMicGainDb(db) { values.push(['mic', db]); }
    setSpeakerGainDb(db) { values.push(['speaker', db]); }
  });
  const capture = new AudioCapture({ micGainDb: -4, speakerGainDb: 3, autoGainControl: { enabled: true, maxGainDb: 8 } });
  assert.equal(configured.micGainDb, -4);
  assert.equal(configured.speakerGainDb, 3);
  assert.equal(configured.autoGainControl.enabled, true);
  assert.equal(configured.autoGainControl.maxGainDb, 8);
  assert.equal(configured.autoGainControl.maxOutputNoiseLevelDbfs, -50);
  capture.setMicGainDb(-60);
  capture.setSpeakerGainDb(12);
  assert.deepEqual(values, [['mic', -60], ['speaker', 12]]);
});

test('desktop rejects malformed gain settings before native creation or mutation', () => {
  let created = 0;
  const values = [];
  const AudioCapture = wrapper(class {
    constructor() { created++; }
    setMicGainDb(db) { values.push(db); }
    setSpeakerGainDb(db) { values.push(db); }
  });
  for (const db of [NaN, Infinity, -Infinity, -60.1, 12.1, '2', null]) {
    assert.throws(() => new AudioCapture({ micGainDb: db }), /gain.*invalid|invalid.*gain/);
    assert.throws(() => new AudioCapture({ speakerGainDb: db }), /gain.*invalid|invalid.*gain/);
  }
  assert.equal(created, 0);
  const capture = new AudioCapture();
  for (const db of [NaN, Infinity, -60.1, 12.1, '2', null]) {
    assert.throws(() => capture.setMicGainDb(db), /gain.*invalid|invalid.*gain/);
    assert.throws(() => capture.setSpeakerGainDb(db), /gain.*invalid|invalid.*gain/);
  }
  assert.deepEqual(values, []);
});

test('desktop never silently ignores gain settings on older engines', () => {
  const AudioCapture = wrapper(class {});
  assert.throws(() => new AudioCapture({ micGainDb: 1 }), /gain_unsupported/);
  assert.throws(() => new AudioCapture({ autoGainControl: { enabled: true } }), /gain_unsupported/);
  const capture = new AudioCapture();
  assert.throws(() => capture.setMicGainDb(1), /gain_unsupported/);
  assert.throws(() => capture.setSpeakerGainDb(1), /gain_unsupported/);
});
