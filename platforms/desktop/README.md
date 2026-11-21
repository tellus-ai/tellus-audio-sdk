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

기존 Electron 캡처·장치 조회·권한·승인 API를 유지합니다. Electron 앱의 마이크·시스템 오디오 권한 안내는 앱 번들 설정에 선언합니다. 캡처는 시작 전에 서버 실행 승인을 적용합니다.

엔진을 다시 설치하려면 `npm run install:binary --prefix node_modules/@tellus-ai/audio-sdk-desktop`를 실행하고, 로딩 검증은 같은 prefix의 `npm run check:binary`로 실행합니다. 고객 설치에는 엔진 소스 저장소가 필요하지 않습니다.

## 발화 감지

엔진 v0.4.10을 설치하고 앱에 OS 마이크 권한을 허용하세요. 서버 캡처 permit·모델 키·`AudioEngine.init()` 없이 동기 API로 감지합니다.

```ts
import { SpeechDetector } from '@tellus-ai/audio-sdk-desktop';
import type { SpeechDetectionCallback } from '@tellus-ai/audio-sdk-desktop';

const detector = new SpeechDetector();
const onSpeech: SpeechDetectionCallback = (error, event) => {
  if (error) {
    console.error('감지 종료', error.message);
    return;
  }
  if (event) console.log(event.speaking, event.timestampMs);
};

function startDetection(deviceId?: string) {
  try {
    detector.start(onSpeech, deviceId); // 생략하면 기본 마이크
  } catch (error) {
    console.error('감지 시작 실패', error);
  }
}

startDetection();
// 감지를 멈출 때 detector.stop()을 호출합니다.
```

`speaking`과 `timestampMs`만 전달합니다. `timestampMs`는 이번 시작 이후 처리된 마이크 오디오 길이(ms)입니다. 첫 완전한 1.024초 창이 끝날 때, 이후에는 발화 상태가 바뀔 때 이벤트를 받습니다.

승인·설정이 유효한 캡처는 감지를 종료하고 마이크를 넘겨받습니다. 승인이나 설정 검증에 실패하면 감지를 계속합니다. 실행 중 선점은 이벤트 없이 callback에 `speech_detection_preempted_by_capture`를 한 번 전달합니다. 시작 대기 중 선점되거나 캡처가 이미 우선권을 가진 경우 `start()`가 callback 호출 없이 같은 오류를 던집니다.

캡처가 일시정지되어도 우선권을 유지합니다. 캡처 종료 후 `startDetection()`을 다시 호출하세요. `stop()` 이후 도착한 이벤트는 버립니다.

## 엔진 로그

엔진 v0.4.11이 필요합니다. 엔진 로그를 어디에 남길지는 앱이 정합니다. 로그 출력이 실패해도(앱을 띄운 쪽이 stdout·stderr를 닫은 경우 포함) 어떤 API 결과도 바뀌지 않습니다. 운영에서는 `onLog`로 받아 앱 로그에 남기고 콘솔 출력은 끄세요.

```ts
import { initLogging } from '@tellus-ai/audio-sdk-desktop';
import type { EngineLogEntry } from '@tellus-ai/audio-sdk-desktop';

initLogging({
  level: 'audio_capture=info', // EnvFilter 문법. 기본값 'audio_capture=info'
  console: false,              // 기본값 false. true면 프로세스 stdout에도 씁니다
  onLog: (entry: EngineLogEntry) => appLogger.log(entry.level, `[engine] ${entry.target} ${entry.message}`),
});
```

- 호출할 때마다 레벨·콘솔 출력·`onLog` 설정 전체를 바꿉니다. `onLog`를 생략하면 앱으로 전달하지 않습니다.
- `entry`는 `{ level, target, message, timestampMs }`입니다. `message`는 이벤트 메시지 뒤에 나머지 필드를 `key=value`로 붙인 문자열이고 `timestampMs`는 Unix epoch ms입니다.
- `onLog`는 JS 스레드에서 비동기로 한 건씩 호출됩니다. 엔진 스레드는 앱을 기다리지 않습니다. 전달 대기 로그가 1024건을 넘으면 새 로그를 버리고 다음 전달에 `N engine log entries dropped` 경고 항목을 붙입니다.
- `onLog`가 던진 예외는 무시하며 로그 전달은 Node 이벤트 루프를 붙잡지 않습니다.
- 잘못된 레벨은 `logging_level_invalid`를 던지고 기존 설정을 유지합니다.
- `initLogging('audio_capture=debug')`처럼 문자열로 부르면 기존처럼 stdout 콘솔 출력을 켭니다.

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

### 일시정지 중 녹화 오디오 연결 유지 (`audioPauseMode`)

기본값은 `'abort'`로, 일시정지 때 녹화 오디오 연결을 끊고 재개하려면 새 연결이 필요합니다. `'keepalive'`는 같은 연결을 유지합니다. 엔진 v0.4.6 이상의 native kit가 필요하며, 지원 여부는 `recorder.recordingAudioPauseKeepaliveSupported`로 확인합니다.

```ts
if (recorder.recordingAudioPauseKeepaliveSupported) {
  await recorder.start({ /* ... */ includeAudio: true, audioCapture, audioPauseMode: 'keepalive' });
}
```

`AudioCapture`를 직접 연결할 때는 `capture.createRecordingAudioSource({ pauseMode: 'keepalive' })`를 씁니다. 방식은 소스를 만들 때 정하며 세션 중에는 바꿀 수 없습니다. `audioPauseMode`는 화면 실행 파일로 전달하지 않습니다.

- 닫힌 게이트 중 일시정지를 허용합니다. 엔진은 일시정지 중과 재개 뒤 첫 PCM 전에만 500ms마다 Keepalive를 보냅니다. 녹화 중에는 보내지 않으므로 오디오가 2초 넘게 멈추면 화면 실행 파일이 `recording audio link idle timeout`으로 실패시킵니다.
- 열린 게이트 중 일시정지한 구간은 무음으로 기록합니다.
- `RecordingOutput.pauses`는 정상 결과이며 오류가 아닙니다.
- 재개 뒤 `resumeWhenReady()`가 끝나면 게이트를 엽니다.
- 일시정지 중이나 재개 직후 첫 PCM 전에 stop해도 정상 종료합니다.
- 네이티브 입력 전용입니다. 브라우저 마이크나 마이크 대체 경로는 `recording_audio_requires_native_input`으로 거부합니다.
- 지원하지 않는 실행 파일에 `'keepalive'`를 요청하면 `start`가 invalid로 거절합니다 (`audioPauseMode must be abort or keepalive`, `audioPauseMode keepalive requires recording audio pause keepalive support`).

새 실패 코드: `recording_audio_invalid_pause_mode`(`pauseMode`가 `'abort'`·`'keepalive'`가 아님), `recording_audio_generation_unavailable`(재개 때 믹서 녹화 세대를 새로 받지 못함). 기존 코드는 바뀌지 않았습니다. 엔진 v0.4.6 전의 구버전 native에서는 `'keepalive'`가 무시되거나 거부될 수 있습니다.

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

general 모드는 `generalDenoiseAttenuationLimitDb`를 지정하지 않으면 소음 저감 상한이 없는 무제한입니다. 유한한 0..60 dB를 주면 general 모드에서 입력을 10^(-db/20) 비율로 되섞어 저감을 제한하고(close_talk에는 영향 없음), `capture.setGeneralDenoiseAttenuationLimitDb(9)`로 런타임에 바꾸며 `null`은 무제한으로 되돌립니다(`undefined`는 거부됩니다). `getStatus().generalDenoiseAttenuationLimitDb`는 선택 필드입니다. 범위를 벗어난 값은 `invalid_general_denoise_attenuation_limit_db`, 구버전 엔진은 `general_denoise_attenuation_limit_unsupported`입니다. 엔진 v0.4.8 이상이 필요합니다.

## close_talk 튜닝과 학습 레벨

```ts
const engine = await AudioEngine.init({
  denoiseMode: 'close_talk',
  closeTalkHoldMs: 250,            // 열림 근거가 끊긴 뒤 더 여는 시간, 기본 250
  closeTalkKeepGapDb: 4,           // 열린 게이트 유지 기준 = 열림 임계값 - 이 값, 기본 4
  closeTalkLevelMarginDb: 2,       // 학습 레벨 - 이 값 이상이면 열림 근거, 기본 2
  closeTalkLevelMinDbfs: -20,      // 학습 레벨이 이 값 이상일 때만 크기 보조 사용, 기본 -20 (-100..=0 dBFS)
  closeTalkLearnedLevelDbfs: null, // 앞 capture에서 받은 학습 레벨, 기본 null
});
const capture = engine.createCapture();
capture.setCloseTalkHoldMs(400);
capture.setCloseTalkLearnedLevelDbfs(null); // 학습 레벨을 직접 지울 때
```

`closeTalkHoldMs`(유한한 0..2000 ms, 엔진 기본 250)는 열림 근거가 끊긴 뒤 게이트를 더 열어 두는 시간입니다. 늘리면 말끝이 덜 잘리지만 말 뒤의 소음도 더 남습니다. 닫힌 게이트는 값을 늘려도 새 근거 없이 다시 열리지 않습니다. `closeTalkKeepGapDb`(유한한 0..20 dB, 엔진 기본 4)는 열린 게이트를 유지하는 기준이 열림 임계값보다 낮은 폭이고, `closeTalkLevelMarginDb`(유한한 0..20 dB, 엔진 기본 2)는 학습한 내 말소리 레벨에서 이만큼 낮은 소리까지 열림 근거로 인정하는 폭입니다. 세 setter는 동기이고 다음 10 ms hop부터 적용되며 보관 중인 오디오와 학습 레벨은 유지합니다. SDK는 엔진 기본값을 주입하지 않습니다.

학습 레벨은 capture 객체에 속합니다. pause/resume, stop/start, 음소거, hold, 마이크 재시작을 지나도 남고, general·denoise 꺼짐 중에 넣은 값은 저장해 두었다가 다음 close_talk 게이트가 이어 씁니다. `setCloseTalkLearnedLevelDbfs(dbfs)`는 학습 기록을 비우고 학습 레벨을 `dbfs`(유한한 -100..0 dBFS)로 두며, `null`이면 학습 레벨도 지웁니다. 이것과 새 capture 외에는, 앞서 연 마이크와 장치 id가 다른 마이크가 열릴 때(`micDeviceId` 변경이나 OS 기본 입력 변경) 엔진이 학습을 스스로 지웁니다. 다른 마이크에서 배운 레벨은 맞지 않기 때문입니다. 새 capture에서 학습을 이어 가려면 앞 capture의 `getStatus().closeTalkLearnedLevelDbfs`를 `closeTalkLearnedLevelDbfs` 설정으로 넘깁니다(기록은 넘어가지 않고 주입값으로 시작합니다).

`closeTalkLevelMinDbfs`는 동기 setter `setCloseTalkLevelMinDbfs(dbfs)`로도 바꿉니다. `closeTalkLevelMinDbfs`(유한한 -100..0 dBFS, 기본 -20)는 크기 보조(학습 레벨 - 여유 이상이면 열림)를 쓰는 하한으로, 학습한 레벨이 이 값 이상일 때만 크기 보조가 동작합니다. 15-30 cm에서 쓰면 학습 레벨이 -20보다 낮아 크기 보조가 꺼지므로 -32처럼 낮추면 더 작은 학습 음성에서도 동작합니다. 대신 멀거나 작은 목소리, 12 dB 감쇠 한도를 통과한 큰 소음이 게이트를 열 수 있습니다. 엔진 v0.4.9+가 필요하며 구형 엔진에서는 기본값(-20)이 아닌 값을 설정하면 unsupported 오류가 납니다.

`getStatus()`는 `closeTalkHoldMs`·`closeTalkKeepGapDb`·`closeTalkLevelMarginDb`·`closeTalkLevelMinDbfs`(저장값), `closeTalkLearnedLevelDbfs`(게이트가 쓰는 학습 레벨, 게이트가 없으면 저장된 주입값, 없으면 `null`, stop 뒤에도 마지막 값), `closeTalkLevelLearned`(자체 학습 값일 때만 `true`)를 보고합니다. 출력 청크의 `closeTalkGate`는 그 청크의 마이크 오디오를 close_talk 게이트가 처리했을 때 `{ open, openRatio, lsnrDb, levelDbfs, learnedLevelDbfs }`이고 그 밖(general·denoise 꺼짐·음소거·hold·스피커 전용)에는 `null`입니다. 값은 청크 오디오를 낸 10 ms hop의 판정이라 게이트 보류(300 ms)가 반영되어 있습니다. 모든 상태 필드와 `closeTalkGate`는 선택 필드이고 지원하지 않는 엔진에서는 없습니다(`undefined`).

범위를 벗어나거나 유한하지 않은 값은 native가 던지는 `invalid_close_talk_hold_ms: expected a finite value within 0..=2000`, `invalid_close_talk_keep_gap_db: ...0..=20`, `invalid_close_talk_level_margin_db: ...0..=20`, `invalid_close_talk_learned_level_dbfs: expected a finite value within -100..=0 or null` 오류를 그대로 전달합니다. 구형 kit에서는 setter마다 `close_talk_hold_unsupported: install a native engine with close-talk hold support`, `close_talk_keep_gap_unsupported: install a native engine with close-talk keep gap support`, `close_talk_level_margin_unsupported: install a native engine with close-talk level margin support`, `close_talk_learned_level_unsupported: install a native engine with close-talk learned level support`를 던집니다. 설정을 명시하면 생성자에서, setter는 호출 시점에 던집니다. `closeTalkLearnedLevelDbfs: null`은 엔진 기본값이라 구형 kit에서도 던지지 않습니다.

## 입력 hold

앱의 업링크를 끄는 동안(예: TTS 재생) 마이크 입력이 적응 상태를 오염시키지 않도록 입력을 보류합니다.

```ts
// 업링크를 끌 때
capture.holdInput();
// 업링크를 다시 켤 때
capture.releaseInput();
```

두 메서드는 `void`를 반환하며 동기로 실행됩니다. 데스크톱 캡처에는 `reset()`이 없으므로 release 뒤에 따로 호출할 것은 없습니다.

- 멱등입니다. 이미 hold 중인 `holdInput()`과 hold 중이 아닌 `releaseInput()`은 아무것도 하지 않고 성공합니다.
- 시작 전에 호출해도 되고, 상태는 `pause()`/`resume()`, `stop()`/`start()` 뒤에도 유지됩니다.
- hold 동안 엔진은 소음 추정치, close_talk 학습 레벨, AGC 같은 적응 상태를 얼려 두고 출력 청크를 내지 않으며 VAD도 돌지 않습니다. 그래서 TTS 소리가 학습에 섞이지 않습니다.
- `releaseInput()`은 엔진 안에 보류된 오디오(denoise 모델이 가진 오디오 이력 포함)를 버리고 VAD 게이트를 이벤트 없이 닫힌 상태로 되돌립니다. `speech_gate_opened`는 release 뒤 다음 발화에서 나옵니다. 실제로 hold가 있었던 뒤라면 다음 청크의 `discontinuity`가 reason `input_held`입니다(hold 중이 아닐 때의 release는 아무것도 하지 않습니다).
- release는 적응 상태(DFN3 소음 추정치·close_talk 학습값·AGC)를 hold 직전 값 그대로 이어 갑니다. 캡처를 새로 만들면 처리 이력이 모두 사라지므로 같은 효과가 아닙니다.
- `getStatus().inputHeld`는 선택 필드이며, 입력 hold를 지원하지 않는 엔진에서는 없습니다(`undefined`).
- release 뒤에는 hold 이전·도중의 마이크 소리가 출력되지 않습니다. 단 release 때 AEC가 실제로 처리 중이면(스피커 캡처가 켜져 있고 출력이 귀 착용형이 아닐 때, `aecActive`가 `true`) release 뒤 AEC 출력 앞 25 ms가 무음이 되고 그 뒤 hold 중 소리의 잔향이 1e-3 peak(약 −60 dBFS) 아래로 감쇠하며 남을 수 있습니다(250 ms 안에 정확히 0). AEC가 처리 중이 아니면 경계는 정확히 0입니다.
- 실시간 전달은 믹서 청크 단위로 멈춥니다. release 뒤 첫 청크에는 release 직전의 시스템 오디오가 들어 있을 수 있습니다.
- hold 중 마이크는 녹음 경로에서도 무음이며, `enableRawAudio`의 `rawAudio.mic`도 음소거(`setMicMuted()`)와 같게 무음입니다(처리된 마이크와 같은 장치 청크 경계). 녹음 경로(화면 녹화 믹스 오디오·녹음 버퍼)는 청크 간격과 시스템 오디오(스피커 소리)를 그대로 유지합니다.
- hold 중에는 VAD가 돌지 않으므로 `vadGateState`·`vadIsSpeech`는 hold 직전 값을 유지합니다. hold 시점에 버려진 청크는 `deliveryDroppedChunks`·`deliveryDroppedSamples`에 집계됩니다.
- 녹음 버퍼를 붙여 둔 경우 release 뒤 첫 실시간 패킷에 작은 잔여(최대 약 −43 dBFS)가 실릴 수 있고, 믹서 청크 약 2개보다 짧은 hold는 녹음용 인코더를 다시 만들어 녹음 인코더가 재시작됩니다(엔진 `docs/desktop-api.md` 참고).
- 이 API는 엔진 v0.4.6 이상이 필요하며, 구형 kit에서는 `input_hold_unsupported: install a native engine with input hold support` 오류를 던집니다.

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
