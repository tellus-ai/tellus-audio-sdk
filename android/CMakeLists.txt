cmake_minimum_required(VERSION 3.13)
project(TellusAudioSdk)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
get_filename_component(ENGINE_DIR "${CMAKE_SOURCE_DIR}/../vendor/android" ABSOLUTE)
set(ENGINE_LIBRARY "${ENGINE_DIR}/jniLibs/${ANDROID_ABI}/libtellus_audio_engine.so")
if(NOT EXISTS "${ENGINE_LIBRARY}")
  message(FATAL_ERROR "[tellus-audio-sdk] Missing engine for ${ANDROID_ABI}: ${ENGINE_LIBRARY}. Set reactNativeArchitectures=arm64-v8a,x86_64 and run install:binary with TELLUS_AUDIO_ENGINE_TARGETS=android.")
endif()
add_library(TellusAudioSdk SHARED
  ../cpp/HybridTellusCapture.cpp
  ../cpp/CaptureSession.cpp
  ../cpp/CaptureWorker.cpp
  src/main/cpp/AndroidAudioDevice.cpp
  src/main/cpp/cpp-adapter.cpp
)
add_library(tellus_audio_engine SHARED IMPORTED)
set_target_properties(tellus_audio_engine PROPERTIES IMPORTED_LOCATION "${ENGINE_LIBRARY}" IMPORTED_NO_SONAME TRUE)
target_link_options(TellusAudioSdk PRIVATE "-Wl,-z,max-page-size=16384")
include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/TellusAudioSdk+autolinking.cmake)
target_include_directories(TellusAudioSdk PRIVATE ../cpp "${ENGINE_DIR}/include")
target_link_libraries(TellusAudioSdk tellus_audio_engine android log)
