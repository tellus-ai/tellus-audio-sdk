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
