#include "CaptureWorker.hpp"
#include <chrono>

#include <algorithm>
#include <cstring>

namespace margelo::nitro::tellus {

CaptureWorker::CaptureWorker(std::function<void(const Frame&)> process, std::function<void()> heartbeat)
    : _process(std::move(process)), _heartbeat(std::move(heartbeat)), _thread([this] { run(); }) {}

CaptureWorker::~CaptureWorker() { shutdown(); }

void CaptureWorker::shutdown() {
  {
    std::lock_guard<std::mutex> lock(_mutex);
    _closed = true;
  }
  _ready.notify_one();
  if (_thread.joinable()) _thread.join();
}

bool CaptureWorker::enqueue(std::function<void()> command) {
  {
    std::lock_guard<std::mutex> lock(_mutex);
    if (_closed || _commands.size() >= 8) return false;
    _commands.push_back(std::move(command));
  }
  _ready.notify_one();
  return true;
}

void CaptureWorker::enqueueUrgent(std::function<void()> cleanup) {
  {
    std::lock_guard<std::mutex> lock(_mutex);
    if (_closed) return;
    _urgent = std::move(cleanup);
  }
  _ready.notify_one();
}

void CaptureWorker::capture(const float* samples, size_t count, uint32_t rate, int64_t timestamp) {
  _rate.store(rate);
  std::unique_lock<std::mutex> lock(_mutex, std::try_to_lock);
  if (!lock.owns_lock() || _size == _frames.size() || count > _frames[0].samples.size()) {
    _lost.fetch_add(count);
    return;
  }
  if (_closed) return;
  auto& frame = _frames[_write];
  std::memcpy(frame.samples.data(), samples, count * sizeof(float));
  frame.count = count;
  frame.rate = rate;
  frame.timestamp = timestamp;
  frame.lostBefore = _lost.exchange(0);
  _write = (_write + 1) % _frames.size();
  ++_size;
  lock.unlock();
  _ready.notify_one();
}

bool CaptureWorker::pop(Frame& frame) {
  std::lock_guard<std::mutex> lock(_mutex);
  if (_size == 0) return false;
  frame = _frames[_read];
  _read = (_read + 1) % _frames.size();
  --_size;
  return true;
}

void CaptureWorker::drain() {
  Frame frame;
  while (pop(frame)) _process(frame);
}

uint64_t CaptureWorker::discard(uint32_t processingRate) {
  std::lock_guard<std::mutex> lock(_mutex);
  uint64_t dropped = lostSamples(_lost.exchange(0), _rate.load(), processingRate);
  while (_size > 0) {
    const auto& frame = _frames[_read];
    dropped += lostSamples(frame.count + frame.lostBefore, frame.rate, processingRate);
    _read = (_read + 1) % _frames.size();
    --_size;
  }
  return dropped;
}

uint64_t CaptureWorker::lostSamples(uint64_t count, uint32_t nativeRate, uint32_t processingRate) {
  // worker 전용 변환이다. 작은 I/O 조각의 소수 샘플도 다음 손실까지 보존한다.
  _lossRemainder = _lossRemainder * nativeRate / _lossRate;
  _lossRate = nativeRate;
  const auto scaled = static_cast<unsigned __int128>(count) * processingRate + _lossRemainder;
  _lossRemainder = static_cast<uint64_t>(scaled % nativeRate);
  return static_cast<uint64_t>(scaled / nativeRate);
}

void CaptureWorker::run() {
  Frame frame;
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  for (;;) {
    std::function<void()> command;
    {
      std::unique_lock<std::mutex> lock(_mutex);
      auto ready = [this] { return _closed || _urgent || !_commands.empty() || _size > 0; };
      if (_heartbeat) _ready.wait_until(lock, deadline, ready);
      else _ready.wait(lock, ready);
      if (_closed && !_urgent && _commands.empty()) return;
      if (_urgent) {
        command = std::move(_urgent);
        _urgent = nullptr;
      } else if (_heartbeat && std::chrono::steady_clock::now() >= deadline) {
        command = _heartbeat;
        deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
      } else if (!_commands.empty()) {
        command = std::move(_commands.front());
        _commands.pop_front();
      } else {
        frame = _frames[_read];
        _read = (_read + 1) % _frames.size();
        --_size;
      }
    }
    if (command) command();
    else _process(frame);
  }
}

} // namespace margelo::nitro::tellus
