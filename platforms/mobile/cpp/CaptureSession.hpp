#pragma once

#include "AudioDevice.hpp"
#include "CaptureWorker.hpp"
#include "InputHold.hpp"
#include "LastError.hpp"
#include "tellus_audio_engine.h"
#include <NitroModules/ArrayBuffer.hpp>
#include <NitroModules/Promise.hpp>
#include <future>
#include <stdexcept>
#include <type_traits>

namespace margelo::nitro::tellus {

// An engine status failure. what() is the status name as before; message is the engine's explanation (empty with an old kit).
class EngineError final : public std::runtime_error {
public:
  EngineError(const char* code, std::string message) : std::runtime_error(code), message(std::move(message)) {}
  const std::string message;
};

// Manages the Rust handle and worker lifetimes together. The destructor ends OS input and all processing calls first.
class CaptureSession final {
public:
  CaptureSession();
  ~CaptureSession();
  TellusAudioSession* handle = nullptr;
  uint32_t processingRate = 16000;
  std::function<void(std::shared_ptr<ArrayBuffer>, const std::string&, uint64_t, uint64_t)> onChunk;
  // The first argument is the error code, the second the engine explanation (empty when there is none).
  std::function<void(const std::string&, const std::string&)> onError;
  std::atomic<bool> closed{false};

  // allowFailed marks recovery and query work (start, stop, reset, status) that still runs after an internal-error latch. allowClosed allows both.
  template<typename F>
  auto submit(F operation, bool allowClosed = false, bool allowFailed = false) {
    using Result = std::invoke_result_t<F>;
    auto promise = Promise<Result>::create();
    if (!_worker->enqueue([this, promise, operation = std::move(operation), allowClosed, allowFailed]() mutable {
      try {
        if (closed && !allowClosed) throw std::runtime_error("capture_disposed");
        if (_failed && !allowClosed && !allowFailed) throw std::runtime_error("internal_error");
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
  void configureAudioDevices(const std::string& micDeviceId, const std::string& playbackDeviceId,
                             const std::string& iosOutputRoute);
  std::string listAudioDevices(const std::string& source) { return _device->listAudioDevices(source); }
  std::string getAudioDeviceStatus() { return _device->getAudioDeviceStatus(); }
  void pause();
  void stop();
  void close();
  void reset(uint64_t revision, bool capturing);
  // hold and release run on the worker. The function is the C function found by the InputHold resolver and is not nullptr.
  void holdInput(InputHoldFn hold);
  void releaseInput(InputHoldFn release);
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
  // On a non-OK status, records the engine explanation as the last error and throws EngineError. INTERNAL_ERROR sets the failure latch.
  void check(TellusStatus status);
  std::string json(std::function<TellusStatus(uint8_t*, size_t, size_t*)> call);
  // The engine status JSON plus last_error_message, the last engine failure explanation (null when there is none).
  std::string status();
  // The explanation of the last failed engine call. Empty when there is none or the kit predates it.
  std::string lastErrorMessage();
  // Tests swap the resolver to exercise the old-kit path, then restore resolveCopyLastError.
  static void setCopyLastErrorResolverForTesting(CopyLastErrorFn (*resolver)());

private:
  void process(const CaptureWorker::Frame& frame);
  void fail(const std::string& error, const std::string& message = {});
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
  // Latch set after INTERNAL_ERROR. A successful start, stop or reset engine call clears it.
  std::atomic<bool> _failed{false};
  std::mutex _lastErrorMutex;
  std::string _lastErrorMessage;
  static CopyLastErrorFn (*_copyLastErrorResolver)();
  bool _started = false;
  bool _deviceSelectionLocked = false;
  bool _authorizationMonitored = false;
  // Core hold state, changed on the worker only after the C hold or release has succeeded.
  bool _inputHeld = false;
  std::unique_ptr<AudioDevice> _device;
  std::unique_ptr<CaptureWorker> _worker;
};

} // namespace margelo::nitro::tellus
