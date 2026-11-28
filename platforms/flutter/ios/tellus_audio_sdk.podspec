Pod::Spec.new do |s|
  s.name = 'tellus_audio_sdk'
  s.version = File.read(File.join(__dir__, '..', 'pubspec.yaml'))[/^version:\s*(\S+)/, 1]
  s.summary = 'Tellus Audio SDK for Flutter'
  s.homepage = 'https://github.com/tellus-ai/tellus-audio-sdk'
  s.license = 'MIT'
  s.authors = 'Tellus'
  s.source = { :path => '.' }
  # The engine kit is built for iOS 15.1.
  s.platform = :ios, '15.1'
  s.dependency 'Flutter'
  # Classes/native is a copy made by `npm run build` (scripts/assemble-platforms.js): the native/ folder of this
  # plugin plus the capture session and iOS audio device of platforms/mobile. CocoaPods reads no file outside this folder.
  s.source_files = 'Classes/**/*.{h,hpp,cpp,mm}'
  # The other headers are C++ and must stay out of the framework's umbrella header.
  s.public_header_files = 'Classes/TellusAudioSdkPlugin.h'
  # A static framework is linked into the app binary. Dart finds the C functions there with DynamicLibrary.process(),
  # and the resource bundle below lands in the app's main bundle, where IOSAudioDevice.mm looks for it.
  s.static_framework = true
  s.frameworks = 'AVFoundation', 'AudioToolbox', 'UIKit', 'Foundation', 'CoreFoundation'
  # The engine archive ships ONNX Runtime 1.24.3 as a static onnxruntime.xcframework; link it with the system
  # libraries it needs. Apps must not add another pod that brings a framework named onnxruntime.
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
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/vendor/ios/include" "$(PODS_TARGET_SRCROOT)/Classes/native/shim"',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    # The engine has no x86_64 simulator slice.
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'x86_64'
  }
  s.user_target_xcconfig = {
    # The app must leave out x86_64 as well, or `flutter build ios --simulator` builds it for both architectures and
    # Xcode no longer builds this pod for it ("Module 'tellus_audio_sdk' not found"). EXCLUDED_ARCHS cannot say so
    # here: Flutter's Generated.xcconfig, which the app reads after the CocoaPods settings, sets it again.
    'ARCHS[sdk=iphonesimulator*]' => 'arm64',
    # Xcode's default strip style for an archive, "All Symbols", removes the names of the C functions from the app
    # binary, and Dart could no longer find them. "Non-Global Symbols" keeps exported names.
    # https://docs.flutter.dev/platform-integration/ios/c-interop#ios-stripping-symbols
    'STRIP_STYLE' => 'non-global'
  }
end
