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

// Handles OS capture and playback only. The capture callback only copies samples; render is delivered from the worker.
class AudioDevice {
public:
  virtual ~AudioDevice() = default;
  virtual void configureDevices(const std::string& micDeviceId, const std::string& playbackDeviceId,
                                const std::string& iosOutputRoute) = 0;
  virtual std::string listAudioDevices(const std::string& source) = 0;
  virtual std::string getAudioDeviceStatus() = 0;
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

// Reads encrypted containers from a file:// path or the SDK resource bundle. Plaintext models are not accepted.
std::vector<uint8_t> readEncryptedModel(const std::string& path);

} // namespace margelo::nitro::tellus
