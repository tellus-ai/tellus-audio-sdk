#pragma once

#include <cstdint>

// Only a forward declaration: the weak references in InputHold.cpp must compile without the kit header,
// whose older versions lack the two functions and whose newer versions declare them strongly.
struct TellusAudioSession;

namespace margelo::nitro::tellus {

using InputHoldFn = int32_t (*)(TellusAudioSession*);

// Returns tellus_audio_session_hold_input, or nullptr when the linked engine kit predates it.
InputHoldFn resolveHoldInput();
// Returns tellus_audio_session_release_input, or nullptr when the linked engine kit predates it.
InputHoldFn resolveReleaseInput();

} // namespace margelo::nitro::tellus
