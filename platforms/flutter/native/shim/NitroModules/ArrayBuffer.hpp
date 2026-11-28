#pragma once

// Stand-in for the Nitro Modules header of this name. The Flutter plugin compiles the capture
// session of the React Native SDK (platforms/mobile/cpp/CaptureSession) unchanged, and that code
// includes <NitroModules/ArrayBuffer.hpp>. Only copy() is used there; size() and release() are for
// the binding in tellus_flutter_capture.cpp.

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <new>
#include <utility>

namespace margelo::nitro {

// One chunk payload in a malloc block, so that Dart can take it over and free it with tellus_flutter_free.
class ArrayBuffer final {
public:
  static std::shared_ptr<ArrayBuffer> copy(const uint8_t* data, size_t size) {
    auto* bytes = static_cast<uint8_t*>(std::malloc(std::max<size_t>(size, 1)));
    if (!bytes) throw std::bad_alloc();
    if (size > 0) std::memcpy(bytes, data, size);
    return std::shared_ptr<ArrayBuffer>(new ArrayBuffer(bytes, size));
  }
  ArrayBuffer(const ArrayBuffer&) = delete;
  ArrayBuffer& operator=(const ArrayBuffer&) = delete;
  ~ArrayBuffer() { std::free(_data); }

  size_t size() const { return _size; }
  // Hands the block to the caller, who frees it.
  uint8_t* release() { return std::exchange(_data, nullptr); }

private:
  ArrayBuffer(uint8_t* data, size_t size) : _data(data), _size(size) {}
  uint8_t* _data;
  size_t _size;
};

} // namespace margelo::nitro
