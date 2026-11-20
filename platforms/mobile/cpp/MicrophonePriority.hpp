#pragma once

#include <atomic>
#include <functional>
#include <future>
#include <memory>
#include <string>
#include <vector>

namespace margelo::nitro::tellus {

inline constexpr char detectionPreempted[] = "speech_detection_preempted_by_capture";

// start 요청마다 등록한다. 입력이 실제로 닫힐 때까지 동시 수집 요청이 같은 완료 신호를 기다린다.
class DetectionInput final {
public:
  static std::shared_ptr<DetectionInput> reserve(std::function<void()> scheduleStop);
  void markRunning(const std::function<void(const std::string&)>& onError);
  std::function<void(const std::string&)> takeErrorCallback();
  bool finish();
  void closeFailed(std::exception_ptr error);
  bool preempted() const { return _preempted.load(); }

private:
  friend class CaptureInput;
  std::atomic<bool> _preempted{false};
  std::function<void()> _scheduleStop;
  std::function<void(const std::string&)> _onError;
  bool _retryClose = false;
  std::promise<void> _closed;
  std::shared_future<void> _completion = _closed.get_future().share();
};

struct MicrophoneHandoff {
  std::vector<std::shared_future<void>> closing;
  std::vector<std::function<void(const std::string&)>> notifications;
  void wait() const;
};

// 각 수집 객체가 획득한 우선권을 pause 동안에도 보존한다.
class CaptureInput final {
public:
  MicrophoneHandoff claim();
  void release();
  ~CaptureInput() { release(); }
};

} // namespace margelo::nitro::tellus
