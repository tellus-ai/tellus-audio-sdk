# Tellus Audio SDK — Mobile

React Native·Expo 개발 앱에서 사용하는 설치 패키지입니다. 실행 래퍼는 이 SDK 저장소의 `src/platforms/mobile/react-native`에, 네이티브 연결 코드와 Nitro 생성 파일은 `platforms/mobile`에 있습니다. 배포 패키지는 네이티브 연결 파일과 TypeScript 산출물을 포함합니다.

```sh
npm install @tellus-ai/audio-sdk-mobile react-native-nitro-modules@0.35.4
```

설치 토큰 `TELLUS_AUDIO_ENGINE_TOKEN`과 HTTPS 다운로드 서비스 `TELLUS_AUDIO_DOWNLOAD_BASE_URL`을 설정하면 postinstall이 iOS·Android 엔진을 설치합니다. 대상 하나만 필요하면 설치 전에 `TELLUS_AUDIO_ENGINE_PLATFORM=ios` 또는 `android`를 지정합니다. 재설치는 `npm run install:binary --prefix node_modules/@tellus-ai/audio-sdk-mobile -- --platform android`를 실행합니다.

```ts
import { AudioEngine } from '@tellus-ai/audio-sdk-mobile';
import { attachEngineAuthorization } from '@tellus-ai/audio-sdk-mobile/authorization';
```

Expo 설정은 다음과 같습니다.

```json
{"expo":{"plugins":[["@tellus-ai/audio-sdk-mobile",{"microphonePermission":"실시간 번역을 위해 마이크를 사용합니다."}]]}}
```

`npx expo run:ios` 또는 `npx expo run:android`로 SDK가 포함된 앱을 빌드하고 `npx expo start --dev-client`로 개발합니다. Swift·Kotlin 코드를 고객 앱에 작성할 필요는 없습니다. Expo Go는 이 모듈을 포함하지 않습니다.

모델은 암호화 `.temc`만 설치하며 서버 실행 승인·모델 키를 적용한 뒤 캡처를 시작합니다. `playback()`·`playbackEncoded()`는 재생 PCM을 AEC 참조로 전달합니다. 기존 Promise 기반 캡처·승인·TTS API를 유지합니다.

같은 대상의 설치를 검사하려면 `npm run check:binary --prefix node_modules/@tellus-ai/audio-sdk-mobile -- --platform android`를 실행합니다. 대상 옵션을 생략하면 iOS·Android 모두 검사합니다.

## 장치 선택

```ts
import { AudioEngine, listAudioDevices } from '@tellus-ai/audio-sdk-mobile';
import type { NativeEngineAssets } from '@tellus-ai/audio-sdk-mobile';

const microphones = await listAudioDevices('microphone');
async function createEngine(micDeviceId: string, assets: NativeEngineAssets) {
  return AudioEngine.init({ micDeviceId }, assets);
}
```

Android는 입력·출력 장치 ID를 조회하고 `micDeviceId`와 `playbackDeviceId`로 지정합니다. preferred device를 설정한 뒤 실제 활성 스트림의 라우팅을 확인하며 요청과 다르면 `route_mismatch`로 실패합니다. Bluetooth 통신 장치 선택은 이 범위에 포함되지 않습니다.

iOS 입력은 현재 AVAudioSession이 노출한 `availableInputs`의 UID입니다. 조회만으로 권한이나 session category를 바꾸지 않아 준비 전 목록이 비어 있을 수 있습니다. 출력은 `iosOutputRoute: 'speaker' | 'system'`으로 내장 스피커 override 또는 override 해제를 요청합니다. `system`은 기존 OS 라우팅을 따르며 수화기 강제를 의미하지 않습니다. 출력 override가 입력도 바꾸면 명시 입력과 실제 route를 비교하여 실패를 전달합니다. iOS의 임의 `playbackDeviceId`와 모바일 시스템 오디오 선택은 `unsupported`입니다.

선택값은 OS 연결 계층에서만 사용하고 Rust 처리 설정에 전달하지 않습니다. SDK 변경 후 앱의 iOS·Android 네이티브 모듈을 다시 빌드해야 합니다. 장치 제거, 잘못된 ID, pause/resume과 재생 중 route 변경은 실제 장치에서 확인하세요.
