# Tellus Audio SDK

Electron, React Native 및 브라우저에서 같은 Tellus 오디오 엔진을 사용하는 SDK.

This package provides a public JavaScript/TypeScript entrypoint for low-latency microphone,
speaker/system-audio capture, denoise model preload, Silero VAD gating, transport encoding, and
runtime capture control. SDK packages and native binaries are delivered through authenticated CloudFront downloads.
Native binaries are installed into `vendor/<platform>/` during package installation.

## React Native·브라우저

기본 Node/Electron API는 아래 문서를 따른다. 모바일과 브라우저에서는 다음 엔트리를 사용한다.

| 환경 | 엔트리 | 캡처 |
| --- | --- | --- |
| React Native | `@tellus-ai/audio-sdk/react-native` | iOS AVAudioEngine / Android AudioRecord |
| 브라우저 | `@tellus-ai/audio-sdk/browser` | AudioWorklet → Worker의 WASM |

두 환경 모두 마이크 mono 16/48kHz·20ms, 엔진 AEC·FastEnhancer·Silero VAD, Opus/PCM을 지원한다. 모델은 암호화 `.temc`만 설치하며 `/audio`의 실행 승인과 HPKE 모델 키가 적용된 뒤 캡처를 시작한다. 모바일·브라우저 제어 API는 Promise를 반환한다.

### 플랫폼 설치

고객 설치 토큰과 다운로드 URL을 설정한 뒤 설치 대상 하나를 지정한다. 두 모바일 플랫폼을 빌드하면 각각 설치한다.

```sh
TELLUS_AUDIO_ENGINE_PLATFORM=ios npm install @tellus-ai/audio-sdk
npm run install:binary --prefix node_modules/@tellus-ai/audio-sdk -- --platform android
# 웹: 런타임·암호화 모델·라이선스를 앱 정적 디렉터리에 복사한다.
npm run install:binary --prefix node_modules/@tellus-ai/audio-sdk -- --platform web --out /absolute/path/to/public/tellus-audio
```

이미 설치된 웹 자산을 다시 복사할 때는 빌드 스크립트에서 `require('./node_modules/@tellus-ai/audio-sdk/dist/installer/copy-web-assets.js').copyWebAssets('./public/tellus-audio')`를 호출한다. 패키지의 내부 상대 ESM 경로와 `ort/`, `models/`, `licenses/`를 함께 배포한다. 각 플랫폼의 정확한 엔진 버전과 파일은 `release-assets.json`에 고정되어 있다.

### 승인과 캡처

```ts
import { AudioEngine } from '@tellus-ai/audio-sdk/react-native';
import { attachEngineAuthorization } from '@tellus-ai/audio-sdk/authorization';

const engine = await AudioEngine.init({
  processing: { sampleRate: 16000, chunkDurationMs: 20 },
  transport: { codec: 'opus' }, denoiseEnabled: true, vadEnabled: true,
});
const capture = engine.createCapture();
const authorization = attachEngineAuthorization(audioSocket, capture, {
  conversationId, getAccessToken: () => accessToken, onError: handleError,
});
await authorization.ready;
await capture.start((error, chunk) => {
  if (error) handleError(error);
  else if (chunk) sendAudio(chunk); // Uint8Array payload, validSampleCount로 마지막 유효 범위를 확인한다.
});
```

`audioSocket`은 서버의 `/audio` WebSocket이다. 앱이 연결·재연결을 관리하고 새 socket에는 승인을 다시 연결한다. `pause()`/`resume()`은 같은 capture를 유지한다. `stop()`은 마지막 유효 청크를 flush하며 같은 capture를 다시 시작할 수 있다. 세션 종료에는 `authorization.dispose()`와 `await capture.dispose()`를 호출한다. `reset()`은 승인과 캡처를 유지하며 처리 이력을 비운다. `setDenoiseEnabled()`는 현재 모델의 준비와 실행 승인이 필요하다.

TTS는 같은 capture의 `playback(Float32Array, sampleRate)` 또는 `playbackEncoded(ArrayBuffer)`로 재생한다. MP3/WAV를 OS가 디코딩하고 실제 재생 PCM을 엔진 AEC에 전달한다. 반환 Promise는 재생 완료를 기다리며 `cancelPlayback()`으로 취소한다. SDK 밖에서 재생한 소리에는 이 기준 신호가 적용되지 않는다.

### Expo / CNG 개발 앱

고객 앱은 TypeScript의 `AudioEngine.init()`과 `createCapture()`를 사용한다. Expo [설정 플러그인](https://docs.expo.dev/config-plugins/introduction/)이 마이크 권한 안내, 선택한 iOS background audio, Android 지원 ABI를 생성하고 React Native autolinking이 SDK를 연결하므로 Swift·Kotlin·Podfile·Gradle을 직접 수정할 필요가 없다.

위 플랫폼 설치 안내에 따라 SDK와 대상 엔진을 설치한 뒤 Nitro를 추가한다.

```sh
npm install react-native-nitro-modules@0.35.4
```

`app.json`의 plugin 목록에 SDK를 추가한다. `microphonePermission`을 생략하면 앱의 기존 안내 문구를 보존하며, 설정이 없으면 기본 안내를 생성한다. `backgroundAudio`의 기본값은 false이고, 기존 앱의 다른 background 설정은 보존한다.

```json
{
  "expo": {
    "plugins": [["@tellus-ai/audio-sdk", {
      "microphonePermission": "실시간 번역을 위해 마이크를 사용합니다.",
      "backgroundAudio": false
    }]]
  }
}
```

```sh
npx expo run:android
# macOS에서는 npx expo run:ios
npx expo start --dev-client
```

SDK가 포함된 개발 앱을 한 번 빌드한 뒤에는 TypeScript 변경을 Metro로 반영한다. SDK native 버전 또는 app config가 바뀌면 CNG 프로젝트에서 `npx expo prebuild --clean` 후 다시 빌드한다. 기존 native 파일을 직접 관리하는 프로젝트에 이 명령을 실행하면 해당 파일이 재생성되므로, 이 예제의 기존 tracked iOS 프로젝트는 유지한다. [Expo 개발 앱](https://docs.expo.dev/develop/development-builds/introduction/)에는 SDK의 native module이 포함되며 Expo Go에는 포함되지 않는다. `expo-dev-client` 설치 없이도 현재 예제처럼 `--dev-client`로 사용자 개발 앱을 실행할 수 있다.

설치되는 암호화 모델과 라이브러리는 SDK installer가 준비한다. 앱 bundle에는 모델 CEK를 넣지 않으며, 캡처 시작 전에 서버 permit과 wrapped model key를 적용한다. 고객 프로젝트의 Expo·React Native·네이티브 의존성 버전을 맞춘 SDK 포함 개발 앱을 직접 빌드해 제공할 수 있다. Expo Go에 SDK를 등록할 필요는 없다.

Android 13 이상에서 `setRecordingNotification()`의 pause/resume 버튼을 notification drawer에 표시하려면 앱 TypeScript에서 `PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)`로 알림 승인을 요청한다. plugin이 manifest 선언을 생성하며 승인이 거절되어도 마이크 foreground service의 보호는 유지된다. 버튼 callback은 앱의 기존 pause/resume 제어를 호출한다. iOS에서는 이 알림 설정을 사용하지 않는다.

### 플랫폼 실행 조건

Expo 앱의 마이크 권한과 선택적 iOS background audio는 위 SDK 플러그인이 생성한다. Android는 API 24 이상, arm64-v8a/x86_64를 지원하며 SDK의 Gradle·manifest가 라이브러리·암호화 모델·microphone foreground service를 연결한다. 캡처 시작은 foreground에서 한다. interruption·포커스 손실·장치 경로 변경은 캡처를 중단하므로 앱이 오류를 처리하고 명시적으로 재시작한다.

Android 녹음 알림은 선택적 `setRecordingNotification({ title, contentText, onPause, onResume })`으로 설정한다. callback에서 앱이 `pause()`/`resume()`를 제어한다. 사용자 pause 동안 단일 SDK foreground service를 유지하며 stop·dispose·승인 만료·오류에는 정리한다. 별도 녹음 service나 OS 음성 처리 graph를 동시에 시작하지 않는다.

브라우저는 HTTPS 또는 localhost, 마이크 권한, AudioContext·AudioWorklet·module Worker·WASM SIMD/BigInt가 필요하다. `AudioEngine.init(config, assets)`의 `assets`에 `engineModuleUrl`, `wasmUrl`, `ortModuleUrl`, `ortWasmBaseUrl`, `encryptedModels` URL을 지정한다. `start()`는 사용자 입력에서 호출하며 SDK가 브라우저 내장 AEC·noise suppression·AGC를 끈다. 정적 파일을 같은 origin의 올바른 JS/WASM MIME으로 제공한다. 현재 단일 WASM thread 경로는 SharedArrayBuffer와 교차 출처 격리를 요구하지 않는다. 웹 메모리와 코드를 읽을 수 있으므로 모델 보호 범위는 암호화 배포와 승인된 세션의 키 발급까지다.

공개 CI 서명 키를 신뢰하는 개발 artifact와 테스트 모델 키는 제품 릴리스에 사용하지 않는다. 실제 예제는 `Tellus-realtime-translate-example/mobile` 및 `web`을 참고한다.

## Requirements

- Node.js 18 or later.
- A Tellus-issued customer installation token and the Realtime Speech URL for your environment.
  The legacy engine download path requires a GitHub release token instead.
- macOS, Windows x64, or Linux x64 glibc. Linux musl builds are not currently supported.
- `tar` available on `PATH` during installation.

## Supported Platforms

| Platform | Native asset | Speaker capture backend | Speaker track source |
| --- | --- | --- | --- |
| macOS arm64/x64 | `darwin-universal` | CoreAudio TapGuard on macOS 14.2+; ScreenCaptureKit fallback on older supported versions | `system_audio` or `screen_share_audio` |
| Windows x64 | `win32-x64-msvc` | WASAPI loopback | `system_audio` |
| Linux x64 glibc | `linux-x64-gnu` | PulseAudio monitor | `system_audio` |

## Features

- Microphone capture through the native engine.
- Speaker/system-audio capture:
  - Windows: WASAPI loopback.
  - macOS 14.2+: CoreAudio TapGuard, exposed as `system_audio`.
  - macOS fallback: ScreenCaptureKit, exposed as `screen_share_audio`.
  - Linux: PulseAudio monitor.
- `AudioEngine.init(config)` facade for app-start initialization and model preload.
- Optional manual post-init model preload with `preloadModels(config)`.
- FastEnhancer denoise model support.
- Silero VAD gate support.
- Transport payload encoding:
  - `opus`
  - `pcm_s16le`
  - `pcm_f32le`
- Optional synchronized `rawAudio` PCM16 frames for mic, speaker, and mixed streams.
- Structured permission checks with macOS public authorization APIs and CoreAudio TapGuard probe
  validation.
- Device helper APIs for default input/output and speaker capability checks.

## Contents

- [Install](#install)
- [Environment Variables](#environment-variables)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [Permission Checks](#permission-checks)
- [Capture Examples](#capture-examples)
- [Transport Codec Examples](#transport-codec-examples)
- [VAD](#vad)
- [Runtime Controls](#runtime-controls)
- [Microphone Activity Lookup](#microphone-activity-lookup)
- [API Reference](#api-reference)
- [Platform Notes](#platform-notes)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

## Install

### GitHub SDK installation with private CloudFront engine downloads

Install the SDK from GitHub. Its postinstall script downloads the pinned native
engine through CloudFront using a customer installation token issued by Tellus.
An app account, app login, and a login access JWT are not required for installation.

```bash
export TELLUS_AUDIO_DOWNLOAD_BASE_URL="https://<realtime-speech-host>"
export TELLUS_AUDIO_ENGINE_TOKEN="<Tellus-issued-30-day-installation-token>"
npm install "git+https://github.com/tellus-ai/tellus-audio-sdk.git#v0.2.1"
```

Use the SDK tag or commit approved for your integration and keep it pinned in
package.json and package-lock.json. The SDK repository stays on GitHub; the engine
S3 publishing workflow is still needed to provide the private native artifacts.
The SDK tarball publishing workflow is not used by this GitHub installation flow.

Tellus issues a separate RS256 installation JWT for each customer and environment.
It expires **30 days (2,592,000 seconds) after issuance**, not after first use.
It is a Bearer credential: sharing it allows other holders to install until expiry.
Customer identity in the token does not prevent copying it to another machine.
Ask Tellus for a replacement after expiry; the installer cannot extend the deadline.

Postinstall sends the installation token only to Realtime Speech using
`POST /v1/audio-artifacts/engine/<version>/<filename>/token`, once per checksum
and archive. The API returns `{url, token, expires_at, token_type: "Bearer"}`.
The distinct download token is valid for one exact file and environment, for at
most 30 days and never beyond the installation token's expiration. No app login
JWT is sent or accepted by this installation API.
The fixed download URL does not expire after 30 days. An older URL remains usable
with a valid token for that file; CDN cache expiration is separate from authorization.

The installer sends only the file download token to `https://download.tellus.ai.kr`.
It rejects other destinations, query credentials and all CDN redirects. CloudFront
checks every request, including cache hits and Range requests. An installation
token cannot be used directly at the CDN because it has a different audience.
On CDN 401 the installer requests one fresh grant and retries once; this does not
extend the original installation token's expiry. SHA-256 is checked before replacing
the engine. Failed downloads never switch to GitHub automatically.

Deploy the CloudFront verifier supporting 30-day tokens before the matching
Realtime Speech customer-token API. Existing SDK token-download clients can send
the new installation token through the same environment variable. Existing login
JWTs must be replaced in local and CI installation environments. Do not store tokens
in package.json, package-lock.json, installation state, logs or source control.

Download authorization is separate from native execution: `attachEngineAuthorization()`
continues to renew execution approval over `/audio`. No AWS credentials are shipped
to clients. `TELLUS_AUDIO_DOWNLOAD_BASE_URL` points to Realtime Speech, not the CDN.

### Publishing SDK packages to the shared bucket

Set repository Actions Variables `AUDIO_ARTIFACTS_S3_BUCKET` to
`tellus-audio-artifacts-374604322840` and `AUDIO_ARTIFACTS_S3_REGION` to
`ap-northeast-2`. Create GitHub Environments `dev`, `stg`, and `prod`; in each, set
`AWS_AUDIO_ARTIFACTS_ROLE_ARN` to its SDK publisher role from Terraform's
`publisher_role_arns.<environment>.sdk` output. Restrict deployment refs to the
`main` branch and `v*` tags. The OIDC trust subject includes the environment.

A matching `vX.Y.Z` tag publishes to `prod/audio/sdk/vX.Y.Z/`. Manual
`publish-s3.yml` runs require an environment choice (default dev), and accept
`main` or a tag matching package.json. The workflow sets
`AUDIO_ARTIFACTS_ENVIRONMENT` from the selected environment. Local publisher
invocations must also set that variable explicitly to dev, stg, or prod.
Missing or invalid environments are rejected before any S3 write.

### Legacy engine downloads from GitHub Releases

When `TELLUS_AUDIO_DOWNLOAD_BASE_URL` is unset, the existing private GitHub Release
installation remains available and `TELLUS_AUDIO_ENGINE_TOKEN` must be a GitHub
token. Set the Realtime Speech service URL explicitly to use CloudFront distribution.

Set the private release token before installation:

```bash
export TELLUS_AUDIO_ENGINE_TOKEN="..."
npm install git+https://github.com/tellus-ai/tellus-audio-sdk.git#v0.2.0
```

Installing from GitHub uses the public `tellus-ai/tellus-audio-sdk` repository. The package
`prepare` step builds the TypeScript wrapper before npm packs the git dependency.

The `postinstall` step downloads the native binary for the current platform, verifies its SHA-256
checksum, and installs it under `vendor/<platform>/`.

This SDK repository may be public, but the native Tellus audio engine release is private.
Installation requires a Tellus-issued GitHub token with access to the engine release assets.

The required native engine version is pinned in `release-assets.json`:

```json
{
  "sdkVersion": "0.2.1",
  "nativeEngineVersion": "0.3.0",
  "nativeEngineTag": "v0.3.0"
}
```

The installer validates that the manifest matches the installed SDK package version and that
artifact file names include the pinned native engine tag. Download URLs are resolved from the
private GitHub Release by exact asset file name.

If you do not want to export the token in the shell, place it in the installing project's `.env`
file before running `npm install`:

```dotenv
TELLUS_AUDIO_ENGINE_TOKEN=...
```

## Environment Variables

| Name | Description |
| --- | --- |
| `TELLUS_AUDIO_ENGINE_TOKEN` | Tellus-issued 30-day customer installation token for CloudFront distribution, or a GitHub token for the legacy release path. The installer also reads this single key from the installing project's `.env` file. |
| `TELLUS_AUDIO_DOWNLOAD_BASE_URL` | HTTPS Realtime Speech base URL for authenticated CloudFront distribution. When set, `TELLUS_AUDIO_ENGINE_TOKEN` is a customer installation token instead of a GitHub token. Export this URL in the process environment. |
| `TELLUS_AUDIO_ENGINE_MODEL_DIR` | Optional override for the native model directory. When omitted, the SDK looks for bundled `models/` next to the installed native binary. |
| `ORT_DYLIB_PATH` | Optional override for the ONNX Runtime dynamic library path. When omitted, the SDK resolves the bundled ONNX Runtime for the current platform. |

Only `TELLUS_AUDIO_ENGINE_TOKEN` is read from `.env`; other environment variables must be provided
by the process environment if they are needed.

## Quick Start

Use `AudioEngine.init(config)` at app startup, then call `engine.createCapture()` when the user
starts a meeting, recording, or live audio session.

```javascript
const {
  AudioEngine,
  attachEngineAuthorization,
  checkMicCapturePermissionInfo,
  checkSpeakerCapturePermissionInfo,
  initLogging,
  isSpeakerCaptureSupported,
  listSpeakerDevices,
  listMicDevices,
} = require('@tellus-ai/audio-sdk');

const audioConfig = {
  micEnabled: true,
  speakerEnabled: true,
  denoiseEnabled: true,
  vadEnabled: true,
  enableRawAudio: true,
  processing: {
    sampleRate: 16000,
    chunkDurationMs: 20,
  },
  transport: {
    codec: 'opus',
    bitrateBps: 64000,
  },
};

async function main({ audioSocket, conversationId, getAccessToken }) {
  initLogging('audio_capture=info');

  console.log('Microphones:', listMicDevices());
  console.log('Speakers:', listSpeakerDevices());
  console.log('Speaker supported:', isSpeakerCaptureSupported());

  const micPermission = checkMicCapturePermissionInfo();
  const speakerPermission = checkSpeakerCapturePermissionInfo();

  if (!micPermission.granted) {
    throw new Error(`Microphone unavailable: ${micPermission.status} ${micPermission.message}`);
  }

  if (audioConfig.speakerEnabled && !speakerPermission.granted) {
    throw new Error(`Speaker capture unavailable: ${speakerPermission.status} ${speakerPermission.message}`);
  }

  const engine = await AudioEngine.init(audioConfig);
  const capture = engine.createCapture();
  const authorization = attachEngineAuthorization(audioSocket, capture, {
    conversationId, getAccessToken, onError: console.error,
  });
  await authorization.ready;

  capture.onError((err, captureError) => {
    console.error('Capture error:', {
      err,
      source: captureError.source,
      message: captureError.message,
      recoverable: captureError.recoverable,
    });
  });

  capture.start((err, chunk) => {
    if (err) {
      console.error('Chunk error:', err);
      return;
    }

    const payload =
      chunk.data.mixed ??
      chunk.data.microphone ??
      chunk.data.system_audio ??
      chunk.data.screen_share_audio;

    console.log('Audio chunk:', {
      bytes: payload?.length ?? 0,
      trackSource: chunk.trackSource,
      codec: chunk.codec,
      sampleRate: chunk.sampleRate,
      sampleCount: chunk.sampleCount,
      durationMs: chunk.durationMs,
      rms: chunk.rms,
      vadRms: chunk.vadRms ?? null,
      gateEvent: chunk.gateEvent ?? null,
      sequence: chunk.sequence ?? null,
      discontinuity: chunk.discontinuity ?? null,
      rawMicBytes: chunk.rawAudio?.mic?.data.length ?? null,
      rawSpeakerBytes: chunk.rawAudio?.speaker?.data.length ?? null,
      rawMixedBytes: chunk.rawAudio?.mixed?.data.length ?? null,
    });
  });
  return authorization;
}

// Call main({ audioSocket, conversationId, getAccessToken }) from your application session.
// Dispose its authorization controller when that session ends.
```

## Realtime engine authorization

Captures using an authorization-enabled native build require a short-lived approval from Tellus
Realtime Speech before `start()` or `resume()`. The native engine verifies the server's Ed25519
signature and stops processing and
output at expiry, including while paused or when the JavaScript event loop is blocked. An approval
is bound to one native capture instance and conversation; copying it to another capture fails.
The `/audio` execution token is a custom Ed25519-signed permit, not a JWT. Issued permits and
permit hashes are not stored in a database or Redis. The server checks your existing access
credentials and connection permissions before signing; Rust verifies the returned permit locally.
No additional temporary session-token endpoint or session table is required for this flow.
Pending challenges and active authorization metadata live only in native instance memory.

Bind your existing `/audio?conversation_id=...` WebSocket to the capture before sending audio:

```javascript
const { attachEngineAuthorization } = require('@tellus-ai/audio-sdk/authorization');

const authorization = attachEngineAuthorization(audioSocket, capture, {
  conversationId,
  getAccessToken: () => authSession.getCurrentAccessToken(),
  onError: error => console.error('Audio authorization:', error),
});
await authorization.ready;
capture.start((error, chunk) => {
  if (!error && audioSocket.readyState === 1) {
    audioSocket.send(chunk.data.mixed ?? chunk.data.microphone);
  }
});

// Session teardown:
authorization.dispose(); // invalidates permission and stops this capture
capture.stop();
audioSocket.close();
```

`audioSocket`, `conversationId`, and `authSession` come from your application's authenticated
Realtime Speech session. The socket must expose `addEventListener`/`removeEventListener`, as
browser WebSocket and modern `ws` do. The adapter supports a connecting or already open socket.
It checks native authorization support before registering socket listeners; an unsupported build
throws `engine_authorization_unsupported` immediately.
It sends the first `audio.authenticate` message, applies the native approval, and renews every
8 minutes with fresh credentials even during silence, leaving a two-minute retry margin. The server limits each approval to
10 minutes or the remaining access-token lifetime, whichever is shorter. Shorter credentials or
delayed approval delivery advance renewal to 90% of the native remaining lifetime. Register the adapter
before sending audio or other control frames. Use a new socket and adapter after reconnecting.

On disconnect or a terminal denial, the adapter invalidates the native capture. Renewal timeouts,
retryable denials, and failures to obtain current credentials retry with a fresh challenge while the
existing native permission remains valid; they never extend its deadline. The adapter never closes
the audio socket: authorization failures only stop the native engine. `ready` covers the initial approval; later failures are delivered through `onError`.
A capture that stopped at expiry must receive a new approval and be started again. Attach the same
capture again on the same open socket to receive it; reconnecting is not required.

Native approval requests require server `ENGINE_LICENSE_KEY_ID`, `ENGINE_LICENSE_PRIVATE_KEY_HEX`,
and login verification settings. No company allowlist is required. Ordinary browser audio producers
can use `/audio` without this native approval protocol or signing configuration. The matching public
key is embedded in a new native build using
`TELLUS_ENGINE_LICENSE_PUBLIC_KEYS` as a single 64-character Ed25519 public key hex.
The private signing key stays on the server. The release manifest pins native engine v0.3.0,
whose capture requires runtime approval. Publish a new native version before changing that pin.
This SDK continues to support ordinary capture with older native binaries. Only explicit authorization
API calls and `attachEngineAuthorization()` reject those binaries with `engine_authorization_unsupported`.
Using the SDK with a newly authorized native build still requires approval enforced by Rust.

Installation/download credentials (`TELLUS_AUDIO_ENGINE_TOKEN`) and runtime approvals are separate.
This feature controls runtime capture; it does not prevent downloading or reverse engineering a
binary. The remaining capture examples assume the capture has completed the approval above.

To verify real server-to-native interoperability, build this SDK and provide the integration
client `scripts/engine-authorization-client.js` as `TELLUS_AUDIO_SDK_TEST_CLIENT` and a native debug
binary trusting the dedicated test public key as `TELLUS_ENGINE_TEST_BINARY` when running the
Realtime Speech engine-authorization integration tests. The client uses the real SDK and native
instance, verifies the eight-minute renewal timer, and exercises its callback without waiting.

## Core Concepts

### `AudioEngine` vs `AudioCapture`

`AudioEngine` is the recommended high-level entrypoint. It validates the capture config, prepares
DSP/model state, stores the config, and creates capture sessions later.

```javascript
const engine = await AudioEngine.init(audioConfig);
const capture = engine.createCapture();
```

`AudioCapture` is the actual capture session. It owns native capture threads after `start()` and
releases them on `stop()`.

You can still construct `new AudioCapture(config)` directly, but the preferred app flow is:

1. Build one `audioConfig`.
2. Call `AudioEngine.init(audioConfig)` during app startup.
3. Call `engine.createCapture()` when capture is needed.
4. Register `capture.onError(...)`.
5. Attach engine authorization to the audio WebSocket and await `authorization.ready`.
6. Call `capture.start(...)`.
7. Dispose authorization and stop capture when the session ends.

### Default Devices

`AudioCapture` follows the OS default input and output devices. Change microphone or speaker routing
through the operating system device settings.

When default devices change while capture is running, the native engine is expected to follow the
current OS defaults for the relevant source path. Use `getDefaultInputDevice()` and
`getDefaultSpeakerDevice()` when the UI is checking speaker availability.

### Final Payload vs Raw Audio

`chunk.data` contains final transport payloads. These are encoded according to
`transport.codec`.

`chunk.rawAudio` is present only when `enableRawAudio: true`. Raw frames are PCM16 little-endian:

- `rawAudio.mic`: microphone PCM16 at the original microphone device sample rate.
- `rawAudio.speaker`: speaker PCM16 at the original speaker device sample rate when actual speaker PCM is available.
- `rawAudio.mixed`: mixed PCM16 at `processing.sampleRate`.

For example, a 48kHz microphone can return `rawAudio.mic.sampleRate === 48000` even when the final
transport payload uses `processing.sampleRate: 16000`.

When `speakerEnabled: true`, `rawAudio.speaker` can still be `null` during startup, device reopen,
or a temporary speaker-source underrun before an actual speaker PCM frame arrives. This is a
temporary unavailable state, not necessarily a capture failure. A real speaker callback whose
samples are all zero is still represented by a non-null PCM frame. When both sources are enabled,
`rawAudio.mixed` may remain present while `rawAudio.speaker` is `null`; the processed mixer
zero-pads the missing speaker input, so that interval is effectively microphone-only and is not
retroactively rewritten when speaker audio arrives.

### Slow consumers and discontinuities

The native engine keeps capture running when JavaScript temporarily falls behind. Its delivery
queue is limited to 25 chunks and 500ms; if that queue fills, the oldest real-time chunks are
removed so memory stays bounded. The next delivered chunk reports the missing processing-sample
range in `chunk.discontinuity`. The range is `[fromSample, toSample)`, so
`droppedSamples === toSample - fromSample`.

Consumers should keep local raw archival separate from real-time transport and forward a
discontinuity before the first audio frame after the gap. A `consumer_lag` discontinuity is a
degraded real-time delivery signal, not a request to stop capture.

## Engine Initialization and Model Preload

By default, `AudioEngine.init(config)` performs core init first and then preloads enabled models as
a post-init step.

- `denoiseEnabled` defaults to `true`.
- `vadEnabled` defaults to `false`.
- Set `vadEnabled: true` if you want the Silero VAD model preloaded and used.
- Set `options.preloadModels: false` to keep startup light and preload models manually later.

### Default Post-Init Preload

```javascript
const { AudioEngine } = require('@tellus-ai/audio-sdk');

const engine = await AudioEngine.init({
  micEnabled: true,
  speakerEnabled: true,
  denoiseEnabled: true,
  vadEnabled: true,
  processing: {
    sampleRate: 16000,
    chunkDurationMs: 20,
  },
});

const status = engine.getStatus();

console.log({
  initialized: status.initialized,
  modelsPreloaded: status.modelsPreloaded,
  denoiseActive: status.denoise.active,
  vadReady: status.vad.ready,
});
```

### Manual Model Preload After Core Init

Use this when you want fast application startup, but still want models ready before the first
capture session.

```javascript
const { AudioEngine, preloadModels } = require('@tellus-ai/audio-sdk');

const audioConfig = {
  micEnabled: true,
  speakerEnabled: true,
  denoiseEnabled: true,
  vadEnabled: true,
  processing: {
    sampleRate: 16000,
    chunkDurationMs: 20,
  },
};

async function startCaptureAfterManualModelPreload() {
  const engine = await AudioEngine.init(audioConfig, {
    preloadModels: false,
  });

  console.log('Core init status:', engine.getStatus());

  // Run after startup and before the first capture session.
  const modelStatus = preloadModels(audioConfig);

  console.log({
    denoiseActive: modelStatus.denoise.active,
    denoiseModel: modelStatus.denoise.model,
    vadReady: modelStatus.vad.ready,
    vadModel: modelStatus.vad.model,
  });

  const capture = engine.createCapture();

  capture.start((err, chunk) => {
    if (err) {
      console.error(err);
      return;
    }

    // Send chunk.data.* to your backend.
    console.log(chunk.trackSource, chunk.durationMs);
  });
}

startCaptureAfterManualModelPreload().catch(console.error);
```

`preloadModels(config)` should receive the same config used for `AudioEngine.init(config)`. If
`vadEnabled` is omitted or false, VAD preload reports inactive.

### Core Init Only With Standalone `init`

The standalone `init(config, options?)` function exists for lower-level integrations.

```javascript
const { init, preloadModels } = require('@tellus-ai/audio-sdk');

const initStatus = init(audioConfig, { preloadModels: false });
const modelStatus = preloadModels(audioConfig);

console.log(initStatus.initialized, modelStatus.denoise.active, modelStatus.vad.ready);
```

Prefer `AudioEngine.init()` for new application code because it keeps the capture config and creates
matching `AudioCapture` sessions through `createCapture()`.

## Permission Checks

Permission checks expose structured results through:

- `checkMicCapturePermissionInfo()`
- `checkSpeakerCapturePermissionInfo()`
- `probeSpeakerCapturePermissionInfo()`

These checks verify the active native permission scope for the selected backend:

- macOS microphone checks use Apple's public microphone authorization status API.
- macOS ScreenCaptureKit fallback checks use Apple's public Screen Recording preflight API.
- macOS 14.2+ CoreAudio TapGuard `system_audio` passive checks return `unknown` when the permission
  cannot be known without opening a tap.
- macOS 14.2+ CoreAudio TapGuard `system_audio` active probes open an IOProc and verify Tap
  description access to determine permission. They then play a short, quiet probe tone as a
  separate capture-health check.
- Windows and Linux speaker checks verify that the loopback/monitor stream can be opened.

Use `checkSpeakerCapturePermissionInfo()` at app startup or on passive status screens. Use
`probeSpeakerCapturePermissionInfo()` from an explicit user action such as a permission request
button. For CoreAudio TapGuard active probes, `granted` means the CoreAudio permission gate
succeeded. Check `captureHealth` and `captureReady` separately to see whether the test tone was
captured. The probe does not require the user or another app to be playing audio.

Permission request/probe APIs should not be treated as a durable permission-state cache. After an
explicit request or probe, re-run the relevant structured check when the UI needs to render current
state. macOS Screen Recording changes can require an app restart before the new state is usable.

```javascript
const {
  checkMicCapturePermissionInfo,
  checkSpeakerCapturePermissionInfo,
  probeSpeakerCapturePermissionInfo,
} = require('@tellus-ai/audio-sdk');

const mic = checkMicCapturePermissionInfo();
const speaker = checkSpeakerCapturePermissionInfo();

console.log('Mic permission:', mic);
console.log('Speaker permission:', speaker);

if (!speaker.granted && speaker.status === 'unknown') {
  const requested = probeSpeakerCapturePermissionInfo();
  console.log('Speaker probe result:', requested);

  const refreshed = checkSpeakerCapturePermissionInfo();
  console.log('Speaker permission after probe:', refreshed);
}
```

Use `result.granted` for permission branching. Use `result.captureHealth` and
`result.captureReady` for capture diagnostics. Use `result.status`, `result.reason`,
`result.probeStage`, `result.elapsedMs`, `result.permissionScope`, `result.trackSource`,
`result.backend`, `result.message`, and `result.error` when UI or logs need to explain what
happened.

### Permission Result Type

```ts
type CapturePermissionCheckResult = {
  granted: boolean;
  request: 'microphone' | 'speaker';
  permissionScope: 'microphone' | 'system_audio' | 'screen_recording' | 'none';
  trackSource?: 'microphone' | 'system_audio' | 'screen_share_audio' | 'microphone_speaker_mix' | null;
  backend:
    | 'cpal_microphone'
    | 'core_audio_tap'
    | 'screen_capture_kit'
    | 'wasapi_loopback'
    | 'pulseaudio_monitor'
    | 'unsupported';
  status: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
  message: string;
  error?: string;
  reason?: string;
  probeStage?: string;
  elapsedMs?: number;
  captureHealth?: 'ready' | 'silent' | 'failed' | 'not-run' | null;
  captureReady?: boolean;
  captureError?: string;
  rawStatus?: string;
  rawResult?: {
    api: string;
    value?: boolean | null;
    statusCode?: number | null;
    errorCode?: number | null;
    errorDomain?: string | null;
    errorMessage?: string | null;
  };
  capabilityStatus?: string;
  capabilityResult?: {
    api: string;
    value?: boolean | null;
    statusCode?: number | null;
    errorCode?: number | null;
    errorDomain?: string | null;
    errorMessage?: string | null;
  };
};
```

| Field | Description |
| --- | --- |
| `granted` | `true` when the requested permission check succeeds. For CoreAudio TapGuard this means the IOProc and Tap permission gate succeeded. |
| `request` | SDK-level request: `microphone` or `speaker`. |
| `permissionScope` | OS/platform permission scope involved in the check. |
| `trackSource` | `AudioChunk.trackSource` used by successful capture. |
| `backend` | Native backend used for the check. |
| `status` | Stable machine-readable status for branching. |
| `message` | Human-readable English explanation for logs or UI. |
| `reason` | Stable diagnostic reason such as `permission-granted`, `permission-denied`, or `io-proc-timeout`. |
| `probeStage` | CoreAudio or fallback stage that produced the permission result. |
| `elapsedMs` | Time spent in the permission-sensitive IOProc operation when available. |
| `captureHealth` | Separate capture-health result: `ready`, `silent`, `failed`, or `not-run`. |
| `captureReady` | Whether the independent capture-health probe confirmed audio. This does not override `granted`. |
| `captureError` | Capture-health diagnostic when permission succeeded but audio readiness was not confirmed. |
| `rawStatus` | Original status string returned by the OS/API when one exists. |
| `rawResult` | Original low-level result metadata for logs and diagnostics. |
| `capabilityStatus` | Optional raw status from a prompt-free permission-state API, such as Windows `AppCapability.CheckAccess("microphone")`. Omitted when unavailable or unsupported. |
| `capabilityResult` | Optional low-level metadata for `capabilityStatus`. |
| `error` | Developer diagnostic text when the check fails or cannot be classified precisely. |

On Windows, microphone checks may include `capabilityStatus` and `capabilityResult` when
`Windows.Security.Authorization.AppCapabilityAccess.AppCapability.CheckAccess("microphone")` is
available and succeeds. This is supported on Windows 10 version 1903 / build 18362 and later. These
fields are optional diagnostic metadata: they are omitted on older Windows versions or when the API
call fails. Capture availability should still be decided from `granted`, `status`, and the
stream-open `rawResult`.

| Status | Meaning | Typical action |
| --- | --- | --- |
| `granted` | Permission/backend checks succeeded. | Start capture. |
| `denied` | The OS returned a permission-denied result. | Ask the user to enable permission in system settings. |
| `restricted` | The OS, policy, platform, or app declaration blocks the requested permission. | Show a blocked-by-system message and direct the user/admin to OS policy/settings. |
| `not-determined` | The permission has not been requested yet, or the OS reports a prompt-required state. | Ask from an explicit user action before calling a request API. |
| `unknown` | The check timed out or failed in a way that cannot be safely classified, or the path is unsupported/stale without a more specific public status. | Do not treat it as denied. Show `message`, inspect diagnostics, and retry or collect logs. |

Example results:

```js
// macOS 14.2+ CoreAudio TapGuard
{
  granted: true,
  request: 'speaker',
  permissionScope: 'system_audio',
  trackSource: 'system_audio',
  backend: 'core_audio_tap',
  status: 'granted',
  reason: 'permission-granted',
  probeStage: 'write-tap-description',
  elapsedMs: 24,
  captureHealth: 'ready',
  captureReady: true,
  message: 'Speaker capture permission is granted and the system_audio capture stream can be opened.'
}

// macOS ScreenCaptureKit fallback
{
  granted: true,
  request: 'speaker',
  permissionScope: 'screen_recording',
  trackSource: 'screen_share_audio',
  backend: 'screen_capture_kit',
  status: 'granted',
  message: 'Screen Recording permission is granted and the screen_share_audio capture stream can be opened.'
}
```

## Capture Examples

### Microphone Only

```javascript
const engine = await AudioEngine.init({
  micEnabled: true,
  speakerEnabled: false,
  enableRawAudio: true,
  processing: {
    sampleRate: 16000,
    chunkDurationMs: 20,
  },
  transport: {
    codec: 'opus',
    bitrateBps: 64000,
  },
});

const capture = engine.createCapture();

capture.start((err, chunk) => {
  if (err) return console.error(err);

  console.log({
    payload: chunk.data.microphone,
    trackSource: chunk.trackSource, // "microphone"
    rawMicSampleRate: chunk.rawAudio?.mic?.sampleRate,
  });
});
```

Output shape:

```ts
{
  data: {
    microphone: <encoded mic output>,
  },
  trackSource: 'microphone',
  codec: 'opus',
  sampleRate: 16000,
  sampleCount: 320,
  durationMs: 20,
  sample: 3200,
  timestamp: 1710000000400,
  rms: 0.012,
  rawAudio: {
    mic: { data: <pcm16 mic>, sampleRate: 48000, sample: 9600, timestamp: 1710000000400, rms: 0.012 },
    speaker: null,
    mixed: null,
  },
}
```

### Speaker Only

```javascript
const engine = await AudioEngine.init({
  micEnabled: false,
  speakerEnabled: true,
  enableRawAudio: true,
  processing: {
    sampleRate: 16000,
    chunkDurationMs: 20,
  },
  transport: {
    codec: 'opus',
    bitrateBps: 64000,
  },
});

const capture = engine.createCapture();

capture.start((err, chunk) => {
  if (err) return console.error(err);

  const speakerPayload = chunk.data.system_audio ?? chunk.data.screen_share_audio;

  console.log({
    payload: speakerPayload,
    trackSource: chunk.trackSource,
    rawSpeakerSampleRate: chunk.rawAudio?.speaker?.sampleRate,
  });
});
```

Output shape:

```ts
{
  data: {
    system_audio: <encoded speaker output>,
  },
  trackSource: 'system_audio',
  codec: 'opus',
  sampleRate: 16000,
  sampleCount: 320,
  durationMs: 20,
  sample: 3200,
  timestamp: 1710000000400,
  rms: 0.020,
  rawAudio: {
    mic: null,
    speaker: { data: <pcm16 speaker>, sampleRate: 44100, sample: 8820, timestamp: 1710000000400, rms: 0.020 },
    mixed: null,
  },
}
```

On macOS ScreenCaptureKit fallback, the speaker-only output uses:

```ts
{
  data: {
    screen_share_audio: <encoded speaker output>,
  },
  trackSource: 'screen_share_audio',
}
```

### Microphone and Speaker Mixed

```javascript
const engine = await AudioEngine.init({
  micEnabled: true,
  speakerEnabled: true,
  enableRawAudio: true,
  processing: {
    sampleRate: 16000,
    chunkDurationMs: 20,
  },
  transport: {
    codec: 'opus',
    bitrateBps: 64000,
  },
});

const capture = engine.createCapture();

capture.start((err, chunk) => {
  if (err) return console.error(err);

  console.log({
    microphone: chunk.data.microphone,
    speaker: chunk.data.speaker,
    mixed: chunk.data.mixed,
    trackSource: chunk.trackSource, // "microphone_speaker_mix"
  });
});
```

Output shape:

```ts
{
  data: {
    microphone: <encoded microphone output>,
    speaker: <encoded speaker output>,
    mixed: <encoded mixed output>,
  },
  trackSource: 'microphone_speaker_mix',
  codec: 'opus',
  sampleRate: 16000,
  sampleCount: 320,
  durationMs: 20,
  sample: 3200,
  timestamp: 1710000000400,
  rms: 0.016,
  rawAudio: {
    mic: { data: <pcm16 mic>, sampleRate: 48000, sample: 9600, timestamp: 1710000000400, rms: 0.012 },
    speaker: { data: <pcm16 speaker>, sampleRate: 44100, sample: 8820, timestamp: 1710000000400, rms: 0.020 },
    mixed: { data: <pcm16 mixed>, sampleRate: 16000, sample: 3200, timestamp: 1710000000400, rms: 0.016 },
  },
}
```

## Transport Codec Examples

### Opus

```javascript
const config = {
  micEnabled: true,
  speakerEnabled: true,
  processing: {
    sampleRate: 16000,
    chunkDurationMs: 20,
  },
  transport: {
    codec: 'opus',
    bitrateBps: 64000,
  },
};
```

`chunk.data.*` values are Opus frame bytes.

### PCM16 Little-Endian

```javascript
const config = {
  micEnabled: true,
  speakerEnabled: true,
  processing: {
    sampleRate: 16000,
    chunkDurationMs: 20,
  },
  transport: {
    codec: 'pcm_s16le',
  },
};
```

`chunk.data.*` values are signed 16-bit little-endian PCM bytes at `processing.sampleRate`.

### Float32 Little-Endian PCM

```javascript
const config = {
  micEnabled: true,
  speakerEnabled: true,
  processing: {
    sampleRate: 48000,
    chunkDurationMs: 20,
  },
  transport: {
    codec: 'pcm_f32le',
  },
};
```

`chunk.data.*` values are 32-bit float little-endian PCM bytes at `processing.sampleRate`.

## VAD

VAD is disabled by default with `vadEnabled: false`. Set `vadEnabled: true` to enable the native
Silero VAD gate and include VAD in model preload.

```javascript
const engine = await AudioEngine.init({
  micEnabled: true,
  speakerEnabled: true,
  denoiseEnabled: true,
  vadEnabled: true,
  processing: {
    sampleRate: 16000,
    chunkDurationMs: 20,
  },
});

const capture = engine.createCapture();

capture.setVadConfig({
  vadPositiveThreshold: 0.5,
  vadNegativeThreshold: 0.35,
  vadSilenceDurationMs: 550,
  vadPreSpeechBufferMs: 500,
});

capture.setVadEnabled(true);

console.log(capture.getVadConfig());
```

`VadConfig` fields are optional. Missing values use native defaults.

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `vadPositiveThreshold` | `number` | `0.5` | Speech start threshold for Silero probability. |
| `vadNegativeThreshold` | `number` | `0.35` | Speech end threshold for Silero probability. |
| `vadRmsThreshold` | `number` | `0.015` | Compatibility value. Silero-only VAD does not use RMS for speech decisions. |
| `vadSilenceDurationMs` | `number` | `550` | Keep the gate open for this long after the last speech frame. |
| `vadPreSpeechBufferMs` | `number` | `500` | Keep this much pre-speech context inside the VAD gate. |

VAD status is available from `capture.getStatus()`:

```javascript
const status = capture.getStatus();

console.log({
  vadEnabled: status.vadEnabled,
  vadReady: status.vadReady,
  vadMode: status.vadMode, // "silero" | "disabled"
  vadGateState: status.vadGateState, // "open" | "closed"
  vadProbability: status.vadProbability,
  vadRms: status.vadRms,
  vadIsSpeech: status.vadIsSpeech,
});
```

VAD-enabled output may include `vadRms` and `gateEvent`:

```ts
{
  data: {
    microphone: <encoded microphone output>,
    speaker: <encoded speaker output>,
    mixed: <encoded mixed output>,
  },
  trackSource: 'microphone_speaker_mix',
  sampleRate: 16000,
  codec: 'opus',
  sampleCount: 320,
  durationMs: 20,
  sample: 3200,
  timestamp: 1710000000400,
  rms: 0.016,
  vadRms: 0.015,
  gateEvent: 'speech_gate_opened',
}
```

## Runtime Controls

```javascript
const capture = engine.createCapture();

capture.onError((err, captureError) => {
  console.error('Capture error:', captureError.source, captureError.message);
});

capture.start((err, chunk) => {
  if (err) {
    console.error(err);
    return;
  }

  console.log(chunk.durationMs);
});

setTimeout(() => {
  capture.pause();
  console.log('Paused:', capture.getState());
}, 5000);

setTimeout(() => {
  capture.resume();
  console.log('Resumed:', capture.getState());
}, 8000);

setTimeout(() => {
  capture.setVadEnabled(false);
  console.log('VAD disabled:', capture.getStatus().vadEnabled);
}, 10000);

setTimeout(() => {
  capture.stop();
  console.log('Stopped:', capture.getState());
}, 15000);
```

## Microphone Activity Lookup

Use `getMicActiveApps()` when you only need to know which apps are currently using the microphone,
such as meeting detection. This API does not require `AudioEngine.init()`, does not create
`AudioCapture`, and does not preload denoise/VAD models.

```javascript
const { getMicActiveApps } = require('@tellus-ai/audio-sdk');

async function checkMicrophoneActivity() {
  const activeApps = await getMicActiveApps();

  for (const app of activeApps) {
    console.log(`${app.appName} is using the microphone`, {
      processId: app.processId,
      bundleId: app.bundleId ?? null,
    });
  }
}

checkMicrophoneActivity().catch(console.error);
```

## API Reference

### Exports

```ts
export {
  AudioEngine,
  AudioCapture,
  init,
  preloadModels,
  initLogging,
  listMicDevices,
  listSpeakerDevices,
  isSpeakerCaptureSupported,
  probeMicCapture,
  checkMicCapturePermission,
  checkMicCapturePermissionInfo,
  checkSpeakerCapturePermissionInfo,
  probeSpeakerCapturePermissionInfo,
  requestInitialMicrophonePermissionOpen,
  requestMicrophonePermission,
  requestInitialSystemAudioPermissionOpen,
  requestSystemAudioPermission,
  requestScreenCapturePermission,
  getMicActiveApps,
  getDefaultInputDevice,
  getDefaultSpeakerDevice,
  isBuiltInSpeaker,
};
```

### `AudioEngine`

```ts
class AudioEngine {
  static init(
    config?: AudioCaptureConfig | null,
    options?: AudioEngineInitOptions | null,
  ): Promise<AudioEngine>;

  createCapture(): AudioCapture;
  getStatus(): AudioEngineInitStatus;
}
```

| Method | Description |
| --- | --- |
| `AudioEngine.init(config?, options?)` | Initializes the engine, validates config, runs post-init model preload unless `options.preloadModels === false`, and returns an engine instance. |
| `createCapture()` | Creates a new `AudioCapture` using the config passed to `AudioEngine.init()`. |
| `getStatus()` | Returns the init status captured by the engine instance. |

### `AudioCapture`

```ts
class AudioCapture {
  constructor(config?: AudioCaptureConfig | null);
  createAuthorizationRequest(conversationId: string): EngineAuthorizationRequest;
  applyAuthorization(token: string): EngineAuthorizationStatus;
  getAuthorizationStatus(): EngineAuthorizationStatus;
  invalidateAuthorization(): void;
  onError(callback: (err: Error | null, arg: CaptureError) => unknown): void;
  start(callback: (err: Error | null, arg: AudioChunk) => unknown): void;
  pause(): void;
  resume(): void;
  stop(): void;
  getState(): 'idle' | 'recording' | 'paused' | 'error' | string;
  getStatus(): CaptureStatus;
  getMicDevices(): string[];
  isSpeakerSupported(): boolean;
  setVadEnabled(enabled: boolean): void;
  setVadConfig(config: VadConfig): void;
  getVadConfig(): VadConfig;
}
```

Register `onError()` before `start()` so native source, mixer, or thread errors can be surfaced to
your app.

### Standalone Functions

| Function | Description |
| --- | --- |
| `init(config?, options?)` | Initializes the native engine. `options.preloadModels` defaults to `true`. |
| `preloadModels(config?)` | Preloads enabled FastEnhancer denoise and Silero VAD models after core init. |
| `initLogging(level?)` | Initializes native tracing, for example `audio_capture=info`. |
| `listMicDevices()` | Lists available microphone devices. |
| `listSpeakerDevices()` | Lists available speaker/output devices. |
| `isSpeakerCaptureSupported()` | Returns whether speaker/system-audio capture is supported on the current platform. |
| `probeMicCapture()` | Legacy boolean microphone probe. Prefer `checkMicCapturePermissionInfo()` for new UI and diagnostics. |
| `checkMicCapturePermission()` | Legacy boolean microphone permission check. |
| `checkMicCapturePermissionInfo()` | Checks microphone capture availability and returns structured permission/backend details. |
| `checkSpeakerCapturePermissionInfo()` | Passively checks speaker capture availability and returns structured permission/backend details. On macOS 14.2+ CoreAudio `system_audio`, this can return `unknown` without prompting. |
| `probeSpeakerCapturePermissionInfo()` | Actively probes speaker capture and returns structured permission/backend details. On macOS 14.2+ CoreAudio `system_audio`, this can show the System Audio Recording prompt and verifies capture with a quiet test tone. |
| `requestInitialMicrophonePermissionOpen()` | Opens the microphone permission path and returns `{ opened, error? }`. Use from an explicit user action when prompting is possible. |
| `requestMicrophonePermission()` | Requests or opens microphone permission and returns `{ opened, error? }`. |
| `requestInitialSystemAudioPermissionOpen()` | Opens the initial system-audio permission path and returns `{ opened, error? }`. |
| `requestSystemAudioPermission()` | Requests or opens system-audio permission and returns `{ opened, error? }`. |
| `requestScreenCapturePermission()` | Requests or opens Screen Recording permission for ScreenCaptureKit fallback and returns `{ opened, error? }`. |
| `getMicActiveApps()` | Returns apps currently using the microphone. |
| `getDefaultInputDevice()` | Returns the current OS default input device name, or `null`. |
| `getDefaultSpeakerDevice()` | Returns the current OS default speaker device name, or `null`. |
| `isBuiltInSpeaker()` | Returns whether the current output device is a built-in speaker rather than headphones/earbuds. |

For speaker capture, use `checkSpeakerCapturePermissionInfo()` to discover which backend and
permission scope are active. Run request/probe APIs only from explicit user actions, then re-check
permission state instead of treating the request return value as a durable cache.

### `AudioCaptureConfig`

```ts
interface AudioCaptureConfig {
  micEnabled?: boolean;
  speakerEnabled?: boolean;
  enableRawAudio?: boolean;
  denoiseEnabled?: boolean;
  vadEnabled?: boolean;
  processing?: AudioProcessingConfig;
  transport?: AudioTransportConfig;
}

interface AudioProcessingConfig {
  sampleRate?: number;
  chunkDurationMs?: number;
}

interface AudioTransportConfig {
  codec?: 'opus' | 'pcm_s16le' | 'pcm_f32le';
  bitrateBps?: number;
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `micEnabled` | `boolean` | `true` | Enable microphone capture. |
| `speakerEnabled` | `boolean` | `false` | Enable speaker/system-audio capture. |
| `enableRawAudio` | `boolean` | `false` | Include synchronized PCM16 raw frames in `chunk.rawAudio`. |
| `denoiseEnabled` | `boolean` | `true` | Enable FastEnhancer denoise for captured audio. |
| `vadEnabled` | `boolean` | `false` | Enable the native Silero VAD gate and include VAD in model preload. |
| `processing.sampleRate` | `number` | `16000` | Processing, mixer, and transport sample rate. |
| `processing.chunkDurationMs` | `number` | `20` | Final transport chunk duration in milliseconds. |
| `transport.codec` | `'opus' \| 'pcm_s16le' \| 'pcm_f32le'` | `'opus'` | Final transport payload codec/format. |
| `transport.bitrateBps` | `number` | `undefined` | Opus target bitrate. Valid only when `transport.codec` is `'opus'`. |

At least one of `micEnabled` or `speakerEnabled` must be true.

### `AudioEngineInitStatus`

```ts
interface AudioEngineInitStatus {
  initialized: boolean;
  reused: boolean;
  modelsPreloaded: boolean;
  processingSampleRate: number;
  chunkDurationMs: number;
  denoise: AudioEngineDenoiseInitStatus;
  vad: AudioEngineVadInitStatus;
  dsp: AudioEngineDspInitStatus;
}
```

```ts
interface AudioEngineModelsPreloadStatus {
  denoise: AudioEngineDenoiseInitStatus;
  vad: AudioEngineVadInitStatus;
}

interface AudioEngineDenoiseInitStatus {
  enabled: boolean;
  active: boolean;
  reused: boolean;
  model: string;
  modelDir?: string;
  sampleRateHz: number;
  preparedInstances: number;
  warmupMs: number;
}

interface AudioEngineVadInitStatus {
  enabled: boolean;
  active: boolean;
  ready: boolean;
  reused: boolean;
  model: string;
  modelDir?: string;
  sampleRateHz: number;
  warmupMs: number;
}

interface AudioEngineDspInitStatus {
  enabled: boolean;
  dcRemovalEnabled: boolean;
  hpfEnabled: boolean;
  micAgc2Enabled: boolean;
  limiterEnabled: boolean;
}
```

### `AudioChunk`

```ts
type AudioTrackSource =
  | 'microphone'
  | 'screen_share_audio'
  | 'system_audio'
  | 'microphone_speaker_mix';

interface AudioChunk {
  data: AudioData;
  trackSource: AudioTrackSource;
  sampleRate: number;
  codec: 'opus' | 'pcm_s16le' | 'pcm_f32le';
  sampleCount: number;
  durationMs: number;
  sample: number;
  timestamp: number;
  rms: number;
  gateEvent?: string;
  vadRms?: number;
  rawAudio?: RawAudioBundle;
}
```

| Property | Description |
| --- | --- |
| `data` | Final transport payloads keyed by source. |
| `trackSource` | Primary output source label. |
| `sampleRate` | Final transport sample rate. |
| `codec` | Final transport payload codec/format. |
| `sampleCount` | Decoded PCM sample count represented by this chunk. A 20ms chunk at 16kHz has 320 samples. |
| `durationMs` | Media duration represented by this chunk. Prefer this over payload byte length for timing. |
| `sample` | Processing sample cursor at the start of the chunk. |
| `timestamp` | Unix epoch timestamp in milliseconds. |
| `rms` | RMS level, `0.0` to `1.0`. |
| `gateEvent` | VAD gate transition event, usually absent on regular chunks. |
| `vadRms` | RMS measured on the VAD input chunk. Present when VAD is enabled. |
| `rawAudio` | Raw PCM16 frames when `enableRawAudio: true`. |

### `AudioData`

```ts
interface AudioData {
  microphone?: Buffer;
  system_audio?: Buffer;
  screen_share_audio?: Buffer;
  speaker?: Buffer;
  mixed?: Buffer;
}
```

| Source configuration | `trackSource` | Payload keys |
| --- | --- | --- |
| `micEnabled: true`, `speakerEnabled: false` | `microphone` | `data.microphone` |
| `micEnabled: false`, `speakerEnabled: true` with system-audio backend | `system_audio` | `data.system_audio` |
| `micEnabled: false`, `speakerEnabled: true` with ScreenCaptureKit fallback | `screen_share_audio` | `data.screen_share_audio` |
| `micEnabled: true`, `speakerEnabled: true` | `microphone_speaker_mix` | `data.microphone`, `data.speaker`, `data.mixed` |

### `RawAudioBundle`

```ts
interface RawAudioFrame {
  data: Buffer;
  sampleRate: number;
  sample: number;
  timestamp: number;
  rms: number;
}

interface RawAudioBundle {
  mic?: RawAudioFrame | null;
  speaker?: RawAudioFrame | null;
  mixed?: RawAudioFrame | null;
}
```

| Property | Source behavior |
| --- | --- |
| `mic` | Present when `micEnabled: true`; uses the original microphone device sample rate. |
| `speaker` | Uses the original speaker device sample rate when actual speaker PCM is available; may be `null` temporarily even when `speakerEnabled: true`. |
| `mixed` | Present when both mic and speaker are enabled; uses `processing.sampleRate`. |

Disabled sources are `null`. An enabled speaker can also be temporarily `null` until actual PCM
arrives. Once a source callback exists, a genuinely silent source is represented by a PCM frame
whose samples may all be zero.

### `CaptureStatus`

```ts
interface CaptureStatus {
  state: string;
  micThreadAlive: boolean;
  speakerThreadAlive: boolean;
  mixerThreadAlive: boolean;
  denoiseActive: boolean;
  aecActive: boolean;
  vadEnabled: boolean;
  vadReady: boolean;
  vadMode: string;
  vadGateState: string;
  vadProbability: number;
  vadRms: number;
  vadIsSpeech: boolean;
  vadPositiveThreshold: number;
  vadNegativeThreshold: number;
  vadRmsThreshold: number;
  vadSilenceDurationMs: number;
  vadPreSpeechBufferMs: number;
}
```

Use `getStatus()` for diagnostics, UI state, and runtime health checks. Use `getState()` when only
the state string is needed.

### `CaptureError`

```ts
interface CaptureError {
  source: string; // "mic", "speaker", "mixer", or another native source label
  message: string;
  recoverable: boolean;
}
```

## Platform Notes

### macOS Microphone Permission

Electron apps need microphone permission when `micEnabled: true`. The permission belongs to the
final `.app` bundle, not this npm package, because the native addon runs inside the Electron app
process. Add an `Info.plist` usage description:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>This app needs microphone access for audio capture.</string>
```

For sandboxed or Mac App Store builds, also allow audio input in the app entitlements:

```xml
<key>com.apple.security.device.audio-input</key>
<true/>
```

In Electron, add the usage description through your packager configuration. For `electron-builder`:

```json
{
  "build": {
    "mac": {
      "extendInfo": {
        "NSMicrophoneUsageDescription": "This app needs microphone access for audio capture."
      }
    }
  }
}
```

### macOS Speaker Capture Permission

Speaker capture can use either:

- CoreAudio TapGuard: `permissionScope: 'system_audio'`, `trackSource: 'system_audio'`.
- ScreenCaptureKit fallback: `permissionScope: 'screen_recording'`, `trackSource: 'screen_share_audio'`.

Electron apps that enable speaker/system-audio capture should include a system-audio usage
description in the final `.app` bundle:

```xml
<key>NSAudioCaptureUsageDescription</key>
<string>This app needs system audio access for speaker capture.</string>
```

On macOS 14.2 and later, the CoreAudio tap path requests System Audio Recording permission when the
tap-backed capture stream is first opened. `checkSpeakerCapturePermissionInfo()` does not open this
tap. `probeSpeakerCapturePermissionInfo()` or the first speaker-enabled `AudioCapture.start()` can
trigger the prompt, depending on which call first opens the backend.

Because Apple doesn't expose a public authorization-status API for CoreAudio TapGuard system-audio
permission, the passive check returns `unknown` for that path. The active probe opens the tap and
uses IOProc creation plus Tap description read/write access as the permission gate. After
permission succeeds, it plays a 997 Hz tone at about -70 dBFS for about one second and detects that
tone as a separate capture-health check. This is intended to be below normal audibility, but users
with high output volume or sensitive output devices may faintly hear it during active probes.

A silent or failed health check does not change a successful permission result to `denied`.
Inspect `captureHealth`, `captureReady`, and `captureError` when `granted` is `true`. A probe that
waits about 60 seconds without a conclusive CoreAudio result is returned as `status: 'unknown'`
with `reason: 'io-proc-timeout'`; it must not be treated as a denial.

Speaker permission checks intentionally expose no boolean compatibility API. If the structured
native probe is unavailable or returns an invalid shape, the SDK returns `status: 'unknown'` with
`reason: 'structured-permission-api-unavailable'` (or an invalid-result reason) instead of guessing
that permission was denied.

Older macOS versions can fall back to ScreenCaptureKit, where the active scope is Screen Recording
permission. In that case the app must appear under System Settings > Privacy & Security > Screen
Recording, and users usually need to restart the app after changing the permission.

Call `checkSpeakerCapturePermissionInfo()` before starting capture to see which backend and
permission scope are active. Call `probeSpeakerCapturePermissionInfo()` only from explicit user
actions that are allowed to prompt.

When the active backend is the ScreenCaptureKit fallback, use the same check-then-request flow:

```javascript
const speaker = checkSpeakerCapturePermissionInfo();

if (speaker.permissionScope === 'screen_recording' && !speaker.granted) {
  const requested = probeSpeakerCapturePermissionInfo();
  console.log('Screen Recording request/probe result:', requested);

  const refreshed = checkSpeakerCapturePermissionInfo();
  console.log('Screen Recording state after request:', refreshed);
}
```

Do not assume the request/probe return value is the final Screen Recording state. macOS can require
the app to be restarted or the permission to be re-checked after System Settings changes.

If `status` is `unknown` and the message mentions stale Screen Recording state, ask the user to
re-grant Screen Recording permission and restart the app. If `status` is `denied`, ask the user to
enable the relevant permission in System Settings.

For `electron-builder`, include both microphone and system-audio purpose strings when the app can
capture both inputs:

```json
{
  "build": {
    "mac": {
      "extendInfo": {
        "NSMicrophoneUsageDescription": "This app needs microphone access for audio capture.",
        "NSAudioCaptureUsageDescription": "This app needs system audio access for speaker capture."
      }
    }
  }
}
```

For Electron Forge or direct `electron-packager` usage, set `packagerConfig.extendInfo` to an object
or to a plist file that contains the same keys.

### Windows

Speaker capture uses WASAPI loopback. If no audio is captured:

- Confirm an output device is enabled.
- Check that the target app is not using exclusive audio mode.
- Check `isSpeakerCaptureSupported()` and `checkSpeakerCapturePermissionInfo()`.

### Linux

Speaker capture uses PulseAudio monitor devices. Ensure PulseAudio-compatible audio routing is
available in the runtime environment.

## Development

Runtime, installer, and verification source lives under `src/` and is built into `dist/` before
publishing. The npm package exposes only the root entrypoint through `exports`; internal runtime and
installer files are not public import paths.

```bash
npm run build
npm run check:js
npm run check:package
```

## Troubleshooting

### Native Binary Not Found

If loading fails with a native binary error, run:

```bash
npm run install:binary
npm run check:binary
```

Also verify that `TELLUS_AUDIO_ENGINE_TOKEN` has access to the private native engine release.

### Model or ONNX Runtime Load Failure

The SDK normally resolves bundled model and ONNX Runtime paths automatically. If your app packages
assets into a custom location, set:

```bash
export TELLUS_AUDIO_ENGINE_MODEL_DIR="/path/to/models"
export ORT_DYLIB_PATH="/path/to/onnxruntime"
```

### Permission Check Succeeds But No Audio Is Heard

Permission and capture health are separate. For CoreAudio TapGuard `system_audio`, the permission
gate uses IOProc and Tap access, while the SDK injects its own quiet probe tone for the subsequent
health check. User playback is not required. For microphone, Windows loopback, Linux monitor, and
ScreenCaptureKit fallback paths, a silent microphone or no system playback can still produce
successful permission checks.

Use `chunk.rms`, `chunk.rawAudio`, and the selected `trackSource` to diagnose whether audio is
actually present during capture.

## License

MIT
