#include "AudioDevice.hpp"

#include <jni.h>
#include <fbjni/fbjni.h>
#include <algorithm>
#include <chrono>
#include <mutex>
#include <stdexcept>
#include <thread>

namespace {
JavaVM* javaVm = nullptr;
jclass deviceClass = nullptr;
jclass decoderClass = nullptr;
jmethodID decodeAudio, decodedSamples, decodedRate;
jmethodID constructor, requestCapturePermission, startCapture, stopCapture, beginPlayback, writePlayback;
jmethodID awaitPlayback, cancelPlayback, endPlayback, closeDevice, readModel, pauseCapture, setNotification;

class JavaEnv {
public:
  JavaEnv() {
    const auto status = javaVm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6);
    if (status == JNI_EDETACHED) {
      if (javaVm->AttachCurrentThread(&env, nullptr) != JNI_OK) throw std::runtime_error("android_jni_attach_failed");
      attached = true;
    } else if (status != JNI_OK) throw std::runtime_error("android_jni_unavailable");
  }
  ~JavaEnv() { if (attached) javaVm->DetachCurrentThread(); }
  JNIEnv* env = nullptr;
private:
  bool attached = false;
};

void checkException(JNIEnv* env) {
  auto exception = env->ExceptionOccurred();
  if (exception == nullptr) return;
  env->ExceptionClear();
  auto type = env->GetObjectClass(exception);
  auto method = env->GetMethodID(type, "getMessage", "()Ljava/lang/String;");
  auto description = static_cast<jstring>(env->CallObjectMethod(exception, method));
  if (description == nullptr) {
    method = env->GetMethodID(type, "toString", "()Ljava/lang/String;");
    description = static_cast<jstring>(env->CallObjectMethod(exception, method));
  }
  const char* chars = env->GetStringUTFChars(description, nullptr);
  std::string message(chars);
  env->ReleaseStringUTFChars(description, chars);
  env->DeleteLocalRef(description);
  env->DeleteLocalRef(type);
  env->DeleteLocalRef(exception);
  throw std::runtime_error(message);
}

class AndroidAudioDevice final : public margelo::nitro::tellus::AudioDevice {
public:
  AndroidAudioDevice(
      std::function<void(const float*, size_t, uint32_t, int64_t)> capture,
      std::function<void(const float*, size_t, uint32_t)> render,
      std::function<void(const std::string&)> error)
      : capture_(std::move(capture)), render_(std::move(render)), error_(std::move(error)) {
    JavaEnv scope;
    auto local = scope.env->NewObject(deviceClass, constructor, reinterpret_cast<jlong>(this));
    checkException(scope.env);
    device_ = scope.env->NewGlobalRef(local);
    scope.env->DeleteLocalRef(local);
    checkException(scope.env);
    if (device_ == nullptr) throw std::runtime_error("android_device_allocation_failed");
  }

  ~AndroidAudioDevice() override {
    JavaEnv scope;
    // Kotlin close는 모든 콜백과 같은 monitor에서 nativeHandle을 지운다.
    scope.env->CallVoidMethod(device_, closeDevice);
    scope.env->ExceptionClear();
    scope.env->DeleteGlobalRef(device_);
  }

  void requestCapturePermission() override { invoke(::requestCapturePermission); }

  void startCapture(uint32_t rate) override {
    JavaEnv scope;
    scope.env->CallVoidMethod(device_, ::startCapture, static_cast<jint>(rate));
    checkException(scope.env);
  }
  void stopCapture() override { invoke(::stopCapture); }
  void pauseCapture() override { invoke(::pauseCapture); }

  void setRecordingNotification(const std::string& title, const std::string& contentText,
                                bool pauseAction, bool resumeAction,
                                std::function<void(const std::string&)> onAction) override {
    {
      std::lock_guard lock(notificationMutex_);
      onNotificationAction_ = std::move(onAction);
    }
    JavaEnv scope;
    auto heading = facebook::jni::make_jstring(title);
    auto body = facebook::jni::make_jstring(contentText);
    scope.env->CallVoidMethod(device_, setNotification, heading.get(), body.get(),
                             static_cast<jboolean>(pauseAction), static_cast<jboolean>(resumeAction));
    checkException(scope.env);
  }
  void cancelPlayback() override { invoke(::cancelPlayback); }

  void play(const float* samples, size_t count, uint32_t rate,
            const std::function<bool()>& cancelled) override {
    if (cancelled()) throw std::runtime_error("playback_cancelled");
    JavaEnv scope;
    scope.env->CallVoidMethod(device_, beginPlayback, static_cast<jint>(rate));
    checkException(scope.env);
    try {
      if (cancelled()) throw std::runtime_error("playback_cancelled");
      writeSamples(scope.env, samples, count, rate, cancelled);
      if (cancelled()) throw std::runtime_error("playback_cancelled");
      scope.env->CallVoidMethod(device_, awaitPlayback);
      checkException(scope.env);
      if (cancelled()) throw std::runtime_error("playback_cancelled");
    } catch (...) {
      scope.env->CallVoidMethod(device_, ::cancelPlayback);
      scope.env->ExceptionClear();
      scope.env->CallVoidMethod(device_, endPlayback);
      scope.env->ExceptionClear();
      throw;
    }
    scope.env->CallVoidMethod(device_, endPlayback);
    checkException(scope.env);
  }

  margelo::nitro::tellus::DecodedAudio decodeAudio(const std::vector<uint8_t>& encoded,
                                                 const std::function<bool()>& cancelled) override {
    if (encoded.empty() || encoded.size() > 16 * 1024 * 1024) throw std::runtime_error("encoded_audio_size_invalid");
    if (cancelled()) throw std::runtime_error("playback_cancelled");
    JavaEnv scope;
    auto buffer = scope.env->NewDirectByteBuffer(const_cast<uint8_t*>(encoded.data()), static_cast<jlong>(encoded.size()));
    checkException(scope.env);
    // decode와 취소 콜백은 동기 실행이므로 함수 반환까지 참조가 유지된다.
    auto result = scope.env->CallStaticObjectMethod(decoderClass, ::decodeAudio, buffer, reinterpret_cast<jlong>(&cancelled));
    scope.env->DeleteLocalRef(buffer);
    checkException(scope.env);
    auto samples = static_cast<jfloatArray>(scope.env->CallObjectMethod(result, decodedSamples));
    checkException(scope.env);
    const auto rate = scope.env->CallIntMethod(result, decodedRate);
    checkException(scope.env);
    const auto count = scope.env->GetArrayLength(samples);
    if (count <= 0 || count > 4 * 1024 * 1024) throw std::runtime_error("decoded_audio_size_invalid");
    margelo::nitro::tellus::DecodedAudio output{std::vector<float>(static_cast<size_t>(count)), static_cast<uint32_t>(rate)};
    scope.env->GetFloatArrayRegion(samples, 0, count, output.samples.data());
    scope.env->DeleteLocalRef(samples);
    scope.env->DeleteLocalRef(result);
    checkException(scope.env);
    if (cancelled()) throw std::runtime_error("playback_cancelled");
    return output;
  }

  void submit(const float* samples, size_t count, uint32_t rate, int64_t timestamp) {
    capture_(samples, count, rate, timestamp);
  }
  void error(const std::string& message) { error_(message); }
  void notificationAction(const std::string& action) {
    std::function<void(const std::string&)> callback;
    {
      std::lock_guard lock(notificationMutex_);
      callback = onNotificationAction_;
    }
    if (callback) callback(action);
  }

private:
  void invoke(jmethodID method) {
    JavaEnv scope;
    scope.env->CallVoidMethod(device_, method);
    checkException(scope.env);
  }

  void writeSamples(JNIEnv* env, const float* samples, size_t count, uint32_t rate,
                    const std::function<bool()>& cancelled) {
    size_t offset = 0;
    auto progress = std::chrono::steady_clock::now();
    while (offset < count) {
      if (cancelled()) throw std::runtime_error("playback_cancelled");
      const auto available = std::min(count - offset, static_cast<size_t>(rate / 50));
      auto buffer = env->NewDirectByteBuffer(const_cast<float*>(samples + offset), static_cast<jlong>(available * sizeof(float)));
      checkException(env);
      const auto bytes = env->CallIntMethod(device_, writePlayback, buffer, static_cast<jint>(available * sizeof(float)));
      env->DeleteLocalRef(buffer);
      checkException(env);
      if (bytes < 0 || bytes % sizeof(float) != 0 || static_cast<size_t>(bytes) > available * sizeof(float)) {
        throw std::runtime_error("android_playback_invalid_write_count");
      }
      if (bytes > 0) {
        const auto written = static_cast<size_t>(bytes) / sizeof(float);
        render_(samples + offset, written, rate);
        offset += written;
        progress = std::chrono::steady_clock::now();
      } else {
        if (std::chrono::steady_clock::now() - progress >= std::chrono::seconds(2)) {
          throw std::runtime_error("android_playback_write_timeout");
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
      }
    }
  }

  jobject device_ = nullptr;
  std::mutex notificationMutex_;
  std::function<void(const std::string&)> onNotificationAction_;
  std::function<void(const float*, size_t, uint32_t, int64_t)> capture_;
  std::function<void(const float*, size_t, uint32_t)> render_;
  std::function<void(const std::string&)> error_;
};

void submit(JNIEnv* env, jobject, jlong handle, jobject buffer, jint count, jint rate, jlong timestamp) {
  const auto* samples = static_cast<const float*>(env->GetDirectBufferAddress(buffer));
  const auto capacity = env->GetDirectBufferCapacity(buffer);
  if (samples == nullptr || count < 0 || rate <= 0 || capacity < static_cast<jlong>(count) * static_cast<jlong>(sizeof(float))) {
    env->ThrowNew(env->FindClass("java/lang/IllegalArgumentException"), "invalid_capture_buffer");
    return;
  }
  try {
    reinterpret_cast<AndroidAudioDevice*>(handle)->submit(samples, static_cast<size_t>(count), static_cast<uint32_t>(rate), timestamp);
  } catch (const std::exception& error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
  } catch (...) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "capture_callback_failed");
  }
}

void reportError(JNIEnv* env, jobject, jlong handle, jstring description) {
  const char* chars = env->GetStringUTFChars(description, nullptr);
  if (chars == nullptr) return;
  try {
    const std::string message(chars);
    env->ReleaseStringUTFChars(description, chars);
    chars = nullptr;
    reinterpret_cast<AndroidAudioDevice*>(handle)->error(message);
  } catch (const std::exception& error) {
    if (chars != nullptr) env->ReleaseStringUTFChars(description, chars);
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
  } catch (...) {
    if (chars != nullptr) env->ReleaseStringUTFChars(description, chars);
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "capture_error_callback_failed");
  }
}
void notificationAction(JNIEnv* env, jobject, jlong handle, jstring action) {
  const char* chars = env->GetStringUTFChars(action, nullptr);
  if (chars == nullptr) return;
  try {
    const std::string message(chars);
    env->ReleaseStringUTFChars(action, chars);
    chars = nullptr;
    reinterpret_cast<AndroidAudioDevice*>(handle)->notificationAction(message);
  } catch (const std::exception& error) {
    if (chars != nullptr) env->ReleaseStringUTFChars(action, chars);
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
  } catch (...) {
    if (chars != nullptr) env->ReleaseStringUTFChars(action, chars);
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "notification_action_callback_failed");
  }
}

jboolean decodeCancelled(JNIEnv* env, jclass, jlong pointer) noexcept {
  try {
    const auto* cancelled = reinterpret_cast<const std::function<bool()>*>(pointer);
    return (*cancelled)() ? JNI_TRUE : JNI_FALSE;
  } catch (const std::exception& error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
  } catch (...) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "encoded_audio_cancellation_failed");
  }
  return JNI_TRUE;
}
} // 익명 이름 공간

// package class loader에 접근할 수 있는 JNI_OnLoad에서 호출한다.
void initializeAndroidAudioDevice(JNIEnv* env) {
  env->GetJavaVM(&javaVm);
  auto local = env->FindClass("com/margelo/nitro/tellus/AndroidAudioDevice");
  checkException(env);
  deviceClass = static_cast<jclass>(env->NewGlobalRef(local));
  env->DeleteLocalRef(local);
  constructor = env->GetMethodID(deviceClass, "<init>", "(J)V");
  requestCapturePermission = env->GetMethodID(deviceClass, "requestCapturePermission", "()V");
  startCapture = env->GetMethodID(deviceClass, "startCapture", "(I)V");
  stopCapture = env->GetMethodID(deviceClass, "stopCapture", "()V");
  pauseCapture = env->GetMethodID(deviceClass, "pauseCapture", "()V");
  setNotification = env->GetMethodID(deviceClass, "setRecordingNotification", "(Ljava/lang/String;Ljava/lang/String;ZZ)V");
  beginPlayback = env->GetMethodID(deviceClass, "beginPlayback", "(I)V");
  writePlayback = env->GetMethodID(deviceClass, "writePlayback", "(Ljava/nio/ByteBuffer;I)I");
  awaitPlayback = env->GetMethodID(deviceClass, "awaitPlayback", "()V");
  cancelPlayback = env->GetMethodID(deviceClass, "cancelPlayback", "()V");
  endPlayback = env->GetMethodID(deviceClass, "endPlayback", "()V");
  closeDevice = env->GetMethodID(deviceClass, "close", "()V");
  readModel = env->GetStaticMethodID(deviceClass, "readEncryptedModel", "(Ljava/lang/String;)[B");
  checkException(env);
  JNINativeMethod natives[] = {
      {const_cast<char*>("nativeSubmit"), const_cast<char*>("(JLjava/nio/ByteBuffer;IIJ)V"), reinterpret_cast<void*>(submit)},
      {const_cast<char*>("nativeError"), const_cast<char*>("(JLjava/lang/String;)V"), reinterpret_cast<void*>(reportError)},
      {const_cast<char*>("nativeNotificationAction"), const_cast<char*>("(JLjava/lang/String;)V"), reinterpret_cast<void*>(notificationAction)},
  };
  if (env->RegisterNatives(deviceClass, natives, 3) != JNI_OK) throw std::runtime_error("android_native_registration_failed");
  local = env->FindClass("com/margelo/nitro/tellus/AudioDecoder");
  checkException(env);
  decoderClass = static_cast<jclass>(env->NewGlobalRef(local));
  env->DeleteLocalRef(local);
  decodeAudio = env->GetStaticMethodID(decoderClass, "decode", "(Ljava/nio/ByteBuffer;J)Lcom/margelo/nitro/tellus/DecodedAudioResult;");
  checkException(env);
  local = env->FindClass("com/margelo/nitro/tellus/DecodedAudioResult");
  checkException(env);
  decodedSamples = env->GetMethodID(local, "getSamples", "()[F");
  decodedRate = env->GetMethodID(local, "getRate", "()I");
  env->DeleteLocalRef(local);
  checkException(env);
  JNINativeMethod decoderNative{const_cast<char*>("nativeDecodeCancelled"), const_cast<char*>("(J)Z"), reinterpret_cast<void*>(decodeCancelled)};
  if (env->RegisterNatives(decoderClass, &decoderNative, 1) != JNI_OK) throw std::runtime_error("android_decoder_registration_failed");
}

namespace margelo::nitro::tellus {
std::unique_ptr<AudioDevice> createAudioDevice(
    std::function<void(const float*, size_t, uint32_t, int64_t)> capture,
    std::function<void(const float*, size_t, uint32_t)> render,
    std::function<void(const std::string&)> error) {
  return std::make_unique<AndroidAudioDevice>(std::move(capture), std::move(render), std::move(error));
}

std::vector<uint8_t> readEncryptedModel(const std::string& path) {
  JavaEnv scope;
  auto name = scope.env->NewStringUTF(path.c_str());
  checkException(scope.env);
  auto bytes = static_cast<jbyteArray>(scope.env->CallStaticObjectMethod(deviceClass, readModel, name));
  scope.env->DeleteLocalRef(name);
  checkException(scope.env);
  const auto size = scope.env->GetArrayLength(bytes);
  std::vector<uint8_t> output(static_cast<size_t>(size));
  scope.env->GetByteArrayRegion(bytes, 0, size, reinterpret_cast<jbyte*>(output.data()));
  scope.env->DeleteLocalRef(bytes);
  checkException(scope.env);
  return output;
}
} // margelo::nitro::tellus 이름 공간
