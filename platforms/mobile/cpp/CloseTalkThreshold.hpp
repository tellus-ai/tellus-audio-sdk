#pragma once

#include <cstdint>

// Only a forward declaration: the weak reference in CloseTalkThreshold.cpp must compile without the kit header,
// whose older versions lack the function and whose newer versions declare it strongly.
struct TellusAudioSession;

namespace margelo::nitro::tellus {

using SetCloseTalkThresholdFn = int32_t (*)(TellusAudioSession*, float);

// Returns tellus_audio_session_set_close_talk_threshold_db, or nullptr when the linked engine kit predates it.
SetCloseTalkThresholdFn resolveSetCloseTalkThresholdDb();

} // namespace margelo::nitro::tellus
