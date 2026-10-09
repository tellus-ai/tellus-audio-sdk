#include "CaptureWorker.hpp"
#include <cassert>
#include <future>
#include <numeric>
#include <random>
#include <vector>

using margelo::nitro::tellus::CaptureWorker;

// 고정 seed에서 부분 I/O 크기를 생성한다. 손실 cursor는 분할 방식에 의존하면 안 된다.
void lossPartitions(std::mt19937& random) {
  for (size_t scenario = 0; scenario < 1000; ++scenario) {
    const uint32_t rate = (random() % 3681 + 160) * 50;
    const uint32_t processing = random() % 2 ? 16000 : 48000;
    const uint64_t total = random() % 100000 + 1;
    CaptureWorker worker([](const auto&) {});
    uint64_t converted = 0;
    for (uint64_t consumed = 0; consumed < total;) {
      const auto count = std::min<uint64_t>(random() % 8192 + 1, total - consumed);
      converted += worker.lostSamples(count, rate, processing);
      consumed += count;
    }
    assert(converted == total * processing / rate);
  }
}

void boundedInput(std::mt19937& random) {
  for (size_t scenario = 0; scenario < 100; ++scenario) {
    std::promise<void> entered, release;
    auto released = release.get_future().share();
    std::vector<size_t> lengths;
    std::vector<float> values;
    CaptureWorker worker([&](const auto& frame) {
      lengths.push_back(frame.count);
      values.push_back(frame.samples[frame.count - 1]);
    });
    assert(worker.enqueue([&] { entered.set_value(); released.wait(); }));
    entered.get_future().get();
    std::vector<size_t> expected;
    for (size_t index = 0; index < 16; ++index) {
      const auto count = random() % 8192 + 1;
      std::vector<float> samples(count, static_cast<float>(index));
      worker.capture(samples.data(), samples.size(), 48000, static_cast<int64_t>(index));
      std::fill(samples.begin(), samples.end(), -1);
      expected.push_back(count);
    }
    const auto rejected = random() % 8192 + 1;
    std::vector<float> overflow(rejected, 1);
    worker.capture(overflow.data(), rejected, 48000, 100);
    std::promise<uint64_t> drained;
    assert(worker.enqueue([&] { worker.drain(); drained.set_value(worker.discard(16000)); }));
    release.set_value();
    assert(drained.get_future().get() == rejected / 3);
    assert(lengths == expected);
    for (size_t index = 0; index < values.size(); ++index) assert(values[index] == static_cast<float>(index));
  }
}

void shutdownCompletesControls() {
  std::promise<void> entered, release;
  auto released = release.get_future().share();
  CaptureWorker worker([](const auto&) {});
  assert(worker.enqueue([&] { entered.set_value(); released.wait(); }));
  entered.get_future().get();
  std::array<std::promise<void>, 8> done;
  std::atomic<size_t> finished{0};
  for (auto& item : done) assert(worker.enqueue([&item, &finished] { ++finished; item.set_value(); }));
  assert(!worker.enqueue([] {}));
  std::promise<void> cleaned;
  worker.enqueueUrgent([&] { assert(finished == 0); cleaned.set_value(); });
  release.set_value();
  worker.shutdown();
  assert(cleaned.get_future().wait_for(std::chrono::seconds(0)) == std::future_status::ready);
  for (auto& item : done) assert(item.get_future().wait_for(std::chrono::seconds(0)) == std::future_status::ready);
  assert(!worker.enqueue([] {}));
}

int main() {
  std::mt19937 random(0x54454c4c);
  lossPartitions(random);
  boundedInput(random);
  shutdownCompletesControls();
}
