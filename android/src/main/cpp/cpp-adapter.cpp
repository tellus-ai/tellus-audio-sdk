#include "TellusAudioSdkOnLoad.hpp"
#include <fbjni/fbjni.h>
#include <jni.h>

void initializeAndroidAudioDevice(JNIEnv* env);

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, []() {
    initializeAndroidAudioDevice(facebook::jni::Environment::current());
    margelo::nitro::tellus::registerAllNatives();
  });
}
