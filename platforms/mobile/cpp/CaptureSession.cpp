#include "CaptureSession.hpp"

#include <array>
#include <cmath>
#include <cstdio>

namespace margelo::nitro::tellus {

CopyLastErrorFn (*CaptureSession::_copyLastErrorResolver)() = resolveCopyLastError;

namespace {
// Turns text into a JSON string literal. Engine explanations are UTF-8, so only quotes, backslashes and control characters are escaped.
std::string jsonString(const std::string& text) {
  std::string quoted = "\"";
  for (const unsigned char c : text) {
    if (c == '"' || c == '\\') { quoted += '\\'; quoted += static_cast<char>(c); }
    else if (c < 0x20) {
      std::array<char, 7> escaped{};
      std::snprintf(escaped.data(), escaped.size(), "\\u%04x", c);
      quoted += escaped.data();
    } else quoted += static_cast<char>(c);
  }
  return quoted + "\"";
}

// The engine explanation when the error came from an engine status, otherwise an empty string.
std::string engineMessage(const std::exception& error) {
  const auto* engine = dynamic_cast<const EngineError*>(&error);
  return engine ? engine->message : std::string();
}
} // namespace

void CaptureSession::check(TellusStatus status) {
  if (status == TELLUS_OK) return;
  if (status == TELLUS_INTERNAL_ERROR) _failed = true;
  std::string message;
  if (const auto copy = _copyLastErrorResolver()) {
    std::array<char, 1024> buffer{};
    if (copy(handle, buffer.data(), buffer.size()) > 0) message = buffer.data();
  }
  { std::lock_guard lock(_lastErrorMutex); _lastErrorMessage = message; }
  throw EngineError(tellus_audio_status_name(status), std::move(message));
}

std::string CaptureSession::lastErrorMessage() {
  std::lock_guard lock(_lastErrorMutex);
  return _lastErrorMessage;
}

std::string CaptureSession::status() {
  auto status = json([&](auto* bytes, auto capacity, auto* written) {
    return tellus_audio_session_get_status(handle, bytes, capacity, written);
  });
  const auto message = lastErrorMessage();
  const auto end = status.rfind('}');
  if (end == std::string::npos) return status;
  return status.substr(0, end) + ",\"last_error_message\":" + (message.empty() ? "null" : jsonString(message)) + "}";
}

void CaptureSession::setCopyLastErrorResolverForTesting(CopyLastErrorFn (*resolver)()) {
  _copyLastErrorResolver = resolver;
}

std::string CaptureSession::json(std::function<TellusStatus(uint8_t*, size_t, size_t*)> call) {
  std::array<uint8_t, 4096> bytes{};
  size_t length = 0;
  check(call(bytes.data(), bytes.size(), &length));
  return std::string(reinterpret_cast<const char*>(bytes.data()), length);
}

CaptureSession::CaptureSession() {
  check(tellus_audio_session_create(&handle));
  try {
    _worker = std::make_unique<CaptureWorker>([this](const auto& frame) { process(frame); }, [this] { verifyAuthorization(); });
    _device = createAudioDevice(
        [this](const float* samples, size_t count, uint32_t rate, int64_t timestamp) {
          if (_captureEnabled) _worker->capture(samples, count, rate, timestamp);
        },
        [this](const float* samples, size_t count, uint32_t rate) {
          const auto ticket = _playingEpoch.load();
          auto copy = std::vector<float>(samples, samples + count);
          auto done = std::make_shared<std::promise<void>>();
          auto result = done->get_future();
          if (!_worker->enqueue([this, copy = std::move(copy), rate, done, ticket] {
            try {
              if (closed || !_playing || ticket != _playbackEpoch) throw std::runtime_error("playback_cancelled");
              check(tellus_audio_session_push_render(handle, copy.data(), copy.size(), rate));
              done->set_value();
            } catch (...) { done->set_exception(std::current_exception()); }
          })) throw std::runtime_error("capture_control_queue_full");
          result.get();
        },
        [this](const std::string& error) {
          _captureEnabled = false;
          _deliveryEnabled = false;
          _worker->enqueueUrgent([this, error] { fail(error); });
        });
  } catch (...) {
    _worker.reset();
    tellus_audio_session_destroy(handle);
    throw;
  }
}

CaptureSession::~CaptureSession() {
  closed = true;
  _captureEnabled = false;
  _deliveryEnabled = false;
  try { _device->stopCapture(); _device->cancelPlayback(); } catch (...) {}
  _worker->shutdown();
  _worker.reset();
  tellus_audio_session_destroy(handle);
}

void CaptureSession::configureAudioDevices(const std::string& mic, const std::string& playback,
                                         const std::string& route) {
  if (_deviceSelectionLocked) throw std::runtime_error("audio_device_selection_locked");
  _device->configureDevices(mic, playback, route);
  _deviceSelectionLocked = true;
}

void CaptureSession::start(bool resume) {
  const auto revision = _controlRevision.load();
  const auto status = resume ? tellus_audio_session_resume(handle) : tellus_audio_session_start(handle);
  if (status != TELLUS_OK && status != TELLUS_INVALID_STATE) {
    _authorizationMonitored = false;
    _device->stopCapture();
  }
  check(status);
  // The engine accepted start, so clear any earlier internal-error latch.
  _failed = false;
  _deviceSelectionLocked = true;
  _started = true;
  try {
    _device->requestCapturePermission();
    check(tellus_audio_session_clear_render(handle));
    if (revision != _controlRevision || closed) throw std::runtime_error("capture_cancelled");
    _device->startCapture(48000);
    check(tellus_audio_session_clear_render(handle));
    if (revision != _controlRevision || closed) throw std::runtime_error("capture_cancelled");
    _deliveryEnabled = true;
    _captureEnabled = true;
    _authorizationMonitored = true;
  }
  catch (...) {
    _captureEnabled = false;
    _deliveryEnabled = false;
    _authorizationMonitored = false;
    _device->stopCapture();
    if (!_failed) tellus_audio_session_pause(handle);
    _started = false;
    throw;
  }
}

void CaptureSession::clearQueuedCapture() {
  const auto lost = _worker->discard(processingRate);
  if (lost > 0) check(tellus_audio_session_mark_discontinuity(handle, lost));
}

void CaptureSession::pause() {
  _captureEnabled = false;
  _deliveryEnabled = false;
  _device->pauseCapture();
  cancelPlayback();
  try { clearQueuedCapture(); }
  catch (...) { if (!_failed) tellus_audio_session_pause(handle); _started = false; throw; }
  _started = false;
  check(tellus_audio_session_pause(handle));
}

void CaptureSession::setRecordingNotification(const std::string& title, const std::string& contentText,
                                              bool pauseAction, bool resumeAction,
                                              std::function<void(const std::string&)> onAction) {
  _device->setRecordingNotification(title, contentText, pauseAction, resumeAction,
    [this, onAction = std::move(onAction)](const std::string& action) {
      if (closed || _failed) return;
      _worker->enqueue([this, onAction, action] {
        if (!closed && !_failed) { try { onAction(action); } catch (...) {} }
      });
    });
}

void CaptureSession::stop() {
  _authorizationMonitored = false;
  _captureEnabled = false;
  _device->stopCapture();
  cancelPlayback();
  _worker->drain();
  clearQueuedCapture();
  _started = false;
  check(tellus_audio_session_stop(handle, chunk, this));
  // The engine cleaned up the pipeline on stop, so clear the internal-error latch. canDeliver already dropped tail chunks while latched.
  _failed = false;
  if (_outputOverflow.exchange(false)) fail("capture_output_queue_full");
}

void CaptureSession::close() {
  _authorizationMonitored = false;
  _captureEnabled = false;
  _deliveryEnabled = false;
  _device->stopCapture();
  cancelPlayback();
  _worker->discard(processingRate);
  if (!_failed) check(tellus_audio_session_invalidate_authorization(handle));
}

void CaptureSession::invalidate() {
  suspendDelivery();
  if (!_failed) check(tellus_audio_session_invalidate_authorization(handle));
  cancelPlayback();
  _worker->enqueueUrgent([this] {
    _authorizationMonitored = false;
    try { _device->stopCapture(); cancelPlayback(); } catch (...) {}
    _worker->discard(processingRate);
    if (_started && !_failed) {
      _started = false;
      const auto status = tellus_audio_session_pause(handle);
      if (status != TELLUS_OK && status != TELLUS_AUTHORIZATION_REQUIRED) {
        try { check(status); } catch (const std::exception& error) { fail(error.what(), engineMessage(error)); }
      }
    }
  });
}

void CaptureSession::reset(uint64_t revision, bool capturing) {
  const auto lost = _worker->discard(processingRate);
  if (lost > 0) check(tellus_audio_session_mark_discontinuity(handle, lost));
  check(tellus_audio_session_reset(handle));
  // The engine discarded its history and is ready again, so clear the internal-error latch. OS capture stopped by the failure is not reopened.
  _failed = false;
  if (capturing && revision == _controlRevision && !closed) { _captureEnabled = true; _deliveryEnabled = true; }
}

void CaptureSession::holdInput(InputHoldFn hold) {
  check(hold(handle));
  _inputHeld = true;
}

// While held, mimic the reset path: block capture and delivery, drop the held-time captures still queued on the worker and report their
// length via mark_discontinuity (during hold only the input clock advances, so release's input_held discontinuity covers it too), call C release, then reopen.
// When not held, only the C release (a no-op) is called; mark_discontinuity is a full discard there and leaves the queue and delivery alone.
// Whether the core is held is only known on the worker, so delivery is stopped here as well. The revision is not bumped: bumping it would
// invalidate the revision of a reset requested after this release and still queued, which could then never reopen capture. If the JS thread's
// pause, stop or invalidate bumped the revision while this ran, capture is not reopened, as in reset.
void CaptureSession::releaseInput(InputHoldFn release) {
  if (!_inputHeld) {
    check(release(handle));
    return;
  }
  const auto revision = _controlRevision.load();
  const auto capturing = isCapturing();
  _captureEnabled = false;
  _deliveryEnabled = false;
  clearQueuedCapture();
  check(release(handle));
  _inputHeld = false;
  if (capturing && revision == _controlRevision && !closed) { _captureEnabled = true; _deliveryEnabled = true; }
}

uint64_t CaptureSession::reservePlayback() {
  std::lock_guard lock(_playbackMutex);
  if (closed) throw std::runtime_error("capture_disposed");
  if (_playing.exchange(true)) throw std::runtime_error("playback_already_running");
  const auto ticket = _playbackEpoch.fetch_add(1) + 1;
  _playingEpoch = ticket;
  _playbackFinished.notify_all();
  return ticket;
}

void CaptureSession::playback(const std::vector<float>& samples, uint32_t rate, uint64_t ticket) {
  auto cancelled = [this, ticket] { return closed || ticket != _playbackEpoch; };
  std::exception_ptr error;
  try {
    if (cancelled()) throw std::runtime_error("playback_cancelled");
    requirePlayback(ticket);
    _device->play(samples.data(), samples.size(), rate, cancelled);
    submit([this, ticket] {
      if (ticket != _playbackEpoch || !_started) throw std::runtime_error("playback_cancelled");
      check(tellus_audio_session_clear_render(handle));
    })->await().get();
  } catch (...) { error = std::current_exception(); }
  finishPlayback();
  if (error) std::rethrow_exception(error);
}

void CaptureSession::requirePlayback(uint64_t ticket) {
  submit([this, ticket] {
    if (closed || ticket != _playbackEpoch) throw std::runtime_error("playback_cancelled");
    if (!_started) throw std::runtime_error("capture_not_running");
    check(tellus_audio_session_clear_render(handle));
  })->await().get();
}

void CaptureSession::playbackEncoded(const std::vector<uint8_t>& encoded, uint64_t ticket) {
  DecodedAudio decoded;
  try {
    requirePlayback(ticket);
    decoded = _device->decodeAudio(encoded, [this, ticket] { return closed || ticket != _playbackEpoch; });
  } catch (...) { finishPlayback(); throw; }
  playback(decoded.samples, decoded.rate, ticket);
}

void CaptureSession::finishPlayback() {
  {
    std::lock_guard<std::mutex> lock(_playbackMutex);
    _playing = false;
  }
  _playbackFinished.notify_all();
}

uint64_t CaptureSession::cancelPlayback() {
  uint64_t epoch;
  { std::lock_guard lock(_playbackMutex); epoch = _playbackEpoch.fetch_add(1) + 1; }
  _device->cancelPlayback();
  return epoch;
}

void CaptureSession::awaitPlayback(uint64_t cancelledEpoch) {
  std::unique_lock<std::mutex> lock(_playbackMutex);
  _playbackFinished.wait(lock, [this, cancelledEpoch] { return !_playing || _playingEpoch > cancelledEpoch; });
}

void CaptureSession::clearCancelledRender(uint64_t cancelledEpoch) {
  if (cancelledEpoch != _playbackEpoch || !_started || _failed) return;
  check(tellus_audio_session_clear_render(handle));
}

bool CaptureSession::canDeliver(uint64_t epoch, uint64_t generation) {
  return !closed && !_failed && _deliveryEnabled && tellus_audio_session_can_deliver(handle, epoch, generation) != 0;
}

void CaptureSession::acknowledgeChunk() {
  _pendingChunks.fetch_sub(1);
}

void CaptureSession::chunk(void* context, const uint8_t* payload, size_t length,
                           const uint8_t* metadata, size_t metadataLength, uint64_t epoch, uint64_t generation) {
  auto& session = *static_cast<CaptureSession*>(context);
  if (!session.canDeliver(epoch, generation) || !session.onChunk) return;
  if (session._pendingChunks.fetch_add(1) >= 128) {
    session._pendingChunks.fetch_sub(1);
    session._outputOverflow = true;
    session._deliveryEnabled = false;
    return;
  }
  try {
    auto bytes = ArrayBuffer::copy(payload, length);
    std::string info(reinterpret_cast<const char*>(metadata), metadataLength);
    if (!session.canDeliver(epoch, generation)) { session.acknowledgeChunk(); return; }
    session.onChunk(bytes, info, epoch, generation);
  } catch (...) {
    session.acknowledgeChunk();
    session._outputOverflow = true;
    session._deliveryEnabled = false;
  }
}

void CaptureSession::process(const CaptureWorker::Frame& frame) {
  if (closed || _failed) return;
  try {
    if (frame.lostBefore > 0) {
      check(tellus_audio_session_mark_discontinuity(handle, _worker->lostSamples(frame.lostBefore, frame.rate, processingRate)));
    }
    check(tellus_audio_session_push_capture(handle, frame.samples.data(), frame.count, frame.rate,
                                            frame.timestamp, chunk, this));
    if (_outputOverflow.exchange(false)) fail("capture_output_queue_full");
  } catch (const std::exception& error) { fail(error.what(), engineMessage(error)); }
}

void CaptureSession::fail(const std::string& error, const std::string& message) {
  _authorizationMonitored = false;
  _captureEnabled = false;
  _deliveryEnabled = false;
  try { _device->stopCapture(); cancelPlayback(); } catch (...) {}
  _worker->discard(processingRate);
  if (!_failed) tellus_audio_session_pause(handle);
  _started = false;
  if (onError) { try { onError(error, message); } catch (...) {} }
}

void CaptureSession::verifyAuthorization() {
  if (!_authorizationMonitored || closed || _failed) return;
  try {
    const auto status = json([&](auto* bytes, auto capacity, auto* written) {
      return tellus_audio_session_get_authorization_status(handle, bytes, capacity, written);
    });
    if (status.find("\"state\":\"authorized\"") == std::string::npos) fail("engine_authorization_expired");
  } catch (const std::exception& error) { fail(error.what(), engineMessage(error)); }
}

} // namespace margelo::nitro::tellus
