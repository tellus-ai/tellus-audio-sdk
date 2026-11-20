# SDK speech detection public API

## Intent and approved behavior

Extend the previously approved engine speech-only design to the desktop, web, and React Native SDK packages. Applications can observe whether the microphone user is speaking without initializing capture, requesting a server capture permit, or obtaining capture model keys. Only `{ speaking: boolean, timestampMs: number }` is delivered. OS microphone permission and normal SDK installation authentication still apply.

The engine combines 32 Silero frames into a 1.024-second window; entering speech requires at least 50% speech, leaving requires below 20%. The first complete window and subsequent state changes emit events. SDK code must reuse the released engine implementation and preserve its timing and state machine.

Authorized capture preempts pending/running detection, waits for microphone release, and retains priority while starting/running/paused. A running detector receives `speech_detection_preempted_by_capture` once; a pending start rejects without a terminal callback. Rejected authorization/configuration does not stop detection. Capture completion does not automatically restart detection. Stop/dispose discard late events.

## Approach

Port the relevant runtime/bridge changes from engine tag `v0.4.10` into the SDK's existing self-contained runtime layout, preserving SDK-specific compatibility handling. This follows the current SDK architecture. Depending on a separate engine JS package does not match SDK packaging; reimplementing the detector would duplicate the already approved algorithm and lifecycle.

## Public surface

- Desktop: exported `SpeechDetector`, `new SpeechDetector()`, synchronous `start(callback, deviceId?)` and `stop()`; no AudioEngine initialization prerequisite.
- Web: exported `SpeechDetector.init(BrowserSpeechDetectorAssets)`, async start/stop/dispose. Assets include engine/ORT locations and `speechDetectionModelUrl`, without encrypted model URLs or permit data.
- React Native: exported `SpeechDetector.init(NativeSpeechDetectorAssets?)`, async start/stop/dispose. Default model name is `silero_vad_v6.2.onnx` in the existing SDK resource bundle/assets folder.
- Export event/callback/asset types from the respective package root. Event callbacks must account for errors without an event. Follow existing platform lifecycle conventions rather than inventing a second uniform wrapper.

## Packaging and compatibility

Pin native engine metadata and archive names to the already released `0.4.10`; retain the SDK's current version pending its normal release process. Include the plaintext detection model and Silero notice in required web/mobile payloads. Web asset copying includes the detection worker and its imports. iOS resource bundles and Android asset synchronization flatten the detection model into the resource name the engine bridge resolves, while keeping capture TEMC resources intact.

Port mobile Nitro specs, generated registration, C++ detection/priority code, and OS microphone/model loaders together. Preserve SDK-specific weak symbol handling, capture device normalization, and existing callers. Required resource failures and unsupported engines fail explicitly; never fall back to unauthorized AudioCapture. No changes to the engine repository, authorization services, installation token policy, publishing credentials, or engine algorithm.

## Acceptance

Root imports and emitted declarations expose the feature in all three assembled/npm-packed packages. Token-free detection emits only the two event fields. Tests cover normal detection lifecycle, preemption during pending/running start, rejection preserving an existing detector, capture pause priority, explicit restart, stop/dispose races, and default/custom resources. Installer/copy tests verify missing-model failure before copying, POSIX/Windows path behavior, archive names, model/notice inclusion, and existing resources. Run the SDK's full pre-commit command and meaningful real-engine/native integration checks; report actual device limits precisely.
