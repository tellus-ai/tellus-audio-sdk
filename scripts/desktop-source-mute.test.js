const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const wrapperPath = path.resolve(__dirname,
  '../platforms/desktop/runtime/platforms/desktop/electron/index.js');

// 빌드된 Desktop 래퍼를 가짜 native AudioCapture와 함께 불러온다.
function loadWrapper(NativeAudioCapture) {
  const exports = {};
  vm.runInNewContext(fs.readFileSync(wrapperPath, 'utf8'), {
    exports,
    require(specifier) {
      if (specifier === './runtime/engine-runtime.js') {
        return { prepareEngineRuntime: () => ({ nativeBinding: { AudioCapture: NativeAudioCapture } }) };
      }
      return specifier.startsWith('.') ? require(path.resolve(path.dirname(wrapperPath), specifier)) : require(specifier);
    },
  }, { filename: wrapperPath });
  return exports;
}

test('desktop source mute requests reach a native engine that supports them', () => {
  const calls = [];
  const { AudioCapture } = loadWrapper(class NativeAudioCapture {
    setMicMuted(muted) { calls.push(['mic', muted]); }
    setSpeakerMuted(muted) { calls.push(['speaker', muted]); }
  });
  const capture = new AudioCapture({ micEnabled: true, speakerEnabled: true });

  capture.setMicMuted(true);
  capture.setSpeakerMuted(false);

  assert.deepEqual(calls, [['mic', true], ['speaker', false]]);
});

test('desktop source mute fails fast on a native engine without mute support', () => {
  const { AudioCapture } = loadWrapper(class NativeAudioCapture {});
  const capture = new AudioCapture({ micEnabled: true, speakerEnabled: true });

  assert.throws(() => capture.setMicMuted(true), /source_mute_unsupported/);
  assert.throws(() => capture.setSpeakerMuted(true), /source_mute_unsupported/);
});
