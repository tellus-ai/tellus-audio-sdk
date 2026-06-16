# Tellus Audio SDK

Node.js/Electron wrapper for the Tellus native audio engine.

This repository contains the public TypeScript wrapper source, built JavaScript package entrypoint, TypeScript declarations, and installer scripts only. Native binaries are distributed separately through GitHub Releases.

## Install

```bash
npm install git+https://github.com/tellus-ai/tellus-audio-sdk.git#v0.1.3
```

Installing from GitHub uses the public `tellus-ai/tellus-audio-sdk` repository. The package `prepare` step builds the TypeScript wrapper before npm packs the git dependency.

The postinstall step downloads the native binary for the current platform, verifies its SHA-256 checksum, and installs it under `vendor/<platform>/`.
This SDK repository may be public, but the native Tellus audio engine release is private. Installation requires a Tellus-issued GitHub token with access to the engine release assets.

The required native engine version is pinned in `release-assets.json`:

```json
{
  "sdkVersion": "0.1.3",
  "nativeEngineVersion": "0.2.5",
  "nativeEngineTag": "v0.2.5"
}
```

The installer validates that the manifest matches the installed SDK package version and that artifact file names include the pinned native engine tag. Download URLs are resolved from the private GitHub Release by exact asset file name.

Provide the token explicitly before install:

```bash
export TELLUS_AUDIO_ENGINE_TOKEN="..."
npm install git+https://github.com/tellus-ai/tellus-audio-sdk.git#v0.1.3
```

Alternatively, place the token in the installing project's `.env` file:

```dotenv
TELLUS_AUDIO_ENGINE_TOKEN=...
```

## Environment Variables

| Name | Description |
| --- | --- |
| `TELLUS_AUDIO_ENGINE_TOKEN` | Bearer token for private GitHub Release asset downloads. The installer also reads this single key from the installing project's `.env` file. |

Only `TELLUS_AUDIO_ENGINE_TOKEN` is read from `.env`; other `.env` keys are ignored.

## Usage

```javascript
const { AudioCapture, listMicDevices, isSpeakerCaptureSupported } = require('@tellus-ai/audio-sdk');

const devices = listMicDevices();
console.log('Microphones:', devices);
console.log('Speaker supported:', isSpeakerCaptureSupported());

const capture = new AudioCapture({
  micEnabled: true,
  speakerEnabled: true,
  enableRawAudio: true,
  vadEnabled: true,
  processing: {
    sampleRate: 16000,
    chunkDurationMs: 20,
  },
  transport: {
    codec: 'opus',
    bitrateBps: 64000,
  },
});

capture.onError((err, captureError) => {
  console.error('Capture error:', captureError.source, captureError.message);
});

capture.start((err, chunk) => {
  if (err) {
    console.error(err);
    return;
  }

  const payload =
    chunk.data.mixed ??
    chunk.data.microphone ??
    chunk.data.system_audio ??
    chunk.data.screen_share_audio;

  console.log({
    bytes: payload?.length ?? 0,
    trackSource: chunk.trackSource,
    codec: chunk.codec,
    sampleCount: chunk.sampleCount,
    durationMs: chunk.durationMs,
    rms: chunk.rms,
    vadRms: chunk.vadRms ?? null,
    gateEvent: chunk.gateEvent ?? null,
    micSampleRate: chunk.rawAudio?.mic?.sampleRate ?? null,
    speakerSampleRate: chunk.rawAudio?.speaker?.sampleRate ?? null,
  });
});
```

`rawAudio.mic` and `rawAudio.speaker` are PCM16 little-endian frames at the original device sample
rate. For example, a 48kHz microphone returns `rawAudio.mic.sampleRate === 48000` even when the
capture config uses `processing.sampleRate: 16000`. `rawAudio.mixed` is a derived mix and uses the
configured processing/mixer sample rate.

`chunk.data` contains final transport payloads keyed by source. Mic-only output uses
`chunk.data.microphone`, speaker-only output usually uses `chunk.data.system_audio`, macOS
ScreenCaptureKit fallback output uses `chunk.data.screen_share_audio`, and mic+speaker output uses
`chunk.data.microphone`, `chunk.data.speaker`, and `chunk.data.mixed`. `chunk.trackSource` labels
the primary payload. `chunk.codec`, `chunk.sampleRate`, `chunk.sampleCount`, and
`chunk.durationMs` describe the final transport payloads in `chunk.data`.

### Engine Initialization and Capture Lifecycle

Use `init()` when you want to initialize the native audio engine before creating a capture session
and inspect the initialized processing/DSP status. `initLogging()` is optional and should be called
early if you want native engine logs.

```javascript
const {
  AudioCapture,
  checkMicCapturePermission,
  checkSystemAudioCapturePermission,
  getDefaultInputDevice,
  getDefaultOutputDevice,
  init,
  initLogging,
  isSpeakerCaptureSupported,
  listMicDevices,
  requestSystemAudioCapturePermission,
} = require('@tellus-ai/audio-sdk');

const captureConfig = {
  micEnabled: true,
  speakerEnabled: true,
  enableRawAudio: true,
  vadEnabled: true,
  microphoneLevelMode: 'agc2',
  micOutputGainDb: 0,
  processing: {
    sampleRate: 16000,
    chunkDurationMs: 20,
  },
  transport: {
    codec: 'pcm_s16le',
  },
};

initLogging('audio_capture=info');

console.log('Input devices:', listMicDevices());
console.log('Default input:', getDefaultInputDevice());
console.log('Default output:', getDefaultOutputDevice());
console.log('Speaker capture supported:', isSpeakerCaptureSupported());

if (!checkMicCapturePermission()) {
  throw new Error('Microphone capture permission is not available.');
}

if (captureConfig.speakerEnabled && !checkSystemAudioCapturePermission()) {
  const granted = requestSystemAudioCapturePermission();
  if (!granted) {
    throw new Error('System audio capture permission is not available.');
  }
}

const initStatus = init(captureConfig);
console.log('Engine initialized:', {
  initialized: initStatus.initialized,
  reused: initStatus.reused,
  processingSampleRate: initStatus.processingSampleRate,
  chunkDurationMs: initStatus.chunkDurationMs,
  denoiseActive: initStatus.denoise.active,
  dspEnabled: initStatus.dsp.enabled,
});

const capture = new AudioCapture(captureConfig);

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

  const primaryPayload =
    chunk.data.mixed ??
    chunk.data.microphone ??
    chunk.data.system_audio ??
    chunk.data.screen_share_audio;

  console.log('Audio chunk:', {
    bytes: primaryPayload?.length ?? 0,
    trackSource: chunk.trackSource,
    codec: chunk.codec,
    sampleRate: chunk.sampleRate,
    sampleCount: chunk.sampleCount,
    durationMs: chunk.durationMs,
    sample: chunk.sample,
    rms: chunk.rms,
    vadRms: chunk.vadRms ?? null,
    gateEvent: chunk.gateEvent ?? null,
    rawMicBytes: chunk.rawAudio?.mic?.data.length ?? null,
    rawSpeakerBytes: chunk.rawAudio?.speaker?.data.length ?? null,
  });
});

console.log('State after start:', capture.getState());
console.log('Status after start:', capture.getStatus());
```

### Pause, Resume, Stop, and Runtime Controls

`pause()` temporarily stops delivery from the running capture session. `resume()` continues the same
session, and `stop()` releases the native capture threads.

```javascript
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
  capture.setDenoiseAttenuation(-18);
  capture.setMicDenoiseAttenuation(-12);
  capture.setSpeakerDenoiseAttenuation(-12);
  capture.setMicOutputGainDb(3);

  console.log('Runtime tuning:', {
    vadConfig: capture.getVadConfig(),
    denoiseAttenuationDb: capture.getDenoiseAttenuation(),
    micDenoiseAttenuationDb: capture.getMicDenoiseAttenuation(),
    speakerDenoiseAttenuationDb: capture.getSpeakerDenoiseAttenuation(),
    micOutputGainDb: capture.getMicOutputGainDb(),
    status: capture.getStatus(),
  });
}, 10000);

setTimeout(() => {
  capture.stop();
  console.log('Stopped:', capture.getState());
}, 15000);
```

Instance helpers mirror the standalone device checks:

```javascript
console.log('Capture mic devices:', capture.getMicDevices());
console.log('Capture speaker supported:', capture.isSpeakerSupported());
```

### Capture Source Examples

Mic only:

```javascript
const capture = new AudioCapture({
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
```

Output shape:

```ts
{
  data: {
    microphone: <encoded mic output>,
  },
  trackSource: "microphone",
  codec: "opus",
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

Speaker only:

```javascript
const capture = new AudioCapture({
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
```

Output shape:

```ts
{
  data: {
    system_audio: <encoded speaker output>,
  },
  trackSource: "system_audio",
  codec: "opus",
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

Mic and speaker mixed:

```javascript
const capture = new AudioCapture({
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
```

Output shape:

```ts
{
  data: {
    microphone: <encoded microphone output>,
    speaker: <encoded speaker output>,
    mixed: <encoded mixed output>,
  },
  trackSource: "microphone_speaker_mix",
  codec: "opus",
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

### Transport Codec Examples

Opus:

```javascript
const capture = new AudioCapture({
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
});
```

PCM16 little-endian:

```javascript
const capture = new AudioCapture({
  micEnabled: true,
  speakerEnabled: true,
  processing: {
    sampleRate: 16000,
    chunkDurationMs: 20,
  },
  transport: {
    codec: 'pcm_s16le',
  },
});
```

Float32 little-endian PCM:

```javascript
const capture = new AudioCapture({
  micEnabled: true,
  speakerEnabled: true,
  processing: {
    sampleRate: 48000,
    chunkDurationMs: 20,
  },
  transport: {
    codec: 'pcm_f32le',
  },
});
```

### AudioCaptureConfig

```ts
export interface AudioCaptureConfig {
  micEnabled?: boolean;
  speakerEnabled?: boolean;
  enableRawAudio?: boolean;
  vadEnabled?: boolean;
  micDeviceName?: string;
  microphoneLevelMode?: 'agc2' | 'microphone_level_max' | 'none';
  micOutputGainDb?: number;
  processing?: AudioProcessingConfig;
  transport?: AudioTransportConfig;
}

export interface AudioProcessingConfig {
  sampleRate?: number;
  chunkDurationMs?: number;
}

export interface AudioTransportConfig {
  codec?: 'opus' | 'pcm_s16le' | 'pcm_f32le';
  bitrateBps?: number;
}

export type AudioTrackSource =
  | 'microphone'
  | 'screen_share_audio'
  | 'system_audio'
  | 'microphone_speaker_mix';
```

`processing.sampleRate` controls the processing/mixer and transport sample rate. `pcm_s16le` and
`pcm_f32le` describe the sample representation only; they do not include a sample rate. `bitrateBps`
is valid only with `transport.codec: 'opus'`.

`micEnabled: true` captures microphone input. `speakerEnabled: true` captures speaker/system audio.
At least one of `micEnabled` or `speakerEnabled` must be true.

`microphoneLevelMode` controls the native microphone level policy. `micOutputGainDb` applies
SDK-internal microphone output gain to mixed/output payloads without changing OS input volume.

### VAD

VAD is enabled by default with `vadEnabled: true`. VAD speech decisions are made only by the fixed
Silero model path inside the native engine: `models/silero_vad_v6.2.onnx`. RMS is reported for
diagnostics and is not used as a fallback speech detector.

```javascript
capture.setVadEnabled(true);

capture.setVadConfig({
  vadPositiveThreshold: 0.5,
  vadNegativeThreshold: 0.35,
  vadSilenceDurationMs: 500,
  vadPreSpeechBufferMs: 200,
});

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

`VADConfig` fields are optional. Missing values use the native defaults shown below.

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `vadPositiveThreshold` | `number` | `0.5` | Speech start threshold for Silero probability. |
| `vadNegativeThreshold` | `number` | `0.35` | Speech end threshold for Silero probability. |
| `vadRmsThreshold` | `number` | `0.015` | Compatibility value. Silero-only VAD does not use RMS for speech decisions. |
| `vadSilenceDurationMs` | `number` | `500` | Keep the gate open for this long after the last speech frame. |
| `vadPreSpeechBufferMs` | `number` | `200` | Keep this much pre-speech context inside the VAD gate. |

VAD-enabled output includes `vadRms`:

```ts
{
  data: {
    microphone: <encoded microphone output>,
    speaker: <encoded speaker output>,
    mixed: <encoded mixed output>,
  },
  trackSource: "microphone_speaker_mix",
  codec: "opus",
  sampleRate: 16000,
  sampleCount: 320,
  durationMs: 20,
  sample: 3200,
  timestamp: 1710000000400,
  rms: 0.016,
  vadRms: 0.015,
  gateEvent: "speech_gate_opened",
  rawAudio: {
    mic: { data: <pcm16 mic>, sampleRate: 16000, sample: 3200, timestamp: 1710000000400, rms: 0.012 },
    speaker: { data: <pcm16 speaker>, sampleRate: 16000, sample: 3200, timestamp: 1710000000400, rms: 0.020 },
    mixed: { data: <pcm16 mixed>, sampleRate: 16000, sample: 3200, timestamp: 1710000000400, rms: 0.016 },
  },
}
```

## Public API

The public runtime API mirrors the native engine 0.2.5 contract:

- `AudioCapture`
- `init(config?)`
- `initLogging(level?)`
- `listMicDevices()`
- `isSpeakerCaptureSupported()`
- `probeMicCapture()`
- `checkMicCapturePermission()`
- `probeSpeakerCapture()`
- `checkSpeakerCapturePermission()`
- `checkSystemAudioCapturePermission()`
- `requestSystemAudioCapturePermission()`
- `getMicActiveApps()`
- `getDefaultInputDevice()`
- `getDefaultOutputDevice()`
- `isBuiltInSpeaker()`

`AudioCapture` exposes `onError`, `start`, `pause`, `resume`, `stop`, `getState`, `getStatus`,
`getMicDevices`, `isSpeakerSupported`, `setVadEnabled`, `setVadConfig`, `getVadConfig`,
`setDenoiseAttenuation`, `getDenoiseAttenuation`, `setMicDenoiseAttenuation`,
`getMicDenoiseAttenuation`, `setSpeakerDenoiseAttenuation`, `getSpeakerDenoiseAttenuation`,
`setMicOutputGainDb`, and `getMicOutputGainDb`.

## Development

Runtime, installer, and verification source lives under `src/` and is built into `dist/` before publishing. The npm package exposes only the root entrypoint through `exports`; internal runtime and installer files are not public import paths. npm lifecycle commands call the built CLI files under `dist/installer/`.

```bash
npm run build
npm run check:js
npm run check:package
```

## License

MIT
