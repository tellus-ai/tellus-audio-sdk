#include "DenoiseSettings.hpp"

// Weak references, decided at call time instead of link time: an old kit leaves a symbol undefined, so its address is null.
extern "C" int32_t tellus_audio_session_set_close_talk_threshold_db(TellusAudioSession* session, float db) __attribute__((weak));
extern "C" int32_t tellus_audio_session_set_denoise_attenuation_limit_db(TellusAudioSession* session, float db) __attribute__((weak));

namespace margelo::nitro::tellus {

DenoiseSettingFn resolveSetCloseTalkThresholdDb() {
  return &tellus_audio_session_set_close_talk_threshold_db;
}

DenoiseSettingFn resolveSetDenoiseAttenuationLimitDb() {
  return &tellus_audio_session_set_denoise_attenuation_limit_db;
}

} // namespace margelo::nitro::tellus
