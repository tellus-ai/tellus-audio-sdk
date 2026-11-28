#pragma once

// Stand-in for the Nitro Modules header of this name. The Flutter plugin compiles the capture
// session of the React Native SDK (platforms/mobile/cpp/CaptureSession) unchanged, and that code
// includes <NitroModules/Promise.hpp>. It uses create(), resolve(), reject() and await(); then() is
// for the binding in tellus_flutter_capture.cpp, which turns a settled promise into a reply to Dart.

#include <exception>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <utility>

namespace margelo::nitro {

template <typename T>
class Promise final {
public:
  static std::shared_ptr<Promise> create() { return std::make_shared<Promise>(); }

  // resolve() for Promise<void>, resolve(value) for the others.
  template <typename... Value>
  void resolve(Value&&... value) {
    _state.set_value(std::forward<Value>(value)...);
    settle();
  }

  void reject(const std::exception_ptr& error) {
    _state.set_exception(error);
    settle();
  }

  // get() on the returned future waits for the result and returns it, or rethrows the rejection.
  std::shared_future<T> await() { return _result; }

  // Calls the listener once with the settled result: on the thread that settles the promise, or at
  // once when it has already settled. The listener must not throw.
  void then(std::function<void(std::shared_future<T>)> listener) {
    {
      std::lock_guard lock(_mutex);
      if (!_settled) {
        _listener = std::move(listener);
        return;
      }
    }
    listener(_result);
  }

private:
  void settle() {
    std::function<void(std::shared_future<T>)> listener;
    {
      std::lock_guard lock(_mutex);
      _settled = true;
      listener.swap(_listener);
    }
    if (listener) listener(_result);
  }

  std::promise<T> _state;
  std::shared_future<T> _result = _state.get_future().share();
  std::mutex _mutex;
  bool _settled = false;
  std::function<void(std::shared_future<T>)> _listener;
};

} // namespace margelo::nitro
