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
