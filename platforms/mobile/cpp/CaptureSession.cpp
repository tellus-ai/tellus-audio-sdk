#include "CaptureSession.hpp"

#include <array>
#include <cmath>

namespace margelo::nitro::tellus {

void CaptureSession::check(TellusStatus status) {
  if (status == TELLUS_INTERNAL_ERROR) _failed = true;
  if (status != TELLUS_OK) throw std::runtime_error(tellus_audio_status_name(status));
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

void CaptureSession::start(bool resume) {
  const auto revision = _controlRevision.load();
  const auto status = resume ? tellus_audio_session_resume(handle) : tellus_audio_session_start(handle);
  if (status != TELLUS_OK && status != TELLUS_INVALID_STATE) {
    _authorizationMonitored = false;
    _device->stopCapture();
  }
  check(status);
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
        try { check(status); } catch (const std::exception& error) { fail(error.what()); }
      }
    }
  });
}

void CaptureSession::reset(uint64_t revision, bool capturing) {
  const auto lost = _worker->discard(processingRate);
  if (lost > 0) check(tellus_audio_session_mark_discontinuity(handle, lost));
  check(tellus_audio_session_reset(handle));
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
  } catch (const std::exception& error) { fail(error.what()); }
}

void CaptureSession::fail(const std::string& error) {
  _authorizationMonitored = false;
  _captureEnabled = false;
  _deliveryEnabled = false;
  try { _device->stopCapture(); cancelPlayback(); } catch (...) {}
  _worker->discard(processingRate);
  if (!_failed) tellus_audio_session_pause(handle);
  _started = false;
  if (onError) { try { onError(error); } catch (...) {} }
}

void CaptureSession::verifyAuthorization() {
  if (!_authorizationMonitored || closed || _failed) return;
  try {
    const auto status = json([&](auto* bytes, auto capacity, auto* written) {
      return tellus_audio_session_get_authorization_status(handle, bytes, capacity, written);
    });
    if (status.find("\"state\":\"authorized\"") == std::string::npos) fail("engine_authorization_expired");
  } catch (const std::exception& error) { fail(error.what()); }
}

} // namespace margelo::nitro::tellus
