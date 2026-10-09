#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace margelo::nitro::tellus {

struct DecodedAudio {
  std::vector<float> samples;
  uint32_t rate;
};

// OS 캡처·재생만 담당한다. 캡처 callback은 샘플 복사만 하고 render는 worker에서 전달한다.
class AudioDevice {
public:
  virtual ~AudioDevice() = default;
  virtual void requestCapturePermission() = 0;
  virtual void startCapture(uint32_t preferredRate) = 0;
  virtual void stopCapture() = 0;
  virtual void pauseCapture() { stopCapture(); }
  virtual void setRecordingNotification(const std::string&, const std::string&, bool, bool,
                                       std::function<void(const std::string&)>) {}
  virtual void play(const float* samples, size_t count, uint32_t rate,
                    const std::function<bool()>& cancelled) = 0;
  virtual void cancelPlayback() = 0;
  virtual DecodedAudio decodeAudio(const std::vector<uint8_t>& encoded,
                                  const std::function<bool()>& cancelled) = 0;
};

std::unique_ptr<AudioDevice> createAudioDevice(
    std::function<void(const float*, size_t, uint32_t, int64_t)> capture,
    std::function<void(const float*, size_t, uint32_t)> render,
    std::function<void(const std::string&)> error);

// file:// 경로 또는 SDK resource bundle의 암호화 컨테이너를 읽는다. 평문 모델은 받지 않는다.
std::vector<uint8_t> readEncryptedModel(const std::string& path);

} // namespace margelo::nitro::tellus
