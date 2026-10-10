#include "HybridTellusCapture.hpp"

#include <cmath>
#include <cstring>

namespace margelo::nitro::tellus {

HybridTellusCapture::HybridTellusCapture() : HybridObject(TAG), _session(std::make_shared<CaptureSession>()) {}

std::shared_ptr<CaptureSession> HybridTellusCapture::acquire() {
  std::lock_guard<std::mutex> lock(_mutex);
  if (!_session) throw std::runtime_error("capture_disposed");
  return _session;
}

void HybridTellusCapture::dispose() {
  std::shared_ptr<CaptureSession> session;
  {
    std::lock_guard<std::mutex> lock(_mutex);
    session.swap(_session);
  }
  if (session) {
    session->closed = true;
    try { session->invalidate(); session->cancelPlayback(); } catch (...) {}
  }
}

std::shared_ptr<Promise<void>> HybridTellusCapture::configure(const std::string& config, double rate) {
  if (rate != 16000 && rate != 48000) throw std::runtime_error("invalid_processing_rate");
  auto session = acquire();
  return session->submit([state = session.get(), config, rate] {
    state->check(tellus_audio_session_configure(state->handle,
      reinterpret_cast<const uint8_t*>(config.data()), config.size()));
    state->processingRate = static_cast<uint32_t>(rate);
  });
}

std::shared_ptr<Promise<std::string>> HybridTellusCapture::createAuthorizationRequest(const std::string& conversation) {
  auto session = acquire();
  return session->submit([state = session.get(), conversation] {
    return state->json([&](auto* bytes, auto capacity, auto* written) {
      return tellus_audio_session_create_authorization_request(state->handle,
        reinterpret_cast<const uint8_t*>(conversation.data()), conversation.size(), bytes, capacity, written);
    });
  });
}

std::shared_ptr<Promise<std::string>> HybridTellusCapture::applyAuthorization(const std::string& token) {
  auto session = acquire();
  return session->submit([state = session.get(), token] {
    state->check(tellus_audio_session_apply_authorization(state->handle,
      reinterpret_cast<const uint8_t*>(token.data()), token.size()));
    return state->json([&](auto* bytes, auto capacity, auto* written) {
      return tellus_audio_session_get_authorization_status(state->handle, bytes, capacity, written);
    });
  });
}

std::shared_ptr<Promise<std::string>> HybridTellusCapture::getAuthorizationStatus() {
  auto session = acquire();
  return session->submit([state = session.get()] {
    return state->json([&](auto* bytes, auto capacity, auto* written) {
      return tellus_audio_session_get_authorization_status(state->handle, bytes, capacity, written);
    });
  });
}

void HybridTellusCapture::invalidateAuthorization() { acquire()->invalidate(); }

std::shared_ptr<Promise<std::string>> HybridTellusCapture::createModelKeyRequest() {
  auto session = acquire();
  return session->submit([state = session.get()] {
    return state->json([&](auto* bytes, auto capacity, auto* written) {
      return tellus_audio_session_model_key_request(state->handle, bytes, capacity, written);
    });
  });
}

std::shared_ptr<Promise<std::string>> HybridTellusCapture::inspectModelFile(const std::string& path) {
  auto session = acquire();
  return session->submit([state = session.get(), path] {
    const auto model = readEncryptedModel(path);
    return state->json([&](auto* bytes, auto capacity, auto* written) {
      return tellus_audio_model_container_inspect(model.data(), model.size(), bytes, capacity, written);
    });
  });
}

std::shared_ptr<Promise<void>> HybridTellusCapture::applyModelKey(
    const std::string& model, const std::string& key, const std::shared_ptr<ArrayBuffer>& wrapped) {
  if (wrapped->size() != 80) throw std::runtime_error("model_key_invalid");
  auto bytes = std::vector<uint8_t>(wrapped->data(), wrapped->data() + wrapped->size());
  auto session = acquire();
  return session->submit([state = session.get(), model, key, bytes = std::move(bytes)] {
    state->check(tellus_audio_session_apply_model_key(state->handle,
      reinterpret_cast<const uint8_t*>(model.data()), model.size(),
      reinterpret_cast<const uint8_t*>(key.data()), key.size(), bytes.data(), bytes.size()));
  });
}

std::shared_ptr<Promise<void>> HybridTellusCapture::loadModelFile(const std::string& path) {
  auto session = acquire();
  return session->submit([state = session.get(), path] {
    auto model = readEncryptedModel(path);
    state->check(tellus_audio_session_load_model(state->handle, model.data(), model.size()));
  });
}

std::shared_ptr<Promise<void>> HybridTellusCapture::start(
    const std::function<void(const std::shared_ptr<ArrayBuffer>&, const std::string&, uint64_t, uint64_t)>& chunk,
    const std::function<void(const std::string&)>& error) {
  auto session = acquire();
  return session->submit([state = session.get(), chunk, error] {
    state->onChunk = chunk;
    state->onError = error;
    state->start(false);
  });
}

std::shared_ptr<Promise<void>> HybridTellusCapture::pause() {
  auto session = acquire();
  session->suspendDelivery();
  session->cancelPlayback();
  return session->submit([state = session.get()] { state->pause(); });
}

std::shared_ptr<Promise<void>> HybridTellusCapture::resume() {
  auto session = acquire();
  return session->submit([state = session.get()] { state->start(true); });
}

std::shared_ptr<Promise<void>> HybridTellusCapture::stop() {
  auto session = acquire();
  session->stopAccepting();
  session->cancelPlayback();
  return session->submit([state = session.get()] { state->stop(); });
}

std::shared_ptr<Promise<void>> HybridTellusCapture::close() {
  auto session = acquire();
  session->closed = true;
  session->suspendDelivery();
  session->cancelPlayback();
  return session->submit([state = session.get()] { state->close(); }, true);
}

std::shared_ptr<Promise<std::string>> HybridTellusCapture::getStatus() {
  auto session = acquire();
  return session->submit([state = session.get()] {
    return state->json([&](auto* bytes, auto capacity, auto* written) {
      return tellus_audio_session_get_status(state->handle, bytes, capacity, written);
    });
  });
}

std::shared_ptr<Promise<void>> HybridTellusCapture::reset() {
  auto session = acquire();
  const auto capturing = session->isCapturing();
  const auto revision = session->suspendDelivery();
  return session->submit([state = session.get(), revision, capturing] { state->reset(revision, capturing); });
}

std::shared_ptr<Promise<void>> HybridTellusCapture::setDenoiseEnabled(bool enabled) {
  auto session = acquire();
  return session->submit([state = session.get(), enabled] {
    state->check(tellus_audio_session_set_denoise_enabled(state->handle, enabled));
  });
}

std::shared_ptr<Promise<void>> HybridTellusCapture::setRecordingNotification(
    const std::string& title, const std::string& contentText, bool pauseAction, bool resumeAction,
    const std::function<void(const std::string&)>& onAction) {
  if (title.empty() || title.size() > 1024 || contentText.size() > 4096) throw std::runtime_error("invalid_recording_notification");
  auto session = acquire();
  return session->submit([state = session.get(), title, contentText, pauseAction, resumeAction, onAction] {
    state->setRecordingNotification(title, contentText, pauseAction, resumeAction, onAction);
  });
}

std::shared_ptr<Promise<void>> HybridTellusCapture::playback(const std::shared_ptr<ArrayBuffer>& bytes, double rate) {
  if (!std::isfinite(rate) || rate < 8000 || rate > 192000 || std::fmod(rate, 50) != 0 ||
      bytes->size() % sizeof(float) != 0 || bytes->size() > 16 * 1024 * 1024) {
    throw std::runtime_error("invalid_playback_pcm");
  }
  std::vector<float> samples(bytes->size() / sizeof(float));
  std::memcpy(samples.data(), bytes->data(), bytes->size());
  for (float sample : samples) {
    if (!std::isfinite(sample) || sample < -1 || sample > 1) throw std::runtime_error("invalid_playback_pcm");
  }
  auto session = acquire();
  const auto ticket = session->reservePlayback();
  return Promise<void>::async([session, samples = std::move(samples), rate, ticket] {
    session->playback(samples, static_cast<uint32_t>(rate), ticket);
  });
}

std::shared_ptr<Promise<void>> HybridTellusCapture::cancelPlayback() {
  auto session = acquire();
  const auto epoch = session->cancelPlayback();
  return Promise<void>::async([session, epoch] {
    session->awaitPlayback(epoch);
    session->submit([state = session.get(), epoch] {
      state->clearCancelledRender(epoch);
    })->await().get();
  });
}

std::shared_ptr<Promise<void>> HybridTellusCapture::playbackEncoded(const std::shared_ptr<ArrayBuffer>& encoded) {
  if (encoded->size() == 0 || encoded->size() > 16 * 1024 * 1024) throw std::runtime_error("invalid_encoded_audio");
  auto bytes = std::vector<uint8_t>(encoded->data(), encoded->data() + encoded->size());
  auto session = acquire();
  const auto ticket = session->reservePlayback();
  return Promise<void>::async([session, bytes = std::move(bytes), ticket] { session->playbackEncoded(bytes, ticket); });
}

bool HybridTellusCapture::canDeliver(uint64_t epoch, uint64_t generation) { return acquire()->canDeliver(epoch, generation); }
void HybridTellusCapture::acknowledgeChunk() { acquire()->acknowledgeChunk(); }

} // namespace margelo::nitro::tellus
