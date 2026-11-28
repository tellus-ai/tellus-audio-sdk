cmake_minimum_required(VERSION 3.13)
project(tellus_audio_sdk_flutter)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
get_filename_component(ENGINE_DIR "${CMAKE_SOURCE_DIR}/vendor/android" ABSOLUTE)
set(ENGINE_LIBRARY "${ENGINE_DIR}/jniLibs/${ANDROID_ABI}/libtellus_audio_engine.so")
if(NOT EXISTS "${ENGINE_LIBRARY}")
  message(FATAL_ERROR "[tellus-audio-sdk] Missing engine for ${ANDROID_ABI}: ${ENGINE_LIBRARY}. The engine supports arm64-v8a and x86_64. Run install:binary with TELLUS_AUDIO_ENGINE_PLATFORM=android.")
endif()
# The capture session and the Android audio device are the React Native package's sources, compiled unchanged.
add_library(tellus_audio_sdk_flutter SHARED
  ../../mobile/cpp/CaptureSession.cpp
  ../../mobile/cpp/CaptureWorker.cpp
  ../../mobile/cpp/InputHold.cpp
  ../../mobile/cpp/LastError.cpp
  ../../mobile/cpp/MicrophonePriority.cpp
  ../../mobile/android/src/main/cpp/AndroidAudioDevice.cpp
  ../native/tellus_flutter_capture.cpp
  src/main/cpp/flutter-adapter.cpp
)
add_library(tellus_audio_engine SHARED IMPORTED)
set_target_properties(tellus_audio_engine PROPERTIES IMPORTED_LOCATION "${ENGINE_LIBRARY}" IMPORTED_NO_SONAME TRUE)
target_link_options(tellus_audio_sdk_flutter PRIVATE "-Wl,-z,max-page-size=16384")
# ../native/shim holds the stand-ins for the <NitroModules/...> headers that CaptureSession.hpp includes.
target_include_directories(tellus_audio_sdk_flutter PRIVATE ../../mobile/cpp ../native ../native/shim "${ENGINE_DIR}/include")
find_package(fbjni REQUIRED CONFIG)
target_link_libraries(tellus_audio_sdk_flutter tellus_audio_engine fbjni::fbjni android log)
