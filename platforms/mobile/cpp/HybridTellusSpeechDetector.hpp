#pragma once

#include "AudioDevice.hpp"
#include "CaptureWorker.hpp"
#include "MicrophonePriority.hpp"
#include "HybridTellusSpeechDetectorSpec.hpp"
#include "tellus_audio_engine.h"

#include <atomic>
#include <memory>
#include <vector>

namespace margelo::nitro::tellus {

// permit 없는 발화 감지 전용 Nitro 객체다. capture와 handle·worker·OS 장치를 공유하지 않고 감지기 C ABI만 부른다.
// 마이크는 capture와 같은 AudioDevice를 입력만 열어 쓰고(재생·render는 쓰지 않는다), realtime callback은 worker FIFO에 복사만 한다.
// 감지기 handle 호출(create·push·poll·destroy)은 모두 worker thread에서 직렬로 한다.
class HybridTellusSpeechDetector final : public HybridTellusSpeechDetectorSpec {
public:
  HybridTellusSpeechDetector();
  ~HybridTellusSpeechDetector() override;
  std::shared_ptr<Promise<void>> loadModel(const std::string& path) override;
  std::shared_ptr<Promise<void>> start(const std::string& micDeviceId,
      const std::function<void(bool, double)>& onEvent, const std::function<void(const std::string&)>& onError) override;
  std::shared_ptr<Promise<void>> stop() override;
  void dispose() override;

private:
  template<typename F> std::shared_ptr<Promise<void>> submit(F operation);
  void process(const CaptureWorker::Frame& frame);
  void finish();
  void fail(const std::string& code);
  std::atomic<bool> _disposed{false};
  std::atomic<bool> _capturing{false};
  std::shared_ptr<DetectionInput> _input; // worker 전용
  std::atomic<uint64_t> _revision{0};
  std::vector<uint8_t> _model;
  TellusSpeechDetector* _detector = nullptr;
  std::function<void(bool, double)> _onEvent;
  std::unique_ptr<CaptureWorker> _worker;
  std::unique_ptr<AudioDevice> _device;
};

} // namespace margelo::nitro::tellus
