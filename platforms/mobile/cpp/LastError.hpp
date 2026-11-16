#pragma once

#include <cstddef>

// Only a forward declaration: the weak reference in LastError.cpp must compile without the kit header,
// whose older versions lack the function and whose newer versions declare it strongly.
struct TellusAudioSession;

namespace margelo::nitro::tellus {

using CopyLastErrorFn = size_t (*)(TellusAudioSession*, char*, size_t);

// Returns tellus_audio_session_copy_last_error, or nullptr when the linked engine kit predates it.
CopyLastErrorFn resolveCopyLastError();

} // namespace margelo::nitro::tellus
