# Tellus Audio SDK

Node.js/Electron SDK for the Tellus native audio engine.

This package provides a public JavaScript/TypeScript entrypoint for low-latency microphone,
speaker/system-audio capture, denoise model preload, Silero VAD gating, transport encoding, and
runtime capture control. Native binaries are distributed separately through GitHub Releases and are
installed into `vendor/<platform>/` during package installation.

## Requirements

- Node.js 18 or later.
- A Tellus-issued GitHub token with access to the private native engine release assets.
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

Set the private release token before installation:

```bash
export TELLUS_AUDIO_ENGINE_TOKEN="..."
npm install git+https://github.com/tellus-ai/tellus-audio-sdk.git#v0.1.14
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
  "sdkVersion": "0.1.14",
  "nativeEngineVersion": "0.2.14",
  "nativeEngineTag": "v0.2.14"
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
| `TELLUS_AUDIO_ENGINE_TOKEN` | Bearer token for private GitHub Release asset downloads. The installer also reads this single key from the installing project's `.env` file. |
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

async function main() {
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
      rawMicBytes: chunk.rawAudio?.mic?.data.length ?? null,
      rawSpeakerBytes: chunk.rawAudio?.speaker?.data.length ?? null,
      rawMixedBytes: chunk.rawAudio?.mixed?.data.length ?? null,
    });
  });
}

main().catch(console.error);
```

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
5. Call `capture.start(...)`.
6. Call `capture.stop()` when the session ends.

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
- `rawAudio.speaker`: speaker PCM16 at the original speaker device sample rate.
- `rawAudio.mixed`: mixed PCM16 at `processing.sampleRate`.

For example, a 48kHz microphone can return `rawAudio.mic.sampleRate === 48000` even when the final
transport payload uses `processing.sampleRate: 16000`.

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
- macOS 14.2+ CoreAudio TapGuard `system_audio` active probes play a short, quiet probe tone and
  verify that the tone is captured through the tap.
- Windows and Linux speaker checks verify that the loopback/monitor stream can be opened.

Use `checkSpeakerCapturePermissionInfo()` at app startup or on passive status screens. Use
`probeSpeakerCapturePermissionInfo()` from an explicit user action such as a permission request
button. For CoreAudio TapGuard active probes, `granted` means the SDK captured its own probe tone
through the system-audio path. It does not require the user or another app to be playing audio.

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

Use `result.granted` for simple branching. Use `result.status`, `result.permissionScope`,
`result.trackSource`, `result.backend`, `result.message`, and `result.error` when UI or logs need to
explain what happened.

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
| `granted` | `true` when the requested permission check succeeds. For CoreAudio TapGuard this means the probe tone was captured. |
| `request` | SDK-level request: `microphone` or `speaker`. |
| `permissionScope` | OS/platform permission scope involved in the check. |
| `trackSource` | `AudioChunk.trackSource` used by successful capture. |
| `backend` | Native backend used for the check. |
| `status` | Stable machine-readable status for branching. |
| `message` | Human-readable English explanation for logs or UI. |
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
| `denied` | The OS denied the requested permission, or CoreAudio TapGuard could not capture the probe tone. | Ask the user to enable permission in system settings. |
| `restricted` | The OS, policy, platform, or app declaration blocks the requested permission. | Show a blocked-by-system message and direct the user/admin to OS policy/settings. |
| `not-determined` | The permission has not been requested yet, or the OS reports a prompt-required state. | Ask from an explicit user action before calling a request API. |
| `unknown` | The check failed in a way that cannot be safely classified, or the path is unsupported/stale without a more specific public status. | Show `message`, inspect `error`, and retry or collect diagnostics. |

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
  probeSpeakerCapture,
  checkSpeakerCapturePermission,
  checkSpeakerCapturePermissionInfo,
  probeSpeakerCapturePermissionInfo,
  checkSystemAudioCapturePermission,
  checkSystemAudioCapturePermissionInfo,
  requestSystemAudioCapturePermission,
  requestInitialMicrophonePermissionOpen,
  requestMicrophonePermission,
  requestInitialSystemAudioPermission,
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
| `probeSpeakerCapture()` | Legacy boolean speaker probe. Prefer `probeSpeakerCapturePermissionInfo()` for new UI and diagnostics. |
| `checkSpeakerCapturePermission()` | Legacy boolean speaker permission check. |
| `checkSpeakerCapturePermissionInfo()` | Passively checks speaker capture availability and returns structured permission/backend details. On macOS 14.2+ CoreAudio `system_audio`, this can return `unknown` without prompting. |
| `probeSpeakerCapturePermissionInfo()` | Actively probes speaker capture and returns structured permission/backend details. On macOS 14.2+ CoreAudio `system_audio`, this can show the System Audio Recording prompt and verifies capture with a quiet test tone. |
| `checkSystemAudioCapturePermission()` | Deprecated alias for `checkSpeakerCapturePermission()`. |
| `checkSystemAudioCapturePermissionInfo()` | Deprecated alias for `checkSpeakerCapturePermissionInfo()`. |
| `requestSystemAudioCapturePermission()` | Legacy boolean request/probe path for system-audio permission on supported macOS paths. |
| `requestInitialMicrophonePermissionOpen()` | Opens the microphone permission path and returns `{ opened, error? }`. Use from an explicit user action when prompting is possible. |
| `requestMicrophonePermission()` | Requests or opens microphone permission and returns `{ opened, error? }`. |
| `requestInitialSystemAudioPermission()` | Legacy boolean initial system-audio request. |
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
| `speaker` | Present when `speakerEnabled: true`; uses the original speaker device sample rate. |
| `mixed` | Present when both mic and speaker are enabled; uses `processing.sampleRate`. |

Disabled sources are `null`. Enabled but silent sources can still return PCM silence buffers.

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
tap. `probeSpeakerCapturePermissionInfo()`, `requestSystemAudioCapturePermission()`, or the first
speaker-enabled `AudioCapture.start()` can trigger the prompt, depending on which call first opens
the backend.

Because Apple doesn't expose a public authorization-status API for CoreAudio TapGuard system-audio
permission, the passive check returns `unknown` for that path. The active probe opens the tap,
plays a 997 Hz tone at about -70 dBFS for about one second, and detects that tone in the captured
stream. This is intended to be below normal audibility, but users with high output volume or
sensitive output devices may faintly hear it during active probes.

`requestSystemAudioCapturePermission()` returns `true` when the system-audio probe succeeds and
`false` when the permission is denied or blocked. Other setup failures are surfaced through the
structured permission result or thrown by the native binding, depending on the API used.

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

Permission checks verify permission/backend readiness, not the loudness of the user's meeting audio.
For CoreAudio TapGuard `system_audio`, the SDK injects its own quiet probe tone, so user playback is
not required for the permission check. For microphone, Windows loopback, Linux monitor, and
ScreenCaptureKit fallback paths, a silent microphone or no system playback can still produce
successful permission checks.

Use `chunk.rms`, `chunk.rawAudio`, and the selected `trackSource` to diagnose whether audio is
actually present during capture.

## License

MIT
