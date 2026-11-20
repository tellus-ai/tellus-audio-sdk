#include "MicrophonePriority.hpp"

#include <mutex>
#include <set>
#include <stdexcept>
#include <utility>

namespace margelo::nitro::tellus {
namespace {
std::mutex ownership;
std::set<DetectionInput*> detectors;
std::set<CaptureInput*> captures;
}

std::shared_ptr<DetectionInput> DetectionInput::reserve(std::function<void()> scheduleStop) {
  std::lock_guard lock(ownership);
  if (!captures.empty()) throw std::runtime_error(detectionPreempted);
  auto input = std::make_shared<DetectionInput>();
  input->_scheduleStop = std::move(scheduleStop);
  detectors.insert(input.get());
  return input;
}

void DetectionInput::markRunning(const std::function<void(const std::string&)>& onError) {
  std::lock_guard lock(ownership);
  if (_preempted) throw std::runtime_error(detectionPreempted);
  _onError = onError;
}

std::function<void(const std::string&)> DetectionInput::takeErrorCallback() {
  std::lock_guard lock(ownership);
  return std::exchange(_onError, {});
}

bool DetectionInput::finish() {
  std::lock_guard lock(ownership);
  if (detectors.erase(this) && !_retryClose) _closed.set_value();
  return _preempted;
}

// 실패한 OS 입력은 등록에 남겨 다음 수집이 close를 다시 확인하게 한다.
void DetectionInput::closeFailed(std::exception_ptr error) {
  std::lock_guard lock(ownership);
  if (!_retryClose) _closed.set_exception(error);
  _retryClose = true;
}

MicrophoneHandoff CaptureInput::claim() {
  MicrophoneHandoff handoff;
  std::lock_guard lock(ownership);
  captures.insert(this);
  for (auto* detector : detectors) {
    const bool retry = detector->_retryClose;
    if (retry) {
      detector->_closed = {};
      detector->_completion = detector->_closed.get_future().share();
      detector->_retryClose = false;
    }
    handoff.closing.push_back(detector->_completion);
    const bool first = !detector->_preempted.exchange(true);
    if (!first && !retry) continue;
    if (first && detector->_onError) handoff.notifications.push_back(std::exchange(detector->_onError, {}));
    // worker 큐에 넣기만 한다. 객체 해제도 이 mutex에서 등록을 제거한 뒤 끝난다.
    detector->_scheduleStop();
  }
  return handoff;
}

void CaptureInput::release() {
  std::lock_guard lock(ownership);
  captures.erase(this);
}

void MicrophoneHandoff::wait() const {
  std::exception_ptr failure;
  for (const auto& closed : closing) {
    try { closed.get(); } catch (...) { failure = std::current_exception(); }
  }
  for (const auto& notify : notifications) {
    try { notify(detectionPreempted); } catch (...) {}
  }
  if (failure) std::rethrow_exception(failure);
}

} // namespace margelo::nitro::tellus
