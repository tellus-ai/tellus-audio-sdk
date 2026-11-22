require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
Pod::Spec.new do |s|
  s.name = 'TellusAudioSdk'
  s.version = package['version']
  s.summary = '승인된 Rust 세션을 사용하는 Tellus 네이티브 오디오 SDK'
  s.homepage = 'https://github.com/tellus-ai/tellus-audio-sdk'
  s.license = package['license']
  s.authors = 'Tellus'
  s.platforms = { :ios => min_ios_version_supported }
  s.source = { :git => 'https://github.com/tellus-ai/tellus-audio-sdk.git', :tag => "v#{s.version}" }
  s.source_files = ['ios/**/*.{h,hpp,mm}', 'cpp/**/*.{hpp,cpp}']
  s.exclude_files = ['cpp/tests/**/*']
  s.static_framework = true
  s.frameworks = 'AVFoundation', 'AudioToolbox', 'UIKit', 'Foundation', 'CoreFoundation'
  # The engine archive ships ONNX Runtime 1.24.3 as a static onnxruntime.xcframework; link it with the system
  # libraries it needs. Apps must not add onnxruntime-c or onnxruntime-react-native, which bring a same-name framework.
  s.vendored_frameworks = ['vendor/ios/TellusAudioEngine.xcframework', 'vendor/ios/onnxruntime.xcframework']
  s.weak_frameworks = 'CoreML'
  s.libraries = 'c++'
  s.resource_bundles = { 'TellusAudioSdkModels' => [
    'vendor/ios/models/*.temc',
    'vendor/ios/speech-detection/silero_vad_v6.2.onnx',
    'vendor/ios/licenses/silero-vad.txt',
    'vendor/ios/licenses/onnxruntime.txt',
    'vendor/ios/licenses/onnxruntime-third-party.txt'
  ] }
  s.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/vendor/ios/include"',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20'
  }
  # cpp/DenoiseSettings.cpp, cpp/InputHold.cpp and cpp/LastError.cpp reference these engine functions weakly.
  # Apple's linker still rejects a weak reference that no kit defines, so the app link
  # allows them to stay undefined; dyld then binds them to null and the glue reports unsupported.
  s.user_target_xcconfig = { 'OTHER_LDFLAGS' => '-Wl,-U,_tellus_audio_session_set_close_talk_threshold_db -Wl,-U,_tellus_audio_session_set_denoise_attenuation_limit_db -Wl,-U,_tellus_audio_session_set_close_talk_hold_ms -Wl,-U,_tellus_audio_session_set_close_talk_keep_gap_db -Wl,-U,_tellus_audio_session_set_close_talk_level_margin_db -Wl,-U,_tellus_audio_session_set_close_talk_level_min_dbfs -Wl,-U,_tellus_audio_session_set_close_talk_learned_level_dbfs -Wl,-U,_tellus_audio_session_clear_close_talk_learned_level -Wl,-U,_tellus_audio_session_set_general_denoise_attenuation_limit_db -Wl,-U,_tellus_audio_session_clear_general_denoise_attenuation_limit -Wl,-U,_tellus_audio_session_hold_input -Wl,-U,_tellus_audio_session_release_input -Wl,-U,_tellus_audio_session_copy_last_error' }
  load 'nitrogen/generated/ios/TellusAudioSdk+autolinking.rb'
  add_nitrogen_files(s)
  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  install_modules_dependencies(s)
end
