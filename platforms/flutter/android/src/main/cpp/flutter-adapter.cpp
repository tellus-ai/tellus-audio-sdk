#include <fbjni/fbjni.h>
#include <jni.h>

void initializeAndroidAudioDevice(JNIEnv* env);

// Runs when TellusAudioSdkPlugin calls System.loadLibrary. Opening the library from Dart does not run it.
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, []() {
    initializeAndroidAudioDevice(facebook::jni::Environment::current());
  });
}
