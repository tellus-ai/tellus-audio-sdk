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

`speakerEnabled`와 `systemAudioDeviceId`는 시스템 소리 녹음 대상입니다. SDK 재생 출력 선택은 Desktop에서 지원하지 않습니다. Windows는 CPAL 출력 ID, macOS는 14.2+ CoreAudio Tap 출력 UID, Linux는 PulseAudio sink ID를 사용합니다. Linux의 ALSA 기본 경로 alias와 macOS ScreenCaptureKit의 명시 출력 선택은 `unsupported`로 거부합니다. OS 입력 볼륨은 유지하며 게인은 해당 캡처의 처리된 신호에만 적용합니다.

## DSP mixed 오디오를 포함한 MP4

macOS·Windows에서 `ScreenCaptureProcess`를 desktop 진입점 또는 `@tellus-ai/audio-sdk-desktop/screen`으로 가져옵니다. 이 API를 포함한 native kit가 필요하며, 구형 실행 파일이나 오디오 기능이 없는 엔진은 요청을 명시적으로 거부합니다.

```ts
import { ScreenCaptureProcess } from '@tellus-ai/audio-sdk-desktop';

const launched = await ScreenCaptureProcess.launch({ root: recordingsDirectory });
if (!launched.ok) throw new Error(launched.error.detail);
const recorder = launched.value;
const started = await recorder.start({
  captureId: conversationId,
  source: { type: 'display_at', point: { x: 100, y: 100 } },
  output: { type: 'file', label: 'meeting' },
  captureCursor: true,
  includeAudio: true,
  audioCapture: existingRunningAudioCapture,
});
if (!started.ok) throw new Error(started.error.detail);
const opened = await recorder.openGate();
if (!opened.ok) throw new Error(opened.error.detail);
// closeGate/openGate로 일시정지/재개한다.
const stopped = await recorder.stop();
if (!stopped.ok) throw new Error(stopped.error.detail);
console.log(stopped.value.file, stopped.value.audio);
await recorder.shutdown();
```

`includeAudio` 기본값은 false입니다. true이면 기존 캡처의 활성 마이크·시스템 오디오를 소스별 DSP 처리 후 녹화 시각에 맞춰 혼합하고 AAC-LC/48kHz/mono/128kbps 한 트랙으로 저장합니다. raw PCM을 대신 저장하지 않습니다. 기본16kHz mix는 녹화 작업자에서48kHz로 변환하며 이미 제거된 주파수 대역을 복원하지 않습니다. 게인·음소거·잡음 제거는 기존 캡처 설정을 따릅니다.

화면 프로세스가 오디오 장치를 다시 열지 않으며, MP4 종료는 해당 녹화 연결만 해제합니다. 기존 AudioCapture는 호출자가 계속 소유합니다. 하나의 AudioCapture에는 녹화 연결 하나만 허용합니다. 장치를 막 시작했다면 실제 PCM 콜백 수신을 확인한 뒤 gate를 여세요. 입력 준비 전 공백은 `audio.gaps`로 보고됩니다. `audio.paddingSamples`는 마지막 영상 표시 구간을 맞추기 위한 끝 무음입니다. 분수 샘플 경계의 반올림도 gaps에 포함할 수 있어 모든 gaps를 장치 손실로 해석하지 않습니다.

웹·모바일의 소리 포함 MP4는 이번 desktop API의 지원 범위에 포함되지 않습니다.

Windows 시험용 엔진·SDK checkout과 로컬 native kit 연결, 장치·재시작·복합 부하·실제 player 검증은 [Windows mixed MP4 인수인계](https://github.com/tellus-ai/Tellus-audio-engine/blob/feat/mp4-mixed-audio-handoff/docs/windows-mp4-mixed-audio-handoff.md)를 따릅니다. 이 소스 PR은 기존 release manifest를 갱신하지 않으므로, 새 SDK 소스만 설치하고 기존0.4.3 native archive로 새 기능을 검증했다고 판정하지 않습니다.

## 디지털 게인

```ts
const engine = await AudioEngine.init({
  micEnabled: true, speakerEnabled: true,
  micGainDb: -3, speakerGainDb: -6,
  autoGainControl: { enabled: false }, // 자동 보정은 명시적으로 켤 때만 사용
});
const capture = engine.createCapture();
capture.setMicGainDb(0);
capture.setSpeakerGainDb(-3);
```

게인 기본값은 0 dB, 범위는 -60..+12 dB입니다. `speakerGainDb`는 캡처한 시스템 오디오를 조절하며 재생 볼륨을 바꾸지 않습니다. `rawAudio.mic`·`rawAudio.speaker`는 게인 적용 전 원본입니다. 시작·재개 시 마이크 입력을 100%로 올리던 동작은 제거되었고 OS 수준을 그대로 둡니다. 자동 보정은 `autoGainControl: { enabled: true }`로 선택합니다. 한계값·이전 API 호환·배포 요건은 [공통 안내](../../README.md#디지털-게인과-자동-보정)를 참고하세요. 구형 엔진에서 명시 설정과 setter는 `audio_gain_unsupported`입니다.

신규 native API를 포함한 엔진 빌드가 필요합니다. 현재 고정된 release artifact의 갱신 정책은 [저장소 README](../../README.md#유지보수-빌드)를 확인하세요. 기존 `listMicDevices()`와 `listSpeakerDevices()`의 이름 목록 계약은 유지합니다.

비동기 캡처 오류는 기존 `onError(error, captureError)` 계약을 유지하며 장치 상태를 `captureError.deviceStatus`로 제공합니다. 캡처 시작이 throw한 장치 실패는 오류의 `deviceStatus`, 이후 상태는 `capture.getStatus().deviceStatus`에서 읽습니다.

## close_talk 임계값과 소음 저감 상한

```ts
const engine = await AudioEngine.init({
  denoiseMode: 'close_talk',
  closeTalkThresholdDb: 30,        // 게이트 열림 임계값, 기본 30
  denoiseAttenuationLimitDb: 12,   // 소음 저감 상한, 기본 12
});
const capture = engine.createCapture();
capture.setCloseTalkThresholdDb(24);
capture.setDenoiseAttenuationLimitDb(9);
```

`closeTalkThresholdDb`는 close_talk 게이트가 열리는 임계값(유한한 0..60 dB, 엔진 기본 30)입니다. 낮추면 작은 소리도 통과해 멀리 있는 말소리가 더 들어오고, 높이면 입에 가까운 큰 소리만 통과해 먼 소리와 소음은 줄지만 작은 목소리가 잘릴 수 있습니다. `denoiseAttenuationLimitDb`는 close_talk의 소음 저감 상한을 양수 dB 크기로 지정합니다(유한한 0..60 dB, 엔진 기본 12). 엔진이 입력을 10^(-dB/20)만큼 되섞어 저감폭을 제한합니다. 상한을 키우면 소음은 더 줄지만 작은 목소리도 함께 지워질 수 있다. 일반(general) 모드는 상한이 없습니다. 두 setter는 다음 10 ms hop부터 적용되며 보관 중인 오디오와 학습된 레벨은 유지합니다. SDK는 엔진 기본값을 주입하지 않습니다.

`getStatus()`의 `closeTalkThresholdDb`·`denoiseAttenuationLimitDb`는 선택 필드이며, 지원하지 않는 엔진에서는 없습니다(`undefined`). 범위를 벗어나거나 유한하지 않은 값은 native가 던지는 `invalid_close_talk_threshold_db...`·`invalid_denoise_attenuation_limit_db...` 오류를 그대로 전달합니다. 이 API는 엔진 v0.4.5 이상이 필요하며, 구형 kit에서는 `close_talk_threshold_unsupported: install a native engine with close-talk threshold support`·`denoise_attenuation_limit_unsupported: install a native engine with denoise attenuation limit support` 오류를 던집니다. 설정을 명시하면 생성자에서, setter는 호출 시점에 던집니다.

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
- 엔진 `0.3.6`부터 지원합니다. 그보다 오래된 엔진에서는 `source_mute_unsupported` 오류를 던집니다.

## 회의 앱 음소거 따라가기

회의실에서 Zoom이나 Google Meet 마이크를 끄고 회의실끼리 이야기하면, 녹음에도 마이크가 빠져야 합니다. `setMeetingSync()`를 켜면 엔진이 회의 앱의 음소거 상태를 읽어 마이크에 그대로 적용합니다. 회의 앱이 기준이므로, 회의 앱이 마이크를 정하는 동안 `setMicMuted()`는 `mic_sync_active`로 거부됩니다.

```ts
capture.onMeetingSync((error, event) => {
  if (error) return;
  // event.state: 'off' | 'idle' | 'needs_link' | 'synced' | 'lost'
  showMicSyncBadge(event.state, event.reason, event.micMuted);
});
capture.setMeetingSync({ mode: 'auto' });                         // Zoom을, Zoom이 회의 중이 아니면 Google Meet을 찾아 따름
// capture.setMeetingSync({ mode: 'manual', targetAppId: 'zoom' }); // 사용자가 고른 앱('zoom' | 'google_meet')을 따름
// capture.setMeetingSync({ mode: 'off' });                         // 오프라인 회의, 마이크 수동
capture.start(onChunk);

const candidates = await getMeetingCandidates(); // 마이크를 쓰는 앱. 동기화할 수 있으면 appId: 'zoom' | 'google_meet'(브라우저)
```

| 상태 | 뜻 | 마이크 |
| --- | --- | --- |
| `off` | 동기화를 끔 | 수동 |
| `idle` | 회의 중인 회의 앱이 없음 | 수동 |
| `needs_link` | 회의 중으로 보이지만 상태를 못 읽음. `reason`: `accessibility_permission`, `control_not_found`, `unknown_label`, `app_not_running`, `read_failed`, `meeting_hidden`(Meet 통화 화면이 보이지 않음: 뒤쪽 탭, 최소화된 창 등) | 수동 |
| `synced` | 회의 앱 상태를 따르는 중 | 회의 앱이 정함 |
| `lost` | 동기화 중 상태를 놓침. `unknownGraceMs`(기본 5000) 동안 마지막 값 유지. `reason`은 `needs_link`와 같은 값 | 회의 앱이 정함 |

- macOS·Windows의 Zoom 데스크톱 앱과 브라우저 안의 Google Meet을 지원합니다. Meet은 macOS의 Chrome·Arc·Dia·Edge·Whale·Brave·Safari와 Windows의 Chrome·Edge·Whale·Brave에서 읽습니다.
- macOS는 앱에 손쉬운 사용 권한이 필요합니다(회의 앱이 아니라 엔진을 실행하는 앱의 권한). Windows는 권한이 필요 없습니다. 그 밖의 플랫폼은 `mode: 'off'`만 받고, 다른 모드는 `meeting_sync_unsupported_platform`으로 거부합니다.
- 손쉬운 사용 권한은 아래 API로 확인하고 요청합니다. 요청은 사용자 동작에서만 부르고, 결과와 상관없이 확인 API로 다시 확인합니다.

```ts
const accessibility = checkAccessibilityPermissionInfo(); // { granted, required, status, message }
if (accessibility.required && !accessibility.granted) {
  requestAccessibilityPermission(); // 권한 창(앱을 목록에 올림)과 손쉬운 사용 설정창을 엶
}
```

  `status`는 `granted`·`denied`·`not-required`입니다. macOS는 허용 전과 거부를 구분할 수 없어 둘 다 `denied`입니다. Windows·Linux는 이 권한이 없어 `required: false`, `status: 'not-required'`입니다. 이미 허용돼 있으면 요청은 아무것도 열지 않고 `{ opened: false }`를 돌려줍니다.
- 녹음 중에만 판단합니다(일시정지 포함). 마이크를 열기 전에 첫 판단을 마치므로, 회의 앱이 음소거면 첫 청크부터 마이크가 빠집니다.
- 음소거 항목 문구는 회의 앱 UI 언어를 따릅니다(Zoom 메뉴·툴바 항목, Meet 마이크 버튼 설명). 엔진에는 영어·한국어 문구가 들어 있고, 다른 언어는 `labels`로 더합니다. 더한 문구는 모든 회의 앱에 적용됩니다. 읽은 문구는 `event.controlTitle`로 확인합니다.
- `onMeetingSync()`는 한 번 등록하면 같은 캡처 인스턴스의 `stop()`/`start()` 뒤에도 유지됩니다. 설정(`setMeetingSync`)도 같은 인스턴스 안에서 유지되지만, 새 캡처 인스턴스에는 다시 적용해야 합니다.
- 엔진 `0.4.0`부터 지원합니다. 그보다 오래된 엔진에서는 `meeting_sync_unsupported` 오류를 던집니다. 손쉬운 사용 확인은 `accessibility_permission_unsupported` 오류를 던지고, 요청은 `{ opened: false, error }`를 돌려줍니다.
