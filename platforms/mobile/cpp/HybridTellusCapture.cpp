#include "HybridTellusCapture.hpp"

#include <cmath>
#include <cstring>

namespace margelo::nitro::tellus {

DenoiseSettingFn (*HybridTellusCapture::_closeTalkThresholdResolver)() = resolveSetCloseTalkThresholdDb;
DenoiseSettingFn (*HybridTellusCapture::_denoiseAttenuationLimitResolver)() = resolveSetDenoiseAttenuationLimitDb;
DenoiseSettingFn (*HybridTellusCapture::_closeTalkHoldResolver)() = resolveSetCloseTalkHoldMs;
DenoiseSettingFn (*HybridTellusCapture::_closeTalkKeepGapResolver)() = resolveSetCloseTalkKeepGapDb;
DenoiseSettingFn (*HybridTellusCapture::_closeTalkLevelMarginResolver)() = resolveSetCloseTalkLevelMarginDb;
DenoiseSettingFn (*HybridTellusCapture::_closeTalkLearnedLevelResolver)() = resolveSetCloseTalkLearnedLevelDbfs;
DenoiseClearFn (*HybridTellusCapture::_clearCloseTalkLearnedLevelResolver)() = resolveClearCloseTalkLearnedLevel;
InputHoldFn (*HybridTellusCapture::_holdInputResolver)() = resolveHoldInput;
InputHoldFn (*HybridTellusCapture::_releaseInputResolver)() = resolveReleaseInput;

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
  // Core configuration decides the output rate rules and Opus limits; this only guards the value range before the uint32 conversion.
  if (!std::isfinite(rate) || rate < 8000 || rate > 192000 || std::fmod(rate, 50) != 0) {
    throw std::runtime_error("invalid_processing_rate");
  }
  auto session = acquire();
  return session->submit([state = session.get(), config, rate] {
    state->check(tellus_audio_session_configure(state->handle,
      reinterpret_cast<const uint8_t*>(config.data()), config.size()));
    state->processingRate = static_cast<uint32_t>(rate);
  });
}

std::shared_ptr<Promise<void>> HybridTellusCapture::configureAudioDevices(
    const std::string& mic, const std::string& playback, const std::string& route) {
  auto session = acquire();
  return session->submit([state = session.get(), mic, playback, route] { state->configureAudioDevices(mic, playback, route); });
}

std::shared_ptr<Promise<std::string>> HybridTellusCapture::listAudioDevices(const std::string& source) {
  auto session = acquire();
  return session->submit([state = session.get(), source] { return state->listAudioDevices(source); });
}

std::shared_ptr<Promise<std::string>> HybridTellusCapture::getAudioDeviceStatus() {
  auto session = acquire();
  return session->submit([state = session.get()] { return state->getAudioDeviceStatus(); }, true);
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

std::shared_ptr<Promise<void>> HybridTellusCapture::setMicGainDb(double db) {
  if (!std::isfinite(db) || db < -60 || db > 12) throw std::invalid_argument("invalid_audio_gain_db");
  auto session = acquire();
  return session->submit([state = session.get(), db] {
    state->check(tellus_audio_session_set_mic_gain_db(state->handle, static_cast<float>(db)));
  });
}

std::shared_ptr<Promise<void>> HybridTellusCapture::setCloseTalkThresholdDb(double db) {
  if (!std::isfinite(db) || db < 0 || db > 60) throw std::invalid_argument("invalid_close_talk_threshold_db");
  auto session = acquire();
  const auto setThreshold = _closeTalkThresholdResolver();
  if (!setThreshold) throw std::runtime_error("tellus_close_talk_threshold_unsupported");
  return session->submit([state = session.get(), setThreshold, db] {
    state->check(setThreshold(state->handle, static_cast<float>(db)));
  });
}

void HybridTellusCapture::setCloseTalkThresholdResolverForTesting(DenoiseSettingFn (*resolver)()) {
  _closeTalkThresholdResolver = resolver;
}

std::shared_ptr<Promise<void>> HybridTellusCapture::setCloseTalkHoldMs(double value) {
  if (!std::isfinite(value) || value < 0 || value > 2000) throw std::invalid_argument("invalid_close_talk_hold_ms");
  auto session = acquire();
  const auto setValue = _closeTalkHoldResolver();
  if (!setValue) throw std::runtime_error("tellus_close_talk_hold_unsupported");
  return session->submit([state = session.get(), setValue, value] {
    state->check(setValue(state->handle, static_cast<float>(value)));
  });
}

void HybridTellusCapture::setCloseTalkHoldResolverForTesting(DenoiseSettingFn (*resolver)()) {
  _closeTalkHoldResolver = resolver;
}

std::shared_ptr<Promise<void>> HybridTellusCapture::setCloseTalkKeepGapDb(double value) {
  if (!std::isfinite(value) || value < 0 || value > 20) throw std::invalid_argument("invalid_close_talk_keep_gap_db");
  auto session = acquire();
  const auto setValue = _closeTalkKeepGapResolver();
  if (!setValue) throw std::runtime_error("tellus_close_talk_keep_gap_unsupported");
  return session->submit([state = session.get(), setValue, value] {
    state->check(setValue(state->handle, static_cast<float>(value)));
  });
}

void HybridTellusCapture::setCloseTalkKeepGapResolverForTesting(DenoiseSettingFn (*resolver)()) {
  _closeTalkKeepGapResolver = resolver;
}

std::shared_ptr<Promise<void>> HybridTellusCapture::setCloseTalkLevelMarginDb(double value) {
  if (!std::isfinite(value) || value < 0 || value > 20) throw std::invalid_argument("invalid_close_talk_level_margin_db");
  auto session = acquire();
  const auto setValue = _closeTalkLevelMarginResolver();
  if (!setValue) throw std::runtime_error("tellus_close_talk_level_margin_unsupported");
  return session->submit([state = session.get(), setValue, value] {
    state->check(setValue(state->handle, static_cast<float>(value)));
  });
}

void HybridTellusCapture::setCloseTalkLevelMarginResolverForTesting(DenoiseSettingFn (*resolver)()) {
  _closeTalkLevelMarginResolver = resolver;
}

std::shared_ptr<Promise<void>> HybridTellusCapture::setCloseTalkLearnedLevelDbfs(const std::optional<std::variant<nitro::NullType, double>>& dbfs) {
  // The generated spec passes JS null as NullType and an omitted value as an empty optional; both clear the learned level.
  const auto* number = dbfs ? std::get_if<double>(&*dbfs) : nullptr;
  if (number && (!std::isfinite(*number) || *number < -100 || *number > 0)) throw std::invalid_argument("invalid_close_talk_learned_level_dbfs");
  auto session = acquire();
  // null clears the learned level. The C ABI learned level setter rejects NaN, so null goes through the clear function.
  if (!number) {
    const auto clear = _clearCloseTalkLearnedLevelResolver();
    if (!clear) throw std::runtime_error("tellus_close_talk_learned_level_unsupported");
    return session->submit([state = session.get(), clear] { state->check(clear(state->handle)); });
  }
  const auto setLevel = _closeTalkLearnedLevelResolver();
  if (!setLevel) throw std::runtime_error("tellus_close_talk_learned_level_unsupported");
  return session->submit([state = session.get(), setLevel, value = *number] {
    state->check(setLevel(state->handle, static_cast<float>(value)));
  });
}

void HybridTellusCapture::setCloseTalkLearnedLevelResolverForTesting(DenoiseSettingFn (*resolver)()) {
  _closeTalkLearnedLevelResolver = resolver;
}

void HybridTellusCapture::setClearCloseTalkLearnedLevelResolverForTesting(DenoiseClearFn (*resolver)()) {
  _clearCloseTalkLearnedLevelResolver = resolver;
}

std::shared_ptr<Promise<void>> HybridTellusCapture::setDenoiseAttenuationLimitDb(double db) {
  if (!std::isfinite(db) || db < 0 || db > 60) throw std::invalid_argument("invalid_denoise_attenuation_limit_db");
  auto session = acquire();
  const auto setLimit = _denoiseAttenuationLimitResolver();
  if (!setLimit) throw std::runtime_error("tellus_denoise_attenuation_limit_unsupported");
  return session->submit([state = session.get(), setLimit, db] {
    state->check(setLimit(state->handle, static_cast<float>(db)));
  });
}

void HybridTellusCapture::setDenoiseAttenuationLimitResolverForTesting(DenoiseSettingFn (*resolver)()) {
  _denoiseAttenuationLimitResolver = resolver;
}

std::shared_ptr<Promise<void>> HybridTellusCapture::holdInput() {
  auto session = acquire();
  const auto hold = _holdInputResolver();
  if (!hold) throw std::runtime_error("tellus_input_hold_unsupported");
  return session->submit([state = session.get(), hold] { state->holdInput(hold); });
}

void HybridTellusCapture::setHoldInputResolverForTesting(InputHoldFn (*resolver)()) {
  _holdInputResolver = resolver;
}

// Check support before touching the session. Stopping delivery and discarding the queue happen only inside the worker's CaptureSession::releaseInput.
std::shared_ptr<Promise<void>> HybridTellusCapture::releaseInput() {
  auto session = acquire();
  const auto release = _releaseInputResolver();
  if (!release) throw std::runtime_error("tellus_input_hold_unsupported");
  return session->submit([state = session.get(), release] { state->releaseInput(release); });
}

void HybridTellusCapture::setReleaseInputResolverForTesting(InputHoldFn (*resolver)()) {
  _releaseInputResolver = resolver;
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
