#pragma once

#include <cstdint>

// Only a forward declaration: the weak references in DenoiseSettings.cpp must compile without the kit header,
// whose older versions lack the functions and whose newer versions declare them strongly.
struct TellusAudioSession;

namespace margelo::nitro::tellus {

using DenoiseSettingFn = int32_t (*)(TellusAudioSession*, float);
// Takes only the session, like clear_close_talk_learned_level.
using DenoiseClearFn = int32_t (*)(TellusAudioSession*);

// Returns tellus_audio_session_set_close_talk_threshold_db, or nullptr when the linked engine kit predates it.
DenoiseSettingFn resolveSetCloseTalkThresholdDb();
// Returns tellus_audio_session_set_denoise_attenuation_limit_db, or nullptr when the linked engine kit predates it.
DenoiseSettingFn resolveSetDenoiseAttenuationLimitDb();
// The four close_talk tuning functions and the learned level clear. nullptr when the linked engine kit predates them.
DenoiseSettingFn resolveSetCloseTalkHoldMs();
DenoiseSettingFn resolveSetCloseTalkKeepGapDb();
DenoiseSettingFn resolveSetCloseTalkLevelMarginDb();
DenoiseSettingFn resolveSetCloseTalkLevelMinDbfs();
DenoiseSettingFn resolveSetCloseTalkLearnedLevelDbfs();
DenoiseClearFn resolveClearCloseTalkLearnedLevel();
// General-mode attenuation limit set and clear. nullptr when the linked engine kit predates them.
DenoiseSettingFn resolveSetGeneralDenoiseAttenuationLimitDb();
DenoiseClearFn resolveClearGeneralDenoiseAttenuationLimit();

} // namespace margelo::nitro::tellus
