# Tellus Audio SDK — Web

브라우저 설치 패키지입니다. 구현 원본은 이 SDK 저장소의 `src/platforms/web`에 있으며 ORT Web 의존성은 이 패키지만 설치합니다.

```sh
npm install @tellus-ai/audio-sdk-web
```

설치 토큰 `TELLUS_AUDIO_ENGINE_TOKEN`과 HTTPS 다운로드 서비스 `TELLUS_AUDIO_DOWNLOAD_BASE_URL`을 설정하면 postinstall이 호스트 OS와 관계없이 웹 엔진을 설치합니다.

```ts
import { AudioEngine } from '@tellus-ai/audio-sdk-web';
import { attachEngineAuthorization } from '@tellus-ai/audio-sdk-web/authorization';
```

앱 빌드의 Node 스크립트에서 정적 자산을 복사합니다.

```js
const { copyWebAssets } = require('@tellus-ai/audio-sdk-web/installer');
copyWebAssets('./public/tellus-audio');
```

WASM·암호화 모델·Worker·Worklet·ORT·라이선스를 함께 복사합니다. 암호화 모델은 `models/denoise.temc`, `models/vad.temc`이며 `BrowserEngineAssets.encryptedModels`에 이 경로를 넘깁니다. Worker 진입점은 `tellus-audio/platforms/web/worker.js`, Worklet은 `tellus-audio/platforms/web/worklet.js`입니다. SDK 기본 옵션의 자산 경로와 맞춰 제공해야 합니다. HTTPS 또는 localhost에서 마이크 권한을 허용하고 서버의 실행 승인·모델 키를 적용합니다. 기존 Promise 기반 캡처·승인·TTS API를 유지합니다.

## 장치 선택

```ts
import { AudioEngine, listAudioDevices } from '@tellus-ai/audio-sdk-web';
import type { BrowserEngineAssets } from '@tellus-ai/audio-sdk-web';

const microphones = await listAudioDevices('microphone');
const outputs = await listAudioDevices('playback');
// 앱 선택 UI가 목록의 ID를 넘긴다. 출력 권한은 사용자 클릭 경계에서 앱이 얻는다.
async function createEngine(micDeviceId: string, playbackDeviceId: string, assets: BrowserEngineAssets) {
  return AudioEngine.init({ micDeviceId, playbackDeviceId }, assets);
}
```

마이크는 `getUserMedia`의 exact `deviceId`로 선택합니다. 재생 출력은 엔진이 공유하는 `AudioContext`에 적용되며 그 엔진의 PCM·encoded 재생 모두에 적용됩니다. 브라우저의 `setSinkId` 지원과 출력 권한이 필요합니다. 앱은 지원되는 경우 사용자 클릭에서 `selectAudioOutput()`으로 출력 권한을 얻고 반환된 ID를 전달할 수 있습니다. 다른 앱의 출력이나 OS 기본 장치는 변경하지 않습니다.

조회는 브라우저가 공개한 ID와 label을 그대로 반환하며 권한 전에는 label이 비어 있을 수 있습니다. 시스템 오디오 캡처 선택은 `unsupported`입니다. 출력 선택 실패 시 init 오류에 `deviceStatus`가 포함되며 AudioContext와 Worker를 정리합니다. 기존 capture의 stop/start는 같은 설정을 다시 사용하므로 장치를 바꾸려면 새 엔진을 생성합니다.

## 마이크 게인

```ts
const engine = await AudioEngine.init({
  micGainDb: -3,
  autoGainControl: { enabled: true, maxGainDb: 8 },
}, assets);
const capture = engine.createCapture();
await capture.setMicGainDb(0);
```

브라우저 AGC는 `getUserMedia`에서 꺼 두며 OS 입력 볼륨은 조절하지 않습니다. 위 자동 보정은 Worker의 denoise 이후 마이크 처리에만 적용됩니다. `micGainDb` 기본값은 0 dB, 범위는 -60..+12 dB입니다. 자동 보정은 기본 꺼짐이며 `autoGainControl`은 deprecated `micAgc2Enabled`보다 우선합니다. 시스템 오디오 캡처는 지원하지 않으므로 0이 아닌 `speakerGainDb`와 모든 `setSpeakerGainDb()` 호출은 `tellus_speaker_gain_unsupported`로 실패합니다. `playback()` 출력 볼륨은 영향을 받지 않습니다. [공통 한계값과 검증 안내](../../README.md#디지털-게인과-자동-보정)를 확인하고 대응하는 엔진 WASM과 정적 자산을 함께 배포하세요.

## close_talk 임계값과 소음 저감 상한

```ts
const engine = await AudioEngine.init({
  denoiseMode: 'close_talk',
  closeTalkThresholdDb: 30,        // 게이트 열림 임계값, 기본 30
  denoiseAttenuationLimitDb: 12,   // 소음 저감 상한, 기본 12
}, assets);
const capture = engine.createCapture();
await capture.setCloseTalkThresholdDb(24);
await capture.setDenoiseAttenuationLimitDb(9);
```

`closeTalkThresholdDb`는 close_talk 게이트가 열리는 임계값(유한한 0..60 dB, 엔진 기본 30)입니다. 낮추면 작은 소리도 통과해 멀리 있는 말소리가 더 들어오고, 높이면 입에 가까운 큰 소리만 통과해 먼 소리와 소음은 줄지만 작은 목소리가 잘릴 수 있습니다. `denoiseAttenuationLimitDb`는 close_talk의 소음 저감 상한을 양수 dB 크기로 지정합니다(유한한 0..60 dB, 엔진 기본 12). 엔진이 입력을 10^(-dB/20)만큼 되섞어 저감폭을 제한합니다. 상한을 키우면 소음은 더 줄지만 작은 목소리도 함께 지워질 수 있다. 일반(general) 모드는 상한이 없습니다. 두 setter는 다음 10 ms hop부터 적용되며 보관 중인 오디오와 학습된 레벨은 유지합니다. 엔진 기본값을 SDK가 주입하지 않으며, 모바일·웹은 configure 뒤에 설정값을 setter로 적용합니다.

`getStatus()`의 `closeTalkThresholdDb`·`denoiseAttenuationLimitDb`는 선택 필드이며, 지원하지 않는 엔진에서는 없습니다(`undefined`). 범위를 벗어나거나 유한하지 않은 값은 `tellus_close_talk_threshold_db_invalid`·`tellus_denoise_attenuation_limit_db_invalid`. 이 API는 엔진 v0.4.5 이상이 필요하며, 구형 kit에서는 `tellus_close_talk_threshold_unsupported`·`tellus_denoise_attenuation_limit_unsupported`로 거부합니다. WASM export가 없으면 호출 전에 확인합니다.

## close_talk 튜닝 (유지 시간·유지 간격·레벨 마진·학습 레벨)

```ts
const engine = await AudioEngine.init({
  closeTalkHoldMs: 250,             // 열린 게이트 유지 시간, 기본 250 (0..=2000 ms)
  closeTalkKeepGapDb: 4,            // 열린 뒤 유지 문턱 간격, 기본 4 (0..=20 dB)
  closeTalkLevelMarginDb: 2,        // 학습 레벨 마진, 기본 2 (0..=20 dB)
  closeTalkLearnedLevelDbfs: null,  // 학습 레벨 주입, 기본 null (-100..=0 dBFS)
}, assets);
const capture = engine.createCapture();
await capture.setCloseTalkHoldMs(300);
await capture.setCloseTalkKeepGapDb(6);
await capture.setCloseTalkLevelMarginDb(3);
await capture.setCloseTalkLearnedLevelDbfs(-40);   // 값을 주입
await capture.setCloseTalkLearnedLevelDbfs(null);  // 학습을 지움
```

setter는 `setCloseTalkThresholdDb`와 같이 다음 10 ms hop부터 적용되고 보관 중인 오디오와 학습값을 버리지 않습니다. 시작 전에 정한 값은 첫 `start()`에서 한 번 적용되며 더 새로운 런타임 값을 덮어쓰지 않습니다. 범위를 벗어난 값은 `invalid_close_talk_hold_ms: expected a finite value within 0..=2000`(`..._keep_gap_db`·`..._level_margin_db`는 0..=20, `invalid_close_talk_learned_level_dbfs`는 `-100..=0 or null`)로 거부합니다. 이 API가 없는 구형 kit에서는 `tellus_close_talk_hold_unsupported`·`tellus_close_talk_keep_gap_unsupported`·`tellus_close_talk_level_margin_unsupported`·`tellus_close_talk_learned_level_unsupported`로 거부합니다. 이 API는 엔진 v0.4.8 이상이 필요합니다.

학습 레벨은 denoise 토글, stop/start, pause/resume, reset을 지나 capture 객체 수명 동안 남습니다. 지우는 것은 `setCloseTalkLearnedLevelDbfs(null)`과 새 capture 객체뿐이므로 **입력 장치를 바꾸는 앱은 null로 호출해야 합니다.** 새 capture로 이어 가려면 앞 객체의 `getStatus().closeTalkLearnedLevelDbfs`를 새 `closeTalkLearnedLevelDbfs`로 넘기십시오(기록은 넘어가지 않고 주입값으로 시작합니다).

`getStatus()`는 `closeTalkHoldMs`·`closeTalkKeepGapDb`·`closeTalkLevelMarginDb`·`closeTalkLearnedLevelDbfs`(`number | null`)·`closeTalkLevelLearned`(자체 학습 완료 여부)를 보고하며, 지원하지 않는 엔진에서는 없습니다. 청크의 `closeTalkGate`는 게이트가 처리한 청크에서 `{ open, openRatio, lsnrDb, levelDbfs, learnedLevelDbfs }`, 아니면 `null`입니다.

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
- `releaseInput()`은 엔진 재생을 멈추지 않고, 앞서 `await` 없이 부른 설정 setter(`setMicGainDb()` 등)와 진행 중인 `start`·`pause`·`stop`·재생도 거부하지 않습니다.
- release 뒤에는 hold 이전·도중의 소리가 출력되지 않습니다. 단 release 때 AEC가 실제로 처리 중이면(엔진 재생(`playback()`·`playbackEncoded()`)이 진행 중이라 render reference가 들어오고 있을 때) release 뒤 AEC 출력 앞 25 ms가 무음이 되고 그 뒤 hold 중 소리의 잔향이 1e-3 peak(약 −60 dBFS) 아래로 감쇠하며 남을 수 있습니다(250 ms 안에 정확히 0). AEC가 처리 중이 아니면 경계는 정확히 0입니다. 엔진 재생이 끝나면 엔진이 AEC를 새로 만들므로, 보통 흐름(TTS를 엔진 재생으로 틀고 재생이 끝난 뒤 release)에서는 이 구간이 없습니다. 앱이 TTS를 자체 플레이어로 틀면 모바일·웹 AEC는 켜지지 않습니다.
- hold·release는 호출한 순서대로 적용되며, 이후의 reset/pause/denoise 토글로 취소되지 않습니다.
- hold 중에도 `reset()`과 `setDenoiseEnabled()`는 기존 동작 그대로이며 hold를 풀지 않습니다. hold를 푸는 것은 `releaseInput()`뿐입니다.
- 이 API는 엔진 v0.4.6 이상이 필요하며, 구형 kit에서는 `tellus_input_hold_unsupported`로 거부합니다. WASM export가 없으면 호출 전에 확인합니다.
