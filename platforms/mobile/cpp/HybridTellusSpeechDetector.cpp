#include "HybridTellusSpeechDetector.hpp"

#include <stdexcept>

namespace margelo::nitro::tellus {

namespace {
void check(TellusStatus status) {
  if (status != TELLUS_OK) throw std::runtime_error(tellus_audio_status_name(status));
}
} // namespace

HybridTellusSpeechDetector::HybridTellusSpeechDetector() : HybridObject(TAG) {
  _worker = std::make_unique<CaptureWorker>([this](const auto& frame) { process(frame); });
  // render callback은 재생할 때만 불린다. 감지기는 재생하지 않으므로 빈 함수를 넘긴다.
  _device = createAudioDevice(
      [this](const float* samples, size_t count, uint32_t rate, int64_t timestamp) {
        if (_capturing) _worker->capture(samples, count, rate, timestamp);
      },
      [](const float*, size_t, uint32_t) {},
      [this](const std::string& code) {
        _capturing = false;
        _worker->enqueueUrgent([this, code] { fail(code); });
      });
}

HybridTellusSpeechDetector::~HybridTellusSpeechDetector() { dispose(); }

// worker가 남은 명령을 끝낸 뒤 OS 입력과 감지기를 닫는다. 끝난 뒤 들어온 명령은 speech_detector_disposed로 거부한다.
void HybridTellusSpeechDetector::dispose() {
  if (_disposed.exchange(true)) return;
  _capturing = false;
  _worker->shutdown();
  try { finish(); } catch (...) {
    // OS stop 자체가 실패한 경우 장치 destructor의 마지막 teardown까지 마친 뒤 등록을 푼다.
    _device.reset();
    tellus_audio_speech_detector_destroy(_detector);
    _detector = nullptr;
    _input->finish();
    _input.reset();
  }
}

template<typename F>
std::shared_ptr<Promise<void>> HybridTellusSpeechDetector::submit(F operation) {
  auto promise = Promise<void>::create();
  if (_disposed) {
    promise->reject(std::make_exception_ptr(std::runtime_error("speech_detector_disposed")));
    return promise;
  }
  if (!_worker->enqueue([this, promise, operation = std::move(operation)]() mutable {
    try {
      if (_disposed) throw std::runtime_error("speech_detector_disposed");
      operation();
      promise->resolve();
    } catch (...) { promise->reject(std::current_exception()); }
  })) promise->reject(std::make_exception_ptr(std::runtime_error("speech_detection_control_queue_full")));
  return promise;
}

std::shared_ptr<Promise<void>> HybridTellusSpeechDetector::loadModel(const std::string& path) {
  return submit([this, path] { _model = readSpeechDetectionModel(path); });
}

std::shared_ptr<Promise<void>> HybridTellusSpeechDetector::start(const std::string& micDeviceId,
    const std::function<void(bool, double)>& onEvent, const std::function<void(const std::string&)>& onError) {
  if (_disposed) return Promise<void>::rejected(std::make_exception_ptr(std::runtime_error("speech_detector_disposed")));
  auto promise = Promise<void>::create();
  const auto revision = _revision.load();
  try {
    auto input = DetectionInput::reserve([this] {
      _worker->enqueueCleanup([this] {
        if (_input && _input->preempted()) { try { finish(); } catch (...) {} }
      });
    });
    if (!_worker->enqueue([this, input, promise, micDeviceId, onEvent, onError, revision] {
      auto checkPending = [&] {
        if (input->preempted()) throw std::runtime_error(detectionPreempted);
        if (_disposed) throw std::runtime_error("speech_detector_disposed");
        if (revision != _revision) throw std::runtime_error("speech_detection_cancelled");
      };
      try {
        checkPending();
        if (_input) throw std::runtime_error("speech_detection_already_running");
        if (_model.empty()) throw std::runtime_error("speech_detection_model_not_loaded");
        _input = input;
        check(tellus_audio_speech_detector_create(_model.data(), _model.size(), &_detector));
        _device->configureDevices(micDeviceId, "", "");
        checkPending();
        _device->requestCapturePermission();
        checkPending();
        _device->startCapture(48000);
        checkPending();
        // worker가 start를 확정한 후에만 수집 측이 terminal callback을 가져갈 수 있다.
        _onEvent = onEvent;
        input->markRunning(onError);
        _capturing = true;
        promise->resolve();
      } catch (...) {
        auto error = std::current_exception();
        if (_input == input) {
          try { finish(); } catch (...) { error = std::current_exception(); }
        } else input->finish();
        if (input->preempted()) error = std::make_exception_ptr(std::runtime_error(detectionPreempted));
        promise->reject(error);
      }
    })) {
      if (input->finish()) throw std::runtime_error(detectionPreempted);
      throw std::runtime_error(_disposed ? "speech_detector_disposed" : "speech_detection_control_queue_full");
    }
  } catch (...) { promise->reject(std::current_exception()); }
  return promise;
}

std::shared_ptr<Promise<void>> HybridTellusSpeechDetector::stop() {
  ++_revision;
  _capturing = false;
  return submit([this] { finish(); });
}

// worker 전용이다. OS 입력을 닫고 아직 처리하지 않은 프레임을 버린 뒤 감지기를 폐기한다. 실행 중이 아니면 아무것도 하지 않는다.
void HybridTellusSpeechDetector::finish() {
  _capturing = false;
  if (!_input) return;
  if (_detector) {
    try { _device->stopCapture(); }
    catch (...) { _input->closeFailed(std::current_exception()); throw; }
  }
  // 버린 길이는 감지기에 알릴 곳이 없어 쓰지 않는다. 인자는 그 길이를 셀 레이트일 뿐이다.
  _worker->discard(16000);
  tellus_audio_speech_detector_destroy(_detector);
  _detector = nullptr;
  _onEvent = nullptr;
  _input->finish();
  _input.reset();
}

void HybridTellusSpeechDetector::fail(const std::string& code) {
  if (!_detector) return;
  auto onError = _input->takeErrorCallback();
  try { finish(); } catch (...) {}
  if (onError) ThreadPool::shared().run([notify = std::move(onError), code] {
    try { notify(code); } catch (...) {}
  });
}

// FIFO가 가득 차 잃은 샘플은 감지기에 넣지 않는다. timestamp는 판정에 들어간 오디오 길이라 그만큼 덜 진행한다.
void HybridTellusSpeechDetector::process(const CaptureWorker::Frame& frame) {
  if (!_capturing || !_input || _input->preempted()) return;
  const auto status = tellus_audio_speech_detector_push(_detector, frame.samples.data(), frame.count, frame.rate);
  if (status != TELLUS_OK) return fail(tellus_audio_status_name(status));
  for (;;) {
    uint8_t hasEvent = 0, speaking = 0;
    uint64_t timestampMs = 0;
    const auto polled = tellus_audio_speech_detector_poll_event(_detector, &hasEvent, &speaking, &timestampMs);
    if (polled != TELLUS_OK) return fail(tellus_audio_status_name(polled));
    if (!hasEvent) return;
    if (_capturing && !_input->preempted() && _onEvent) _onEvent(speaking != 0, static_cast<double>(timestampMs));
  }
}

} // namespace margelo::nitro::tellus
