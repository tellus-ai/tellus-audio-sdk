#pragma once

#include "AudioDevice.hpp"
#include "CaptureWorker.hpp"
#include "tellus_audio_engine.h"
#include <NitroModules/ArrayBuffer.hpp>
#include <NitroModules/Promise.hpp>
#include <future>
#include <stdexcept>
#include <type_traits>

namespace margelo::nitro::tellus {

// Rust handle과 worker 수명을 함께 관리한다. destructor는 OS 입력과 모든 처리 호출을 먼저 종료한다.
class CaptureSession final {
public:
  CaptureSession();
  ~CaptureSession();
  TellusAudioSession* handle = nullptr;
  uint32_t processingRate = 16000;
  std::function<void(std::shared_ptr<ArrayBuffer>, const std::string&, uint64_t, uint64_t)> onChunk;
  std::function<void(const std::string&)> onError;
  std::atomic<bool> closed{false};

  template<typename F>
  auto submit(F operation, bool allowClosed = false) {
    using Result = std::invoke_result_t<F>;
    auto promise = Promise<Result>::create();
    if (!_worker->enqueue([this, promise, operation = std::move(operation), allowClosed]() mutable {
      try {
        if (closed && !allowClosed) throw std::runtime_error("capture_disposed");
        if (_failed && !allowClosed) throw std::runtime_error("internal_error");
        if constexpr (std::is_void_v<Result>) { operation(); promise->resolve(); }
        else promise->resolve(operation());
      } catch (...) { promise->reject(std::current_exception()); }
    })) {
      suspendDelivery();
      _worker->enqueueUrgent([this] { fail("capture_control_queue_full"); });
      promise->reject(std::make_exception_ptr(std::runtime_error("capture_control_queue_full")));
    }
    return promise;
  }

  void start(bool resume);
  void pause();
  void stop();
  void close();
  void reset(uint64_t revision, bool capturing);
  void invalidate();
  void setRecordingNotification(const std::string& title, const std::string& contentText,
                                bool pauseAction, bool resumeAction,
                                std::function<void(const std::string&)> onAction);
  uint64_t reservePlayback();
  void playback(const std::vector<float>& samples, uint32_t rate, uint64_t ticket);
  void playbackEncoded(const std::vector<uint8_t>& encoded, uint64_t ticket);
  uint64_t cancelPlayback();
  void awaitPlayback(uint64_t cancelledEpoch);
  void clearCancelledRender(uint64_t cancelledEpoch);
  uint64_t suspendDelivery() { _captureEnabled = false; _deliveryEnabled = false; return ++_controlRevision; }
  void stopAccepting() { _captureEnabled = false; ++_controlRevision; }
  bool isCapturing() const { return _captureEnabled; }
  bool canDeliver(uint64_t epoch, uint64_t generation);
  void acknowledgeChunk();
  void check(TellusStatus status);
  std::string json(std::function<TellusStatus(uint8_t*, size_t, size_t*)> call);

private:
  void process(const CaptureWorker::Frame& frame);
  void fail(const std::string& error);
  void clearQueuedCapture();
  void requirePlayback(uint64_t ticket);
  void finishPlayback();
  void verifyAuthorization();
  static void chunk(void* context, const uint8_t* payload, size_t length,
                    const uint8_t* metadata, size_t metadataLength, uint64_t epoch, uint64_t generation);
  std::atomic<bool> _captureEnabled{false};
  std::atomic<uint64_t> _controlRevision{0};
  std::atomic<bool> _deliveryEnabled{false};
  std::atomic<bool> _playing{false};
  std::atomic<uint64_t> _playbackEpoch{0};
  std::atomic<uint64_t> _playingEpoch{0};
  std::mutex _playbackMutex;
  std::condition_variable _playbackFinished;
  std::atomic<size_t> _pendingChunks{0};
  std::atomic<bool> _outputOverflow{false};
  std::atomic<bool> _failed{false};
  bool _started = false;
  bool _authorizationMonitored = false;
  std::unique_ptr<AudioDevice> _device;
  std::unique_ptr<CaptureWorker> _worker;
};

} // namespace margelo::nitro::tellus
