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
  s.frameworks = 'AVFoundation', 'AudioToolbox', 'UIKit'
  s.vendored_frameworks = 'vendor/ios/TellusAudioEngine.xcframework'
  s.dependency 'onnxruntime-c', '1.24.3'
  s.resource_bundles = { 'TellusAudioSdkModels' => ['vendor/ios/models/*.temc'] }
  s.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/vendor/ios/include"',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20'
  }
  load 'nitrogen/generated/ios/TellusAudioSdk+autolinking.rb'
  add_nitrogen_files(s)
  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  install_modules_dependencies(s)
end
