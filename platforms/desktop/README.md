# Tellus Audio SDK — Desktop

Electron용 설치 패키지입니다. 실행 래퍼 원본은 이 SDK 저장소의 `src/platforms/desktop/electron`에 있습니다.

```sh
npm install @tellus-ai/audio-sdk-desktop
```

고객 설치 토큰 `TELLUS_AUDIO_ENGINE_TOKEN`과 HTTPS 다운로드 서비스 `TELLUS_AUDIO_DOWNLOAD_BASE_URL`을 설정하면 postinstall이 현재 OS·CPU용 엔진을 설치합니다. macOS는 universal binary, Windows는 x64 MSVC, Linux는 x64 GNU를 지원합니다. 모델과 ORT native runtime은 엔진 archive에 포함되며 `vendor/<platform>`에 설치됩니다.

```ts
import { AudioEngine } from '@tellus-ai/audio-sdk-desktop';
import { attachEngineAuthorization } from '@tellus-ai/audio-sdk-desktop/authorization';
```

기존 Electron 캡처·장치 조회·권한·승인 API를 유지합니다. Electron 앱의 마이크·시스템 오디오 권한 안내는 앱 번들 설정에 선언합니다. 모델은 암호화 `.temc`를 사용하며 캡처 시작 전에 서버 실행 승인과 모델 키를 적용합니다.

엔진을 다시 설치하려면 `npm run install:binary --prefix node_modules/@tellus-ai/audio-sdk-desktop`를 실행하고, 로딩 검증은 같은 prefix의 `npm run check:binary`로 실행합니다. 고객 설치에는 엔진 소스 저장소가 필요하지 않습니다.

## 장치 선택

```ts
import { AudioEngine, listAudioDevices } from '@tellus-ai/audio-sdk-desktop';

const microphones = await listAudioDevices('microphone');
const systemAudio = await listAudioDevices('system_audio');
// 앱 선택 UI가 목록의 ID를 넘긴다.
async function createEngine(micDeviceId: string, systemAudioDeviceId: string) {
  return AudioEngine.init({ micEnabled: true, speakerEnabled: true, micDeviceId, systemAudioDeviceId });
}
```

`speakerEnabled`와 `systemAudioDeviceId`는 시스템 소리 녹음 대상입니다. SDK 재생 출력 선택은 Desktop에서 지원하지 않습니다. Windows는 CPAL 출력 ID, macOS는 14.2+ CoreAudio Tap 출력 UID, Linux는 PulseAudio sink ID를 사용합니다. Linux의 ALSA 기본 경로 alias와 macOS ScreenCaptureKit의 명시 출력 선택은 `unsupported`로 거부합니다. 마이크 레벨 조정은 선택한 장치에만 적용합니다.

신규 native API를 포함한 엔진 빌드가 필요합니다. 현재 고정된 release artifact의 갱신 정책은 [저장소 README](../../README.md#유지보수-빌드)를 확인하세요. 기존 `listMicDevices()`와 `listSpeakerDevices()`의 이름 목록 계약은 유지합니다.

비동기 캡처 오류는 기존 `onError(error, captureError)` 계약을 유지하며 장치 상태를 `captureError.deviceStatus`로 제공합니다. 캡처 시작이 throw한 장치 실패는 오류의 `deviceStatus`, 이후 상태는 `capture.getStatus().deviceStatus`에서 읽습니다.

## 마이크·스피커 따로 음소거

`pause()`는 마이크와 스피커를 모두 멈춥니다. 한쪽만 녹음에서 빼려면 해당 소스를 음소거합니다.

```ts
capture.setMicMuted(true);      // 다음 청크부터 스피커 소리만 전달
capture.setMicMuted(false);     // 마이크 소리를 다시 섞음
capture.setSpeakerMuted(true);  // 다음 청크부터 마이크 소리만 전달
```

- 장치와 시스템 오디오 캡처는 열린 채로 둡니다. 그래서 음소거 중에도 OS의 마이크 사용 표시는 켜져 있습니다.
- 음소거 중 들어온 소리는 버립니다. 해제해도 그 소리가 뒤늦게 나가지 않습니다.
- 청크는 같은 간격으로 계속 나옵니다. 음소거한 소스는 `data.mixed`, 소스별 payload, `rawAudio` 프레임에서 무음이 되며, 원본 프레임은 길이와 `sample` 위치를 유지합니다.
- AEC는 믹서보다 앞단에서 처리되므로, 스피커를 음소거해도 마이크의 에코 제거는 계속 동작합니다.
- 시작 전에 호출해도 되고, 같은 캡처 인스턴스의 `pause()`/`resume()`, `stop()`/`start()` 뒤에도 유지됩니다. 새 캡처 인스턴스는 음소거가 풀린 상태로 시작합니다.
- 이 기능을 지원하지 않는 엔진에서는 `source_mute_unsupported` 오류를 던집니다. 현재 고정된 엔진 `0.3.5`는 지원하지 않습니다. 갱신 정책은 [저장소 README](../../README.md#유지보수-빌드)를 확인하세요.
