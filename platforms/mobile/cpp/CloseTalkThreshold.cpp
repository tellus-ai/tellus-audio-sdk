#include "CloseTalkThreshold.hpp"

// Weak reference, decided at call time instead of link time: an old kit leaves the symbol undefined, so its address is null.
extern "C" int32_t tellus_audio_session_set_close_talk_threshold_db(TellusAudioSession* session, float db) __attribute__((weak));

namespace margelo::nitro::tellus {

SetCloseTalkThresholdFn resolveSetCloseTalkThresholdDb() {
  return &tellus_audio_session_set_close_talk_threshold_db;
}

} // namespace margelo::nitro::tellus
