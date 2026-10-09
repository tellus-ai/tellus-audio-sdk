#include "CaptureSession.hpp"
#include <cassert>
#include <fstream>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

using namespace margelo::nitro::tellus;
extern char** environ;

namespace {
class FakeDevice final : public AudioDevice {
public:
  std::function<void()> permission;
  std::function<void(const float*, size_t, uint32_t, int64_t)> capture;
  std::function<void(const float*, size_t, uint32_t)> render;
  std::promise<void> decoding, playing;
  std::atomic<bool> blockDecode{false}, blockPlay{false};
  std::function<void(const std::string&)> error;
  size_t permissionCount = 0, starts = 0;
  std::atomic<size_t> stops{0};
  std::atomic<bool> foreground{false};
  bool retainedNotification = false;
  void requestCapturePermission() override { ++permissionCount; if (permission) permission(); }
  void startCapture(uint32_t) override { ++starts; foreground = true; }
  void stopCapture() override { ++stops; foreground = false; changed.notify_all(); }
  void pauseCapture() override { if (!retainedNotification) stopCapture(); }
  bool waitUntilStopped() {
    std::unique_lock lock(mutex);
    return changed.wait_for(lock, std::chrono::seconds(5), [&] { return !foreground; });
  }
  void cancelPlayback() override { changed.notify_all(); }
  DecodedAudio decodeAudio(const std::vector<uint8_t>&, const std::function<bool()>& cancelled) override {
    if (blockDecode) {
      decoding.set_value();
      std::unique_lock lock(mutex);
      assert(changed.wait_for(lock, std::chrono::seconds(2), [&] { return cancelled(); }));
    }
    if (cancelled()) throw std::runtime_error("playback_cancelled");
    return {std::vector<float>(320, 0.1f), 16000};
  }
  void play(const float* samples, size_t count, uint32_t rate, const std::function<bool()>& cancelled) override {
    render(samples, count, rate);
    if (blockPlay) {
      playing.set_value();
      std::unique_lock lock(mutex);
      assert(changed.wait_for(lock, std::chrono::seconds(2), [&] { return cancelled(); }));
    }
    if (cancelled()) throw std::runtime_error("playback_cancelled");
  }
private:
  std::mutex mutex;
  std::condition_variable changed;
};
FakeDevice* device;
std::string engineRoot, fixturePath, directory;

void configure(CaptureSession& session) {
  const std::string config = R"({"sampleRate":16000,"denoise":false,"vad":false,"echoCancellation":true,"micAgc2":false,"transport":{"codec":"opus","bitrateBps":64000}})";
  session.submit([&] { session.check(tellus_audio_session_configure(session.handle,
    reinterpret_cast<const uint8_t*>(config.data()), config.size())); })->await().get();
}

void authorize(CaptureSession& session, const std::string& ttlMs = "60000") {
  const auto request = session.submit([&] {
    return session.json([&](auto* bytes, auto capacity, auto* written) {
      return tellus_audio_session_create_authorization_request(session.handle,
        reinterpret_cast<const uint8_t*>("ci-conversation"), 15, bytes, capacity, written);
    });
  })->await().get();
  const auto input = directory + "/request.json", output = directory + "/permit.txt";
  { std::ofstream file(input); file << request; }
  std::array<char*, 7> args{const_cast<char*>("node"), fixturePath.data(), engineRoot.data(),
                           const_cast<char*>(input.c_str()), const_cast<char*>(output.c_str()),
                           const_cast<char*>(ttlMs.c_str()), nullptr};
  pid_t process;
  assert(posix_spawnp(&process, "node", nullptr, nullptr, args.data(), environ) == 0);
  int status;
  assert(waitpid(process, &status, 0) == process && WIFEXITED(status) && WEXITSTATUS(status) == 0);
  std::ifstream file(output);
  const std::string token{std::istreambuf_iterator<char>(file), {}};
  session.submit([&] { session.check(tellus_audio_session_apply_authorization(session.handle,
    reinterpret_cast<const uint8_t*>(token.data()), token.size())); })->await().get();
  unlink(input.c_str()); unlink(output.c_str());
}

void approvalBeforePermission() {
  CaptureSession session;
  configure(session);
  bool rejected = false;
  try { session.submit([&] { session.start(false); })->await().get(); }
  catch (const std::exception&) { rejected = true; }
  assert(rejected && device->permissionCount == 0 && device->starts == 0);
  authorize(session);
  device->permission = [&] { session.invalidate(); };
  rejected = false;
  try { session.submit([&] { session.start(false); })->await().get(); }
  catch (const std::exception&) { rejected = true; }
  assert(rejected && device->permissionCount == 1 && device->starts == 0);
  device->permission = nullptr;
  authorize(session);
  session.submit([&] { session.start(true); })->await().get();
  assert(device->starts == 1);
}

void playbackCancellationAndRenewal() {
  CaptureSession session;
  configure(session); authorize(session);
  session.submit([&] { session.start(false); })->await().get();
  device->blockPlay = true;
  const auto ticket = session.reservePlayback();
  auto play = std::async(std::launch::async, [&] {
    try { session.playback(std::vector<float>(320, 0.1f), 16000, ticket); }
    catch (const std::exception&) { return true; }
    return false;
  });
  device->playing.get_future().get();
  session.suspendDelivery();
  session.submit([&] { session.pause(); })->await().get();
  assert(play.wait_for(std::chrono::seconds(2)) == std::future_status::ready && play.get());
  session.submit([&] { session.start(true); })->await().get();
  device->blockDecode = true;
  const auto encodedTicket = session.reservePlayback();
  auto decode = std::async(std::launch::async, [&] {
    try { session.playbackEncoded({1}, encodedTicket); }
    catch (const std::exception&) { return true; }
    return false;
  });
  device->decoding.get_future().get();
  session.invalidate();
  assert(decode.wait_for(std::chrono::seconds(2)) == std::future_status::ready && decode.get());
  authorize(session);
  session.submit([&] { session.start(true); })->await().get();
  session.submit([&] { session.check(tellus_audio_session_clear_render(session.handle)); })->await().get();
}

void fullControlQueueStillStopsCapture(bool authorizationRevoked) {
  CaptureSession session;
  configure(session); authorize(session);
  session.submit([&] { session.start(false); })->await().get();
  std::promise<void> entered, released;
  auto ready = released.get_future();
  auto blocked = session.submit([&] { entered.set_value(); ready.get(); });
  entered.get_future().get();
  const auto stoppedBefore = device->stops.load();
  std::vector<std::shared_ptr<margelo::nitro::Promise<void>>> pending;
  for (size_t index = 0; index < 8; ++index) {
    pending.push_back(session.submit([&] {
      assert(device->stops > stoppedBefore && !session.isCapturing());
    }));
  }
  if (authorizationRevoked) session.invalidate();
  else device->error("capture_route_changed");
  released.set_value();
  blocked->await().get();
  for (const auto& command : pending) command->await().get();
  assert(device->stops > stoppedBefore);
  if (authorizationRevoked) {
    authorize(session);
    session.submit([&] { session.start(true); })->await().get();
    assert(device->starts == 2);
  }
}

void resetRejectsOldChunksAndKeepsCaptureRunning() {
  std::mutex mutex;
  std::condition_variable changed;
  std::vector<std::pair<uint64_t, uint64_t>> chunks;
  CaptureSession session;
  configure(session); authorize(session);
  session.submit([&] {
    session.onChunk = [&](auto, const auto&, uint64_t epoch, uint64_t generation) {
      { std::lock_guard lock(mutex); chunks.emplace_back(epoch, generation); }
      session.acknowledgeChunk();
      changed.notify_all();
    };
    session.start(false);
  })->await().get();
  std::vector<float> samples(1600, 0.1f);
  device->capture(samples.data(), samples.size(), 16000, 0);
  std::pair<uint64_t, uint64_t> old;
  {
    std::unique_lock lock(mutex);
    assert(changed.wait_for(lock, std::chrono::seconds(2), [&] { return !chunks.empty(); }));
    old = chunks.front();
  }
  const auto capturing = session.isCapturing();
  const auto revision = session.suspendDelivery();
  session.submit([&] { session.reset(revision, capturing); })->await().get();
  assert(session.isCapturing() && !session.canDeliver(old.first, old.second));
  size_t previous;
  { std::lock_guard lock(mutex); previous = chunks.size(); }
  device->capture(samples.data(), samples.size(), 16000, 100);
  {
    std::unique_lock lock(mutex);
    assert(changed.wait_for(lock, std::chrono::seconds(2), [&] { return chunks.size() > previous; }));
    assert(session.canDeliver(chunks.back().first, chunks.back().second));
  }
  assert(device->starts == 1 && device->stops == 0);
}

void playbackRateDoesNotDiscardCaptureHistory() {
  std::mutex mutex;
  std::condition_variable changed;
  std::vector<std::string> chunks;
  CaptureSession session;
  configure(session); authorize(session);
  session.submit([&] {
    session.onChunk = [&](auto, const auto& metadata, uint64_t, uint64_t) {
      { std::lock_guard lock(mutex); chunks.push_back(metadata); }
      session.acknowledgeChunk(); changed.notify_all();
    };
    session.start(false);
  })->await().get();
  const std::vector<float> capture(4800, 0.1f);
  device->capture(capture.data(), capture.size(), 48000, 0);
  {
    std::unique_lock lock(mutex);
    assert(changed.wait_for(lock, std::chrono::seconds(2), [&] { return !chunks.empty(); }));
  }
  const auto ticket = session.reservePlayback();
  session.playback(std::vector<float>(3200, 0), 16000, ticket);
  size_t previous;
  { std::lock_guard lock(mutex); previous = chunks.size(); }
  device->capture(capture.data(), capture.size(), 48000, 100);
  {
    std::unique_lock lock(mutex);
    assert(changed.wait_for(lock, std::chrono::seconds(2), [&] { return chunks.size() > previous; }));
    assert(chunks.back().find("device_gap") == std::string::npos);
  }
}

void pausedPermitExpiryStopsTheOsLeaseWithoutJsTimers() {
  CaptureSession session;
  configure(session); authorize(session, "2000");
  session.submit([&] {
    device->retainedNotification = true;
    session.start(false);
    session.pause();
  })->await().get();
  assert(device->foreground);
  assert(device->waitUntilStopped());
  assert(!session.isCapturing());
}
} // namespace

namespace margelo::nitro::tellus {
std::unique_ptr<AudioDevice> createAudioDevice(
    std::function<void(const float*, size_t, uint32_t, int64_t)> capture,
    std::function<void(const float*, size_t, uint32_t)> render,
    std::function<void(const std::string&)> error) {
  auto fake = std::make_unique<FakeDevice>();
  fake->capture = std::move(capture); fake->render = std::move(render);
  fake->error = std::move(error);
  device = fake.get();
  return fake;
}
} // namespace margelo::nitro::tellus

int main(int argc, char** argv) {
  assert(argc == 3);
  engineRoot = argv[1]; fixturePath = argv[2];
  char path[] = "/tmp/tellus-session-test-XXXXXX";
  directory = mkdtemp(path);
  approvalBeforePermission();
  playbackCancellationAndRenewal();
  fullControlQueueStillStopsCapture(true);
  fullControlQueueStillStopsCapture(false);
  resetRejectsOldChunksAndKeepsCaptureRunning();
  playbackRateDoesNotDiscardCaptureHistory();
  pausedPermitExpiryStopsTheOsLeaseWithoutJsTimers();
  rmdir(directory.c_str());
}
