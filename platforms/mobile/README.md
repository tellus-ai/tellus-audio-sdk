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

iOS 캡처는 멈출 때 AVAudioSession을 비활성화하지만 다른 앱에 재생 재개를 알리지 않습니다. 캡처를 시작하며 멈춘 다른 앱의 재생은 사용자가 다시 재생할 때까지 멈춰 있습니다.

선택값은 OS 연결 계층에서만 사용하고 Rust 처리 설정에 전달하지 않습니다. SDK 변경 후 앱의 iOS·Android 네이티브 모듈을 다시 빌드해야 합니다. 장치 제거, 잘못된 ID, pause/resume과 재생 중 route 변경은 실제 장치에서 확인하세요.

## 마이크 게인

```ts
const engine = await AudioEngine.init({
  micGainDb: -3,
  autoGainControl: { enabled: true, maxGainDb: 8 },
});
const capture = engine.createCapture();
await capture.setMicGainDb(0);
```

게인은 세션의 처리된 마이크 신호만 바꾸며 OS 입력 볼륨과 재생 볼륨은 유지합니다. 기본값은 0 dB, 범위는 -60..+12 dB입니다. 자동 보정은 기본 꺼짐이며 명시한 `autoGainControl`은 deprecated `micAgc2Enabled`보다 우선합니다. 0이 아닌 `speakerGainDb`와 모든 `setSpeakerGainDb()` 호출은 시스템 오디오 캡처 미지원으로 `tellus_speaker_gain_unsupported`를 반환합니다. 대응하는 엔진 라이브러리와 SDK 네이티브 모듈을 함께 다시 빌드하세요. [공통 한계값과 검증 안내](../../README.md#디지털-게인과-자동-보정)를 따르고, OS·장치 자체 입력 처리의 실제 적용 여부는 iOS·Android 장치에서 확인해야 합니다. JS 테스트 통과만으로 하드웨어 처리가 없다고 보장하지 않습니다.

## close_talk 임계값과 소음 저감 상한

```ts
const engine = await AudioEngine.init({
  denoiseMode: 'close_talk',
  closeTalkThresholdDb: 30,        // 게이트 열림 임계값, 기본 30
  denoiseAttenuationLimitDb: 12,   // 소음 저감 상한, 기본 12
});
const capture = engine.createCapture();
await capture.setCloseTalkThresholdDb(24);
await capture.setDenoiseAttenuationLimitDb(9);
```

`closeTalkThresholdDb`는 close_talk 게이트가 열리는 임계값(유한한 0..60 dB, 엔진 기본 30)입니다. 낮추면 작은 소리도 통과해 멀리 있는 말소리가 더 들어오고, 높이면 입에 가까운 큰 소리만 통과해 먼 소리와 소음은 줄지만 작은 목소리가 잘릴 수 있습니다. `denoiseAttenuationLimitDb`는 close_talk의 소음 저감 상한을 양수 dB 크기로 지정합니다(유한한 0..60 dB, 엔진 기본 12). 엔진이 입력을 10^(-dB/20)만큼 되섞어 저감폭을 제한합니다. 상한을 키우면 소음은 더 줄지만 작은 목소리도 함께 지워질 수 있다. 일반(general) 모드는 상한이 없습니다. 두 setter는 다음 10 ms hop부터 적용되며 보관 중인 오디오와 학습된 레벨은 유지합니다. 엔진 기본값을 SDK가 주입하지 않으며, 모바일·웹은 configure 뒤에 설정값을 setter로 적용합니다.

`getStatus()`의 `closeTalkThresholdDb`·`denoiseAttenuationLimitDb`는 선택 필드이며, 지원하지 않는 엔진에서는 없습니다(`undefined`). 범위를 벗어나거나 유한하지 않은 값은 `invalid_close_talk_threshold_db`·`invalid_denoise_attenuation_limit_db`. 이 API는 엔진 v0.4.5 이상이 필요하며, 구형 kit에서는 `tellus_close_talk_threshold_unsupported`·`tellus_denoise_attenuation_limit_unsupported`로 Promise를 거부합니다. C++ 글루는 약한 참조로 엔진 심볼을 찾고, podspec의 `-Wl,-U` 플래그로 구형 라이브러리와도 링크됩니다.

general 모드는 `generalDenoiseAttenuationLimitDb`를 지정하지 않으면 소음 저감 상한이 없는 무제한입니다. 유한한 0..60 dB를 주면 general 모드에서 입력을 10^(-db/20) 비율로 되섞어 저감을 제한하고(close_talk에는 영향 없음), `await capture.setGeneralDenoiseAttenuationLimitDb(9)`로 런타임에 바꾸며 `null`은 무제한으로 되돌립니다. `getStatus().generalDenoiseAttenuationLimitDb`는 선택 필드입니다. 범위를 벗어난 값은 `invalid_general_denoise_attenuation_limit_db`, 구버전 kit은 `tellus_general_denoise_attenuation_limit_unsupported`입니다. 엔진 v0.4.8 이상이 필요합니다.

## close_talk 튜닝(유지 시간·유지 폭·레벨 여유·학습 레벨)

```ts
const engine = await AudioEngine.init({
  denoiseMode: 'close_talk',
  closeTalkHoldMs: 250,               // 열린 게이트 유지 시간, 기본 250 (0..=2000 ms)
  closeTalkKeepGapDb: 4,              // 유지 기준 = 열림 임계값 - 폭, 기본 4 (0..=20 dB)
  closeTalkLevelMarginDb: 2,          // 레벨 >= 학습값 - 여유면 근거, 기본 2 (0..=20 dB)
  closeTalkLevelMinDbfs: -20,         // 학습 레벨이 이 값 이상일 때만 크기 보조 사용, 기본 -20 (-100..=0 dBFS)
  closeTalkLearnedLevelDbfs: -42,     // 학습 레벨 주입, -100..=0 또는 null(기본)
});
const capture = engine.createCapture();
await capture.setCloseTalkHoldMs(400);
await capture.setCloseTalkKeepGapDb(6);
await capture.setCloseTalkLevelMarginDb(3);
await capture.setCloseTalkLevelMinDbfs(-32);
await capture.setCloseTalkLearnedLevelDbfs(null); // 학습값 지우기
```

네 setter는 다음 10 ms hop부터 적용되며 보관 중인 오디오를 버리지 않습니다. 기본값은 이전 상수와 같아 setter를 부르지 않으면 출력이 바뀌지 않습니다. 구형 kit은 configure가 새 키를 거부하므로 초기 설정도 임계값처럼 configure 뒤 setter로 적용하고, 함수가 없으면 `tellus_close_talk_hold_unsupported`·`tellus_close_talk_keep_gap_unsupported`·`tellus_close_talk_level_margin_unsupported`·`tellus_close_talk_learned_level_unsupported`로 Promise를 거부합니다. 범위를 벗어난 값은 `invalid_close_talk_hold_ms: expected a finite value within 0..=2000`, `invalid_close_talk_keep_gap_db: expected a finite value within 0..=20`, `invalid_close_talk_level_margin_db: expected a finite value within 0..=20`, `invalid_close_talk_learned_level_dbfs: expected a finite value within -100..=0 or null`입니다. C++ 글루는 `tellus_audio_session_set_close_talk_hold_ms`·`..._keep_gap_db`·`..._level_margin_db`·`..._learned_level_dbfs`·`tellus_audio_session_clear_close_talk_learned_level`(`null`)을 약한 참조로 찾으며, podspec의 `-Wl,-U` 플래그로 구형 라이브러리와도 링크됩니다(Android는 기존 약한 심볼과 같은 방식입니다). 이 API는 엔진 v0.4.8 이상이 필요합니다.

`setCloseTalkLevelMinDbfs(dbfs)`는 Promise를 반환하며, 구형 엔진에서는 `tellus_close_talk_level_min_unsupported`로 거부됩니다. `closeTalkLevelMinDbfs`(유한한 -100..0 dBFS, 기본 -20)는 크기 보조(학습 레벨 - 여유 이상이면 열림)를 쓰는 하한으로, 학습한 레벨이 이 값 이상일 때만 크기 보조가 동작합니다. 15-30 cm에서 쓰면 학습 레벨이 -20보다 낮아 크기 보조가 꺼지므로 -32처럼 낮추면 더 작은 학습 음성에서도 동작합니다. 대신 멀거나 작은 목소리, 12 dB 감쇠 한도를 통과한 큰 소음이 게이트를 열 수 있습니다. 엔진 v0.4.9+가 필요하며 구형 엔진에서는 기본값(-20)이 아닌 값을 설정하면 unsupported 오류가 납니다.

`getStatus()`는 `closeTalkHoldMs`·`closeTalkKeepGapDb`·`closeTalkLevelMarginDb`·`closeTalkLevelMinDbfs`·`closeTalkLearnedLevelDbfs`(`number | null`)·`closeTalkLevelLearned`를 선택 필드로 보고하며 구형 엔진에서는 없습니다. 청크의 `closeTalkGate`는 게이트가 처리한 청크에만 `{ open, openRatio, lsnrDb, levelDbfs, learnedLevelDbfs }`로 채워지고 그 외에는 `null`입니다.

학습 레벨은 denoise 켜기·끄기, stop/start, pause/resume을 지나 세션 동안 유지됩니다. 지우는 방법은 `setCloseTalkLearnedLevelDbfs(null)`과 새 capture 객체뿐이므로, **입력 장치를 바꾸는 앱은 `null`로 학습 레벨을 지워야 합니다**. 새 capture 객체로 이어 가려면 앞 객체의 `getStatus().closeTalkLearnedLevelDbfs`를 새 객체의 `closeTalkLearnedLevelDbfs`로 넘깁니다(기록은 넘어가지 않고 주입값으로 시작합니다). 이 API는 새 엔진 kit이 필요합니다.

## 입력 hold

앱의 업링크를 끄는 동안(예: TTS 재생) 입력을 보류합니다. 업링크를 끌 때 `holdInput()`, 다시 켤 때 `releaseInput()`을 호출하며, 지금까지 이 시점에 호출하던 `reset()`을 대체합니다.

```ts
await capture.holdInput();     // 업링크 끔
await capture.releaseInput();  // 업링크 켬
```

두 메서드는 `Promise<void>`를 반환합니다.

- 멱등입니다. 이미 hold 중인 `holdInput()`과 hold 중이 아닌 `releaseInput()`은 아무것도 하지 않고 성공합니다.
- 시작 전에 호출해도 되고, 상태는 `pause()`/`resume()`, `stop()`/`start()` 뒤에도 유지됩니다.
- hold 동안 엔진은 소음 추정치, close_talk 학습 레벨, AGC 같은 적응 상태를 얼려 두고 출력 청크를 내지 않으며 VAD도 돌지 않습니다. 그래서 TTS 소리가 학습에 섞이지 않습니다.
- `releaseInput()`은 엔진 안에 보류된 오디오(denoise 모델이 가진 오디오 이력 포함)를 버리고 VAD 게이트를 이벤트 없이 닫힌 상태로 되돌립니다. `speech_gate_opened`는 release 뒤 다음 발화에서 나옵니다. 실제로 hold가 있었던 뒤라면 다음 청크의 `discontinuity`가 reason `input_held`입니다(hold 중이 아닐 때의 release는 아무것도 하지 않습니다).
- release는 적응 상태(DFN3 소음 추정치·close_talk 학습값·AGC)를 hold 직전 값 그대로 이어 갑니다. `reset()`은 처리 이력을 모두 지우고 AEC 필터까지 초기화하므로 같은 효과가 아닙니다.
- `getStatus().inputHeld`는 선택 필드이며, 입력 hold를 지원하지 않는 엔진에서는 없습니다(`undefined`).
- `holdInput()`·`releaseInput()`은 호출한 순서대로 적용되며, 이후의 `start()`/`resume()`/`pause()`/`reset()`/`stop()`에 취소되지 않습니다. `await` 없이 같은 tick에 이어 불러도 마찬가지입니다. `dispose()`를 부르면 `capture_disposed`로, 구형 kit에서는 `tellus_input_hold_unsupported`로만 거부합니다.
- release 뒤에는 hold 이전·도중의 소리가 출력되지 않습니다. 단 release 때 AEC가 실제로 처리 중이면(엔진 재생(`playback()`·`playbackEncoded()`)이 진행 중이라 render reference가 들어오고 있을 때) release 뒤 AEC 출력 앞 25 ms가 무음이 되고 그 뒤 hold 중 소리의 잔향이 1e-3 peak(약 −60 dBFS) 아래로 감쇠하며 남을 수 있습니다(250 ms 안에 정확히 0). AEC가 처리 중이 아니면 경계는 정확히 0입니다. 엔진 재생이 끝나면 엔진이 AEC를 새로 만들므로, 보통 흐름(TTS를 엔진 재생으로 틀고 재생이 끝난 뒤 release)에서는 이 구간이 없습니다. 앱이 TTS를 자체 플레이어로 틀면 모바일·웹 AEC는 켜지지 않습니다.
- hold 중에도 `reset()`과 `setDenoiseEnabled()`는 기존 동작 그대로이며 hold를 풀지 않습니다. hold를 푸는 것은 `releaseInput()`뿐입니다.
- 이 API는 엔진 v0.4.6 이상이 필요하며, 구형 kit에서는 `tellus_input_hold_unsupported`로 Promise를 거부합니다. iOS 링크 플래그(`-Wl,-U`)는 podspec이 자동으로 추가하고, C++ 글루는 약한 참조로 엔진 심볼을 찾습니다.

## 장치 입력 결함과 실패 원인

엔진은 장치 입력 결함으로 캡처를 멈추지 않습니다. iOS float 입력은 큰 목소리에서 1.0을 넘을 수 있는데, [-1, 1] 밖 유한값은 ±1로 자르고 NaN·±inf는 0으로 바꿉니다. 샘플 수가 그대로라 샘플 시계와 청크 경계는 바뀌지 않습니다. 같은 스트림에서 직전보다 이른 timestamp도 받으며 청크 `timestamp`는 뒤로 가지 않습니다(장치 레이트가 바뀌면 새 구간은 그 시각과 이전 구간 끝 중 늦은 쪽에서 시작합니다). 지원하지 않는 장치 레이트(8000~192000 Hz의 50의 배수가 아님)는 계속 실패하며 `internal_error`가 아니라 `invalid_argument`입니다.

```ts
await capture.start((error, chunk) => {
  if (error) {
    // error.message는 기존 오류 코드(예: 'internal_error', 'invalid_argument')이고 엔진 설명은 engineMessage입니다.
    console.warn(error.message, (error as AudioCaptureEngineError).engineMessage);
    return;
  }
  if (chunk?.inputClippedSamples) console.debug('clipped input samples', chunk.inputClippedSamples);
});
const status = await capture.getStatus();
status.inputClippedSamples;       // 누적: ±1로 자른 샘플 수
status.inputNonFiniteSamples;     // 누적: 0으로 바꾼 NaN·±inf 샘플 수
status.inputTimestampRegressions; // 누적: 역행 timestamp 호출 수
status.lastErrorMessage;          // 마지막으로 실패한 엔진 호출의 설명, 없으면 null
```

누적 수는 reset·pause/resume·stop/start·hold로 지우지 않습니다. 청크 필드는 앞 청크 뒤 이 청크까지의 수(없으면 0)이고 처리 지연만큼 소리와 어긋나며, hold 중 센 수는 release 뒤 첫 청크에 붙습니다. `internal_error` 뒤 capture는 다른 작업을 `internal_error`로 거부하지만 `getStatus()`는 읽히고, 성공한 `reset()` 또는 `stop()` → `start()`가 잠금을 풀어 같은 capture 객체로 다시 캡처합니다. 실패가 멈춘 OS 캡처는 `reset()`이 다시 열지 않으므로 다시 캡처하려면 `stop()` → `start()`를 부릅니다. C++ 글루는 `tellus_audio_session_copy_last_error`를 약한 참조로 찾으며 podspec의 `-Wl,-U` 플래그로 구형 라이브러리와도 링크됩니다(Android는 기존 약한 심볼과 같은 방식입니다). 이 동작은 엔진 v0.4.9 이상이 필요하고, 그 전 kit에서는 `engineMessage`가 없고 `lastErrorMessage`는 `null`, 누적 수 필드는 없습니다.
