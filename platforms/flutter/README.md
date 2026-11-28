# Tellus Audio SDK — Flutter

Flutter 앱(iOS·Android)에서 사용하는 플러그인 패키지 `tellus_audio_sdk`입니다. 마이크 입력·소음 제거·인코딩은 Tellus 네이티브 엔진이 수행하고, 앱은 인코딩된 20 ms 청크를 받아 `/v1/audio` WebSocket으로 보냅니다. Dart API는 `lib`에, 엔진 연결 코드는 `native`·`ios`·`android`에 있으며 일부 C++ 소스는 React Native 패키지(`platforms/mobile`)와 함께 씁니다.

## 설치

pub.dev에 배포하지 않습니다. SDK 저장소를 checkout해 빌드한 뒤 `platforms/flutter`를 path 의존성으로 지정합니다.

```sh
npm ci --ignore-scripts
npm run build
```

```yaml
dependencies:
  tellus_audio_sdk:
    path: <SDK checkout>/platforms/flutter
```

빌드는 설치 도구(`dist/installer`), `release-assets.json`, iOS Pod이 컴파일하는 소스(`ios/Classes/native`)를 만듭니다. 빌드하지 않은 checkout은 의존성으로 쓸 수 없습니다.

엔진은 `platforms/flutter`에서 설치합니다. 설치 토큰 `TELLUS_AUDIO_ENGINE_TOKEN`과 HTTPS 다운로드 서비스 `TELLUS_AUDIO_DOWNLOAD_BASE_URL`을 설정하고 다음을 실행합니다.

```sh
node dist/installer/install-binary-cli.js
node dist/installer/check-binary-cli.js
```

iOS 엔진은 `ios/vendor/ios`에, Android 엔진은 `android/vendor/android`에 설치됩니다. CocoaPods와 Gradle이 플러그인의 `ios`·`android` 폴더만 읽기 때문에 React Native 패키지의 `vendor/<대상>`과 위치가 다릅니다. 대상 하나만 필요하면 두 명령에 `--platform ios` 또는 `--platform android`를 붙입니다. npm이 이 패키지를 설치하지 않으므로 postinstall은 없습니다. 앱의 setup 스크립트에서 위 명령을 실행하고, 설치가 끝난 뒤 앱의 네이티브 빌드를 실행하세요.

## 사용

캡처는 암호화 `.temc` 모델을 사용합니다. `attachEngineAuthorization`이 `/v1/audio` WebSocket으로 서버 실행 승인과 모델 키를 받아 적용한 뒤 캡처를 시작합니다. `socket`은 앱의 WebSocket을 `EngineAuthorizationSocket`으로 감싼 객체이고, 소켓과 오디오 전송은 앱이 맡습니다.

```dart
import 'dart:typed_data';

import 'package:tellus_audio_sdk/tellus_audio_sdk.dart';

Future<void> startCapture(
  EngineAuthorizationSocket socket,
  String conversationId,
  Future<String> Function() getAccessToken,
  void Function(Uint8List payload) sendAudio,
) async {
  // 기본값은 16 kHz Opus, close_talk 소음 제거, VAD 켜짐입니다.
  final engine = await AudioEngine.init(const AudioCaptureConfig());
  final capture = engine.createCapture();
  final authorization = attachEngineAuthorization(
    socket,
    capture,
    conversationId: conversationId,
    getAccessToken: getAccessToken,
    onError: (error) => print('승인 상실: ${error.code}'),
  );
  await authorization.ready; // 첫 승인과 모델 키 적용이 끝난 뒤 시작합니다.
  await capture.start((error, chunk) {
    if (error != null) {
      print('캡처 종료: ${error.code} ${error.engineMessage ?? ''}');
      return;
    }
    if (chunk != null) sendAudio(chunk.data);
  });
}
```

`start()`는 필요하면 마이크 권한을 요청합니다. 끝낼 때는 `await capture.stop()`, `authorization.dispose()`, `await capture.dispose()` 순서로 호출합니다. 실행 중 소음 제거는 `capture.setDenoiseEnabled()`로 켜고 끕니다.

## 앱 요구 사항

- iOS: 배포 대상 15.1 이상, `Info.plist`의 `NSMicrophoneUsageDescription`. 시뮬레이터는 arm64만 지원합니다.
- Android: `minSdk` 24 이상, ABI `arm64-v8a`·`x86_64`, `RECORD_AUDIO` 권한.

## ONNX Runtime

ONNX Runtime은 설치한 엔진 kit에 들어 있습니다(iOS `onnxruntime.xcframework`, Android `jniLibs/<ABI>/libonnxruntime.so`). 앱은 ONNX Runtime을 따로 추가하면 안 됩니다. `onnxruntime-c` Pod, `onnxruntime-android` AAR 또는 ONNX Runtime을 싣는 다른 플러그인을 함께 쓰면 ORT가 두 벌이 되어 충돌합니다.

## 첫 버전에 없는 기능

React Native 패키지(`@tellus-ai/audio-sdk-mobile`)에 있고 이 첫 버전에는 없는 기능입니다.

- 디지털 게인과 자동 보정(`micGainDb`·`setMicGainDb()`·`autoGainControl`)
- close_talk 튜닝 setter(`setCloseTalkThresholdDb()`·`setDenoiseAttenuationLimitDb()` 등)
- 입력 hold(`holdInput()`·`releaseInput()`)
- 재생과 AEC 참조 입력(`playback()`·`playbackEncoded()`)
- 장치 선택(`listAudioDevices()`·`micDeviceId`·`playbackDeviceId`·`iosOutputRoute`)
- 녹음 알림(`setRecordingNotification()`)
- 발화 감지(`SpeechDetector`)
