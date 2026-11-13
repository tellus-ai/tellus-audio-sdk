#include "InputHold.hpp"

// Weak references, decided at call time instead of link time: an old kit leaves a symbol undefined, so its address is null.
extern "C" int32_t tellus_audio_session_hold_input(TellusAudioSession* session) __attribute__((weak));
extern "C" int32_t tellus_audio_session_release_input(TellusAudioSession* session) __attribute__((weak));

namespace margelo::nitro::tellus {

InputHoldFn resolveHoldInput() {
  return &tellus_audio_session_hold_input;
}

InputHoldFn resolveReleaseInput() {
  return &tellus_audio_session_release_input;
}

} // namespace margelo::nitro::tellus
