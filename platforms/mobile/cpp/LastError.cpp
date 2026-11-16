#include "LastError.hpp"

// Weak reference, decided at call time instead of link time: an old kit leaves the symbol undefined, so its address is null.
extern "C" size_t tellus_audio_session_copy_last_error(TellusAudioSession* session, char* buffer, size_t bufferLength) __attribute__((weak));

namespace margelo::nitro::tellus {

CopyLastErrorFn resolveCopyLastError() {
  return &tellus_audio_session_copy_last_error;
}

} // namespace margelo::nitro::tellus
