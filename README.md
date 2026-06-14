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
  sampleRate: 16000,
  chunkDurationMs: 20,
  audioCodec: 'opus',
  enableMic: true,
  enableSpeaker: false,
});

capture.onError((err, captureError) => {
  console.error('Capture error:', captureError.source, captureError.message);
});

capture.start((err, chunk) => {
  if (err) {
    console.error(err);
    return;
  }

  console.log(chunk.source, chunk.data.length, chunk.rms);
});
```

## Public API

The public runtime API is intentionally small:

- `AudioCapture`
- `listMicDevices()`
- `isSpeakerCaptureSupported()`

`AudioCapture` exposes `onError`, `start`, `pause`, `resume`, `stop`, and `getState`.

## Development

Runtime, installer, and verification source lives under `src/` and is built into `dist/` before publishing. The npm package exposes only the root entrypoint through `exports`; internal runtime and installer files are not public import paths. npm lifecycle commands call the built CLI files under `dist/installer/`.

```bash
npm run build
npm run check:js
npm run check:package
```

## License

MIT
