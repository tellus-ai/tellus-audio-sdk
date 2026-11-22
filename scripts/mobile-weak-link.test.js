const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const mobile = path.join(__dirname, '..', 'platforms', 'mobile');
const read = file => fs.readFileSync(path.join(mobile, file), 'utf8');

// Every engine function the glue references weakly must be allowed to stay undefined at the app link, or old kits fail to link.
test('mobile podspec lets every weakly referenced engine function stay undefined at the app link', () => {
  const podspec = read('TellusAudioSdk.podspec');
  const flags = podspec.match(/user_target_xcconfig\s*=\s*\{\s*'OTHER_LDFLAGS'\s*=>\s*'([^']*)'/)?.[1].split(/\s+/);
  assert.deepEqual(flags, [
    '-Wl,-U,_tellus_audio_session_set_close_talk_threshold_db',
    '-Wl,-U,_tellus_audio_session_set_denoise_attenuation_limit_db',
    '-Wl,-U,_tellus_audio_session_set_close_talk_hold_ms',
    '-Wl,-U,_tellus_audio_session_set_close_talk_keep_gap_db',
    '-Wl,-U,_tellus_audio_session_set_close_talk_level_margin_db',
    '-Wl,-U,_tellus_audio_session_set_close_talk_level_min_dbfs',
    '-Wl,-U,_tellus_audio_session_set_close_talk_learned_level_dbfs',
    '-Wl,-U,_tellus_audio_session_clear_close_talk_learned_level',
    '-Wl,-U,_tellus_audio_session_set_general_denoise_attenuation_limit_db',
    '-Wl,-U,_tellus_audio_session_clear_general_denoise_attenuation_limit',
    '-Wl,-U,_tellus_audio_session_hold_input',
    '-Wl,-U,_tellus_audio_session_release_input',
    '-Wl,-U,_tellus_audio_session_copy_last_error',
  ]);
  assert.match(podspec, /source_files = \[[^\]]*'cpp\/\*\*\/\*\.\{hpp,cpp\}'/);
});

test('mobile android build compiles the weak-reference translation units', () => {
  const sources = read('android/CMakeLists.txt');
  for (const unit of ['DenoiseSettings.cpp', 'InputHold.cpp', 'LastError.cpp']) assert.match(sources, new RegExp(`^\\s*\\.\\./cpp/${unit.replace('.', '\\.')}$`, 'm'));
});

// Engine v0.4.12+ mobile archives ship ONNX Runtime. A second copy from onnxruntime-c, onnxruntime-android or onnxruntime-react-native
// collides in the app (same-name iOS framework, same-path Android .so), so the SDK links only the archive copy (engine ADR-010).
const ortFiles = {
  ios: ['onnxruntime.xcframework/Info.plist', 'onnxruntime.xcframework/ios-arm64/onnxruntime.framework/onnxruntime',
    'onnxruntime.xcframework/ios-arm64_x86_64-simulator/onnxruntime.framework/onnxruntime',
    'licenses/onnxruntime.txt', 'licenses/onnxruntime-third-party.txt'],
  android: ['jniLibs/arm64-v8a/libonnxruntime.so', 'jniLibs/x86_64/libonnxruntime.so',
    'licenses/onnxruntime.txt', 'licenses/onnxruntime-third-party.txt'],
};
const podspecList = (podspec, attribute) => podspec.match(new RegExp(`^\\s*s\\.${attribute} = (.*)$`, 'm'))?.[1].match(/'[^']*'/g)?.map(value => value.slice(1, -1));

test('mobile podspec vendors the archive ONNX Runtime with its system links instead of the onnxruntime-c pod', () => {
  const podspec = read('TellusAudioSdk.podspec');
  assert.doesNotMatch(podspec, /dependency\s+['"]onnxruntime/);
  assert.deepEqual(podspecList(podspec, 'vendored_frameworks'), ['vendor/ios/TellusAudioEngine.xcframework', 'vendor/ios/onnxruntime.xcframework']);
  for (const framework of ['Foundation', 'CoreFoundation']) assert.ok(podspecList(podspec, 'frameworks').includes(framework), framework);
  assert.deepEqual(podspecList(podspec, 'weak_frameworks'), ['CoreML']);
  assert.deepEqual(podspecList(podspec, 'libraries'), ['c++']);
});

test('mobile android build ships the archive libonnxruntime.so without the onnxruntime-android AAR', () => {
  const gradle = read('android/build.gradle');
  assert.doesNotMatch(gradle, /com\.microsoft\.onnxruntime|onnxruntimeVersion/);
  assert.match(gradle, /sourceSets\.main\.jniLibs\.srcDir\(new File\(engineDir, "jniLibs"\)\)/);
  assert.doesNotMatch(read('android/gradle.properties'), /onnxruntime/i);
});

for (const target of ['ios', 'android']) {
  test(`${target} archive requires the bundled ONNX Runtime and its notices`, () => {
    const required = require('../release-assets.json').assets[target].requiredFiles;
    for (const file of ortFiles[target]) assert.ok(required.includes(file), `missing archive requirement: ${file}`);
  });
}

test('mobile app resources carry the ONNX Runtime notices next to the Silero notice', () => {
  const bundle = read('TellusAudioSdk.podspec').match(/resource_bundles = \{ 'TellusAudioSdkModels' => \[([^\]]*)\]/)?.[1];
  for (const notice of ['silero-vad.txt', 'onnxruntime.txt', 'onnxruntime-third-party.txt']) assert.ok(bundle.includes(`'vendor/ios/licenses/${notice}'`), notice);
  const licenses = read('android/model-assets.gradle').match(/from\(new File\(engineDir, "licenses"\)\) \{ include ([^}]*)\}/)?.[1];
  assert.deepEqual(licenses.match(/"[^"]*"/g).map(value => value.slice(1, -1)), ['silero-vad.txt', 'onnxruntime.txt', 'onnxruntime-third-party.txt']);
});
