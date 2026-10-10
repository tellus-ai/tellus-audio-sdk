#pragma once

#include <array>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>

namespace margelo::nitro::tellus {

// realtime callback은 고정 FIFO에 복사만 한다. 제어와 오디오 처리는 하나의 worker가 직렬 실행한다.
class CaptureWorker final {
public:
  struct Frame {
    std::array<float, 8192> samples;
    size_t count = 0;
    uint32_t rate = 0;
    int64_t timestamp = 0;
    uint64_t lostBefore = 0;
  };

  explicit CaptureWorker(std::function<void(const Frame&)> process, std::function<void()> heartbeat = {});
  ~CaptureWorker();
  void shutdown();
  bool enqueue(std::function<void()> command);
  void enqueueUrgent(std::function<void()> cleanup);
  void capture(const float* samples, size_t count, uint32_t rate, int64_t timestamp);
  void drain();
  uint64_t discard(uint32_t processingRate);
  uint64_t lostSamples(uint64_t count, uint32_t nativeRate, uint32_t processingRate);

private:
  bool pop(Frame& frame);
  void run();
  std::function<void(const Frame&)> _process;
  std::function<void()> _heartbeat;
  std::mutex _mutex;
  std::condition_variable _ready;
  std::deque<std::function<void()>> _commands;
  std::function<void()> _urgent;
  std::array<Frame, 16> _frames;
  size_t _read = 0;
  size_t _write = 0;
  size_t _size = 0;
  std::atomic<uint64_t> _lost{0};
  std::atomic<uint32_t> _rate{48000};
  uint64_t _lossRemainder = 0;
  uint32_t _lossRate = 48000;
  bool _closed = false;
  std::thread _thread;
};

} // namespace margelo::nitro::tellus
