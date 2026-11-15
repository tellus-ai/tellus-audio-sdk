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

const settings = [
  { key: 'closeTalkHoldMs', setter: 'setCloseTalkHoldMs', value: 100,
    error: 'close_talk_hold_unsupported: install a native engine with close-talk hold support' },
  { key: 'closeTalkKeepGapDb', setter: 'setCloseTalkKeepGapDb', value: 6,
    error: 'close_talk_keep_gap_unsupported: install a native engine with close-talk keep gap support' },
  { key: 'closeTalkLevelMarginDb', setter: 'setCloseTalkLevelMarginDb', value: 3,
    error: 'close_talk_level_margin_unsupported: install a native engine with close-talk level margin support' },
  { key: 'closeTalkLearnedLevelDbfs', setter: 'setCloseTalkLearnedLevelDbfs', value: -18,
    error: 'close_talk_learned_level_unsupported: install a native engine with close-talk learned level support' },
];

test('desktop close-talk tuning rejects each setting on a native engine without its own setter', () => {
  for (const { key, setter, value, error } of settings) {
    const others = Object.fromEntries(settings.filter(other => other.setter !== setter).map(other => [other.setter, () => {}]));
    const AudioCapture = wrapper(class { constructor() { Object.assign(this, others); } getStatus() { return {}; } });
    assert.throws(() => new AudioCapture({ [key]: value }), { message: error });
    const capture = new AudioCapture({});
    assert.throws(() => capture[setter](value), { message: error });
  }
});

test('desktop close-talk learned level null config is the engine default and needs no setter', () => {
  const AudioCapture = wrapper(class { getStatus() { return {}; } });
  assert.doesNotThrow(() => new AudioCapture({ closeTalkLearnedLevelDbfs: null }));
});

test('desktop close-talk tuning config and runtime changes reach the owning native capture unchanged', () => {
  const calls = [];
  let configured;
  const status = { closeTalkHoldMs: 100, closeTalkKeepGapDb: 6, closeTalkLevelMarginDb: 3,
    closeTalkLearnedLevelDbfs: null, closeTalkLevelLearned: false };
  const AudioCapture = wrapper(class {
    constructor(config) { configured = config; }
    setCloseTalkHoldMs(ms) { calls.push(['hold', ms]); }
    setCloseTalkKeepGapDb(db) { calls.push(['keepGap', db]); }
    setCloseTalkLevelMarginDb(db) { calls.push(['levelMargin', db]); }
    setCloseTalkLearnedLevelDbfs(dbfs) { calls.push(['learnedLevel', dbfs]); }
    getStatus() { return status; }
  });
  const capture = new AudioCapture({ closeTalkHoldMs: 100, closeTalkKeepGapDb: 6, closeTalkLevelMarginDb: 3, closeTalkLearnedLevelDbfs: -18 });
  assert.deepEqual([configured.closeTalkHoldMs, configured.closeTalkKeepGapDb, configured.closeTalkLevelMarginDb, configured.closeTalkLearnedLevelDbfs],
    [100, 6, 3, -18]);
  assert.deepEqual(capture.getStatus(), status);
  capture.setCloseTalkHoldMs(0);
  capture.setCloseTalkKeepGapDb(20);
  capture.setCloseTalkLevelMarginDb(0);
  capture.setCloseTalkLearnedLevelDbfs(-30);
  capture.setCloseTalkLearnedLevelDbfs(null);
  assert.deepEqual(calls, [['hold', 0], ['keepGap', 20], ['levelMargin', 0], ['learnedLevel', -30], ['learnedLevel', null]]);
});

test('desktop close-talk tuning passes native validation errors through', () => {
  const AudioCapture = wrapper(class {
    setCloseTalkHoldMs() { throw new Error('invalid_close_talk_hold_ms: expected a finite value within 0..=2000'); }
  });
  const capture = new AudioCapture({});
  assert.throws(() => capture.setCloseTalkHoldMs(2001), { message: 'invalid_close_talk_hold_ms: expected a finite value within 0..=2000' });
});
