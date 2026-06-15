# Tellus Audio SDK

Node.js/Electron wrapper for the Tellus native audio engine.

This repository contains the public TypeScript wrapper source, built JavaScript package entrypoint, TypeScript declarations, and installer scripts only. Native binaries are distributed separately through GitHub Releases.

## Install

```bash
npm install git+https://github.com/tellus-ai/tellus-audio-sdk.git#v0.1.1
```

Installing from GitHub uses the public `tellus-ai/tellus-audio-sdk` repository. The package `prepare` step builds the TypeScript wrapper before npm packs the git dependency.

The postinstall step downloads the native binary for the current platform, verifies its SHA-256 checksum, and installs it under `vendor/<platform>/`.
This SDK repository may be public, but the native Tellus audio engine release is private. Installation requires a Tellus-issued GitHub token with access to the engine release assets.

The required native engine version is pinned in `release-assets.json`:

```json
{
  "sdkVersion": "0.1.1",
  "nativeEngineVersion": "0.2.2",
  "nativeEngineTag": "v0.2.2"
}
```

The installer validates that the manifest matches the installed SDK package version and that artifact file names include the pinned native engine tag. Download URLs are resolved from the private GitHub Release by exact asset file name.

Provide the token explicitly before install:

```bash
export TELLUS_AUDIO_ENGINE_TOKEN="..."
npm install git+https://github.com/tellus-ai/tellus-audio-sdk.git#v0.1.1
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

  console.log({
    bytes: chunk.data.length,
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
  data: <encoded mic output>,
  sampleRate: 16000,
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
  data: <encoded speaker output>,
  sampleRate: 16000,
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
  data: <encoded mixed output>,
  sampleRate: 16000,
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
  processing?: AudioProcessingConfig;
  transport?: AudioTransportConfig;
}

export interface AudioProcessingConfig {
  sampleRate?: number;
  chunkDurationMs?: number;
}

export type AudioTransportConfig =
  | { codec: 'opus'; bitrateBps?: number }
  | { codec: 'pcm_s16le' }
  | { codec: 'pcm_f32le' };
```

`processing.sampleRate` controls the processing/mixer and transport sample rate. `pcm_s16le` and
`pcm_f32le` describe the sample representation only; they do not include a sample rate. `bitrateBps`
is valid only with `transport.codec: 'opus'`.

`micEnabled: true` captures microphone input. `speakerEnabled: true` captures speaker/system audio.
At least one of `micEnabled` or `speakerEnabled` must be true.

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
  data: <encoded mixed output>,
  sampleRate: 16000,
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

The public runtime API is intentionally small:

- `AudioCapture`
- `listMicDevices()`
- `isSpeakerCaptureSupported()`

`AudioCapture` exposes `onError`, `start`, `pause`, `resume`, `stop`, `getState`, `getStatus`,
`setVadEnabled`, `setVadConfig`, and `getVadConfig`.

## Development

Runtime, installer, and verification source lives under `src/` and is built into `dist/` before publishing. The npm package exposes only the root entrypoint through `exports`; internal runtime and installer files are not public import paths. npm lifecycle commands call the built CLI files under `dist/installer/`.

```bash
npm run build
npm run check:js
npm run check:package
```

## License

MIT
