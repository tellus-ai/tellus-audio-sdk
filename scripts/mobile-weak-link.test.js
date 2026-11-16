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
