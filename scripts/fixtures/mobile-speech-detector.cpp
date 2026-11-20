#include "CaptureFixture.hpp"
#include "HybridTellusSpeechDetector.hpp"
#include <NitroModules/ThreadUtils.hpp>
#include <fstream>

using namespace margelo::nitro::tellus;
namespace {
test::FakeDevice* microphone;
}

namespace margelo::nitro {
std::string ThreadUtils::getThreadName() { return "test"; }
void ThreadUtils::setThreadName(const std::string&) {}
bool ThreadUtils::isUIThread() { return false; }
std::shared_ptr<Dispatcher> ThreadUtils::createUIThreadDispatcher() { return nullptr; }
}

namespace margelo::nitro::tellus {
std::vector<uint8_t> readSpeechDetectionModel(const std::string& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) throw std::runtime_error("speech_detection_model_not_found");
  return {std::istreambuf_iterator<char>(file), {}};
}

std::unique_ptr<AudioDevice> createAudioDevice(
    std::function<void(const float*, size_t, uint32_t, int64_t)> capture,
    std::function<void(const float*, size_t, uint32_t)>,
    std::function<void(const std::string&)> error) {
  auto device = std::make_unique<test::FakeDevice>();
  device->capture = std::move(capture);
  device->error = std::move(error);
  microphone = device.get();
  return device;
}
}

int main(int argc, char** argv) {
  assert(argc == 2);
  HybridTellusSpeechDetector detector;
  detector.loadModel(argv[1])->await().get();

  std::atomic<int> events{0};
  std::promise<void> interrupted;
  auto onEvent = [&](bool speaking, double timestampMs) {
    assert(!speaking && timestampMs == 1024);
    ++events;
  };
  auto onError = [&](const std::string& error) {
    assert(error == "audio_interrupted");
    detector.stop()->await().get();
    detector.dispose();
    interrupted.set_value();
  };
  detector.start("input-2", onEvent, onError)->await().get();
  assert(microphone->selectedMic == "input-2" && microphone->selectedPlayback.empty());
  assert(microphone->permissionCount == 1 && microphone->starts == 1);

  // Supply 20 ms at the microphone's actual cadence. try_lock may legitimately drop a frame.
  const std::vector<float> silence(960, 0.0f);
  for (int frame = 0; frame < 150; ++frame) {
    microphone->capture(silence.data(), silence.size(), 48000, frame * 20);
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  assert(events == 1);
  detector.stop()->await().get();
  assert(microphone->stops == 1);
  detector.start("input-2", onEvent, onError)->await().get();
  assert(microphone->starts == 2);
  microphone->error("audio_interrupted");
  assert(interrupted.get_future().wait_for(std::chrono::seconds(5)) == std::future_status::ready);
  assert(microphone->stops == 2);
  std::puts("SDK detector emitted (false, 1024) once without a permit and survived reentrant disposal");
}
