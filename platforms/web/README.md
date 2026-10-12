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

WASM·암호화 모델·Worker·Worklet·ORT·라이선스를 함께 복사합니다. Worker 진입점은 `tellus-audio/platforms/web/worker.js`, Worklet은 `tellus-audio/platforms/web/worklet.js`입니다. SDK 기본 옵션의 자산 경로와 맞춰 제공해야 합니다. HTTPS 또는 localhost에서 마이크 권한을 허용하고 서버의 실행 승인·모델 키를 적용합니다. 기존 Promise 기반 캡처·승인·TTS API를 유지합니다.

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
