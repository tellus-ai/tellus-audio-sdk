#include "DenoiseSettings.hpp"

// Weak references, decided at call time instead of link time: an old kit leaves a symbol undefined, so its address is null.
extern "C" int32_t tellus_audio_session_set_close_talk_threshold_db(TellusAudioSession* session, float db) __attribute__((weak));
extern "C" int32_t tellus_audio_session_set_denoise_attenuation_limit_db(TellusAudioSession* session, float db) __attribute__((weak));
extern "C" int32_t tellus_audio_session_set_close_talk_hold_ms(TellusAudioSession* session, float ms) __attribute__((weak));
extern "C" int32_t tellus_audio_session_set_close_talk_keep_gap_db(TellusAudioSession* session, float db) __attribute__((weak));
extern "C" int32_t tellus_audio_session_set_close_talk_level_margin_db(TellusAudioSession* session, float db) __attribute__((weak));
extern "C" int32_t tellus_audio_session_set_close_talk_level_min_dbfs(TellusAudioSession* session, float dbfs) __attribute__((weak));
extern "C" int32_t tellus_audio_session_set_close_talk_learned_level_dbfs(TellusAudioSession* session, float dbfs) __attribute__((weak));
extern "C" int32_t tellus_audio_session_clear_close_talk_learned_level(TellusAudioSession* session) __attribute__((weak));
extern "C" int32_t tellus_audio_session_set_general_denoise_attenuation_limit_db(TellusAudioSession* session, float db) __attribute__((weak));
extern "C" int32_t tellus_audio_session_clear_general_denoise_attenuation_limit(TellusAudioSession* session) __attribute__((weak));

namespace margelo::nitro::tellus {

DenoiseSettingFn resolveSetCloseTalkThresholdDb() {
  return &tellus_audio_session_set_close_talk_threshold_db;
}

DenoiseSettingFn resolveSetDenoiseAttenuationLimitDb() {
  return &tellus_audio_session_set_denoise_attenuation_limit_db;
}

DenoiseSettingFn resolveSetCloseTalkHoldMs() {
  return &tellus_audio_session_set_close_talk_hold_ms;
}

DenoiseSettingFn resolveSetCloseTalkKeepGapDb() {
  return &tellus_audio_session_set_close_talk_keep_gap_db;
}

DenoiseSettingFn resolveSetCloseTalkLevelMarginDb() {
  return &tellus_audio_session_set_close_talk_level_margin_db;
}

DenoiseSettingFn resolveSetCloseTalkLevelMinDbfs() {
  return &tellus_audio_session_set_close_talk_level_min_dbfs;
}

DenoiseSettingFn resolveSetCloseTalkLearnedLevelDbfs() {
  return &tellus_audio_session_set_close_talk_learned_level_dbfs;
}

DenoiseClearFn resolveClearCloseTalkLearnedLevel() {
  return &tellus_audio_session_clear_close_talk_learned_level;
}
DenoiseSettingFn resolveSetGeneralDenoiseAttenuationLimitDb() {
  return &tellus_audio_session_set_general_denoise_attenuation_limit_db;
}

DenoiseClearFn resolveClearGeneralDenoiseAttenuationLimit() {
  return &tellus_audio_session_clear_general_denoise_attenuation_limit;
}

} // namespace margelo::nitro::tellus
