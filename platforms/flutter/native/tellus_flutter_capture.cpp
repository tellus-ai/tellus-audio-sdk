#include "tellus_flutter_capture.h"

#include "CaptureSession.hpp"

#include <cmath>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

// The Flutter counterpart of platforms/mobile/cpp/HybridTellusCapture.cpp: each method makes the
// same CaptureSession and engine calls, and the result goes to Dart as a reply instead of a promise.

using margelo::nitro::ArrayBuffer;
using namespace margelo::nitro::tellus;

namespace {

// A malloc copy that Dart releases with tellus_flutter_free.
char* copy(const std::string& text) {
  auto* bytes = static_cast<char*>(std::malloc(text.size() + 1));
  if (bytes) std::memcpy(bytes, text.c_str(), text.size() + 1);
  return bytes;
}

const uint8_t* utf8(const std::string& text) { return reinterpret_cast<const uint8_t*>(text.data()); }

std::string authorizationStatus(CaptureSession* session) {
  return session->json([&](auto* bytes, auto capacity, auto* written) {
    return tellus_audio_session_get_authorization_status(session->handle, bytes, capacity, written);
  });
}

// Answers one call: with the error when there is one, otherwise with the result (empty for none).
using Answer = std::function<void(std::exception_ptr, const std::string&)>;

// Runs the operation on the session's worker and answers when it has finished.
template <typename F>
void run(CaptureSession* session, Answer answer, F operation, bool allowClosed = false, bool allowFailed = false) {
  using Result = std::invoke_result_t<F>;
  session->submit(std::move(operation), allowClosed, allowFailed)
      ->then([answer = std::move(answer)](std::shared_future<Result> settled) {
        std::string result;
        std::exception_ptr error;
        try {
          if constexpr (std::is_void_v<Result>) settled.get();
          else result = settled.get();
        } catch (...) { error = std::current_exception(); }
        answer(error, result);
      });
}

} // namespace

struct TellusFlutterCapture {
  TellusFlutterCapture(int64_t id, TellusFlutterReply reply, TellusFlutterChunk chunk, TellusFlutterError error)
      : id(id), reply(reply), chunk(chunk), error(error) {}

  void answer(int64_t request, bool closing, std::exception_ptr failure, const std::string& result);
  void sendChunk(ArrayBuffer& payload, const std::string& metadata, uint64_t epoch, uint64_t generation);
  void sendError(const std::string& code, const std::string& message);

  const int64_t id;
  const TellusFlutterReply reply;
  const TellusFlutterChunk chunk;
  const TellusFlutterError error;
  // Held around every callback to Dart, so that the reply to close is the last one.
  std::mutex mutex;
  // False from the call of close on. No chunk or error callback follows.
  bool open = true;
  // Calls, other than that close, which are not answered yet.
  size_t pending = 0;
  std::condition_variable answered;
  // The reply to close, kept until `pending` is 0.
  std::function<void()> closeReply;
  // Last member, so destroyed first: its destructor joins the worker, whose commands use the members above.
  CaptureSession session;
};

void TellusFlutterCapture::answer(int64_t request, bool closing, std::exception_ptr failure, const std::string& result) {
  char* code = nullptr;
  char* message = nullptr;
  if (failure) {
    try { std::rethrow_exception(failure); }
    catch (const EngineError& engine) {
      code = copy(engine.what());
      if (!engine.message.empty()) message = copy(engine.message);
    }
    catch (const std::exception& other) { code = copy(other.what()); }
    catch (...) { code = copy("internal_error"); }
  }
  char* value = failure || result.empty() ? nullptr : copy(result);
  auto send = [this, request, code, message, value] { reply(request, code, message, value); };
  std::lock_guard lock(mutex);
  if (closing) closeReply = send;
  else { send(); --pending; }
  if (pending > 0) return;
  if (closeReply) std::exchange(closeReply, nullptr)();
  answered.notify_all();
}

void TellusFlutterCapture::sendChunk(ArrayBuffer& payload, const std::string& metadata, uint64_t epoch, uint64_t generation) {
  std::lock_guard lock(mutex);
  // Dart acknowledges every chunk it receives. One that is not sent is acknowledged here.
  if (!open) { session.acknowledgeChunk(); return; }
  chunk(id, payload.release(), payload.size(), copy(metadata), epoch, generation);
}

void TellusFlutterCapture::sendError(const std::string& code, const std::string& message) {
  std::lock_guard lock(mutex);
  if (open) error(id, copy(code), message.empty() ? nullptr : copy(message));
}

namespace {

void startInput(CaptureSession* session, Answer answer, bool resume, std::function<void()> setup) {
  const auto revision = session->controlRevision();
  session->submit([session, revision, resume, setup = std::move(setup)] {
    if (setup) setup();
    auto handoff = session->beginStart(resume, revision);
    if (handoff.closing.empty()) session->openInput(revision);
    return handoff;
  }, false, !resume)->then([session, revision, answer = std::move(answer)](std::shared_future<MicrophoneHandoff> prepared) {
    MicrophoneHandoff handoff;
    try { handoff = prepared.get(); } catch (...) { answer(std::current_exception(), {}); return; }
    if (handoff.closing.empty()) { answer({}, {}); return; }
    // Another user of the microphone has to close its input first. That wait must not block the
    // worker, so a thread waits and then opens the input. destroy waits for the answer it gives.
    std::thread([session, revision, answer, handoff] {
      std::exception_ptr error;
      try { handoff.wait(); } catch (...) { error = std::current_exception(); }
      try {
        // openInput releases the input and rethrows when the hand-off failed.
        session->submit([session, revision, error] { session->openInput(revision, error); }, true)->await().get();
      } catch (...) { error = std::current_exception(); }
      answer(error, {});
    }).detach();
  });
}

} // namespace

TellusFlutterCapture* tellus_flutter_capture_create(int64_t capture_id, TellusFlutterReply reply,
                                                    TellusFlutterChunk chunk, TellusFlutterError error) {
  try { return new TellusFlutterCapture(capture_id, reply, chunk, error); } catch (...) { return nullptr; }
}

void tellus_flutter_capture_call(TellusFlutterCapture* capture, int64_t request_id, const char* method_name,
                                 const char* argument_text, double number, const uint8_t* bytes, uint64_t bytes_length) {
  const std::string method = method_name ? method_name : "";
  const std::string argument = argument_text ? argument_text : "";
  auto* session = &capture->session;
  bool closing = false;
  {
    std::lock_guard lock(capture->mutex);
    if (method == "close" && capture->open) {
      capture->open = false;
      closing = true;
    } else ++capture->pending;
  }
  const Answer answer = [capture, request_id, closing](std::exception_ptr failure, const std::string& result) {
    capture->answer(request_id, closing, failure, result);
  };
  try {
    if (method == "configure") {
      // Core configuration decides the output rate rules; this only guards the value range before the uint32 conversion.
      if (!std::isfinite(number) || number < 8000 || number > 192000 || std::fmod(number, 50) != 0) {
        throw std::runtime_error("invalid_processing_rate");
      }
      run(session, answer, [session, argument, number] {
        session->check(tellus_audio_session_configure(session->handle, utf8(argument), argument.size()));
        session->processingRate = static_cast<uint32_t>(number);
      });
    } else if (method == "createAuthorizationRequest") {
      run(session, answer, [session, argument] {
        return session->json([&](auto* json, auto capacity, auto* written) {
          return tellus_audio_session_create_authorization_request(session->handle, utf8(argument), argument.size(),
                                                                   json, capacity, written);
        });
      });
    } else if (method == "applyAuthorization") {
      run(session, answer, [session, argument] {
        session->check(tellus_audio_session_apply_authorization(session->handle, utf8(argument), argument.size()));
        return authorizationStatus(session);
      });
    } else if (method == "getAuthorizationStatus") {
      run(session, answer, [session] { return authorizationStatus(session); });
    } else if (method == "createModelKeyRequest") {
      run(session, answer, [session] {
        return session->json([&](auto* json, auto capacity, auto* written) {
          return tellus_audio_session_model_key_request(session->handle, json, capacity, written);
        });
      });
    } else if (method == "inspectModelFile") {
      run(session, answer, [session, argument] {
        const auto model = readEncryptedModel(argument);
        return session->json([&](auto* json, auto capacity, auto* written) {
          return tellus_audio_model_container_inspect(model.data(), model.size(), json, capacity, written);
        });
      });
    } else if (method == "applyModelKey") {
      const auto separator = argument.find('\n');
      if (separator == std::string::npos) throw std::invalid_argument("invalid_argument");
      if (!bytes || bytes_length != 80) throw std::runtime_error("model_key_invalid");
      run(session, answer, [session, model = argument.substr(0, separator), key = argument.substr(separator + 1),
                            wrapped = std::vector<uint8_t>(bytes, bytes + bytes_length)] {
        session->check(tellus_audio_session_apply_model_key(session->handle, utf8(model), model.size(),
                                                            utf8(key), key.size(), wrapped.data(), wrapped.size()));
      });
    } else if (method == "loadModelFile") {
      run(session, answer, [session, argument] {
        const auto model = readEncryptedModel(argument);
        session->check(tellus_audio_session_load_model(session->handle, model.data(), model.size()));
      });
    } else if (method == "start") {
      startInput(session, answer, false, [capture, session] {
        session->onChunk = [capture](std::shared_ptr<ArrayBuffer> payload, const std::string& metadata,
                                     uint64_t epoch, uint64_t generation) {
          capture->sendChunk(*payload, metadata, epoch, generation);
        };
        session->onError = [capture](const std::string& code, const std::string& message) {
          capture->sendError(code, message);
        };
      });
    } else if (method == "pause") {
      session->suspendDelivery();
      session->cancelPlayback();
      run(session, answer, [session] { session->pause(); });
    } else if (method == "resume") {
      startInput(session, answer, true, {});
    } else if (method == "stop") {
      session->stopAccepting();
      session->cancelPlayback();
      // stop still cleans up the engine and clears the latch after an internal error.
      run(session, answer, [session] { session->stop(); }, false, true);
    } else if (method == "close") {
      session->closed = true;
      session->suspendDelivery();
      session->cancelPlayback();
      run(session, answer, [session] { session->close(); }, true);
    } else if (method == "getStatus") {
      // Status stays readable after an internal-error latch so the failure cause can be read.
      run(session, answer, [session] { return session->status(); }, false, true);
    } else if (method == "setDenoiseEnabled") {
      run(session, answer, [session, enabled = number != 0] {
        session->check(tellus_audio_session_set_denoise_enabled(session->handle, enabled));
      });
    } else {
      throw std::invalid_argument("invalid_argument");
    }
  } catch (...) { answer(std::current_exception(), {}); }
}

uint8_t tellus_flutter_capture_can_deliver(TellusFlutterCapture* capture, uint64_t epoch, uint64_t generation) {
  return capture->session.canDeliver(epoch, generation) ? 1 : 0;
}

void tellus_flutter_capture_acknowledge_chunk(TellusFlutterCapture* capture) { capture->session.acknowledgeChunk(); }

void tellus_flutter_capture_invalidate_authorization(TellusFlutterCapture* capture) {
  // There is no reply to carry a failure. getStatus shows it as last_error_message.
  try { capture->session.invalidate(); } catch (...) {}
}

void tellus_flutter_capture_destroy(TellusFlutterCapture* capture) {
  // Not on the calling thread: destroying the session joins its worker and, on iOS, runs code on
  // the main thread, which can be the calling thread and which the worker may be waiting for.
  std::thread([capture] {
    {
      std::unique_lock lock(capture->mutex);
      capture->answered.wait(lock, [capture] { return capture->pending == 0; });
    }
    delete capture;
  }).detach();
}

void tellus_flutter_free(void* pointer) { std::free(pointer); }
