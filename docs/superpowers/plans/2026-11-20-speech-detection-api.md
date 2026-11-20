# SDK Speech Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. The user chose PM-supervised workers; preserve that method.

**Goal:** Expose the approved token-free speech detector through desktop, web, and React Native SDK packages with working installed assets and capture preemption.

**Architecture:** Port released engine `v0.4.10` runtime and mobile bridge changes into the SDK's existing self-contained package assembly. Keep the Rust detector in the engine; SDK responsibilities are public exports, lifecycle integration, and resource installation.

**Tech Stack:** TypeScript, Node package installers, browser Worker/AudioWorklet/WASM, Nitro 0.35.4 C++ bindings, CocoaPods and Android Gradle.

**Spec:** `docs/superpowers/specs/2026-11-20-speech-detection-api-design.md` (extension of the user-approved engine design).

## Global Constraints

- SDK base: `origin/main` at `72a3602`; isolated branch `feat/speech-detection-api`.
- Engine source/reference: `/Users/lucas/workspace/console/.worktrees/Tellus-audio-engine/speech-detection-only`, tag `v0.4.10`; do not modify that checkout.
- Events contain only `speaking` and `timestampMs`; detector setup needs no capture permit, model keys, or AudioEngine initialization.
- Preserve engine preemption/error/single-result rules and existing SDK compatibility fixes. Apply relevant diffs rather than replacing SDK-specific implementations wholesale.
- Engine pin `0.4.10`; keep SDK version `0.3.9` until normal SDK release. No speculative future versions, new server APIs, or algorithm/config options.
- Evidence under ignored `.build-cache/speech-detection-api/`; root maintains external status board, PM maintains external append-only log. PM/workers do not push, open PRs, merge, or deploy.

## Review Focus

1. A pending microphone permission request is preempted or stopped: late streams must close and start must complete only once.
2. Capture fails authorization/configuration: existing detection must remain usable; paused capture must still exclude detection.
3. An installed asset is missing or Windows paths differ: reject before mutating app assets and preserve existing files.
4. Mobile native registration or a resource is omitted: test final package contents, generated files, source lists, and actual ABI/compiler boundaries.
5. Published types compile but package roots or old native binaries fail: test emitted root imports and real released desktop engine, and fail unsupported features explicitly.

## Task 1: Engine pin, shared types, desktop public API

**Files:** `release-assets.json`, `src/bindings/typescript/speech-detection.ts`, `src/platforms/desktop/electron/index.ts`, focused `scripts/desktop-speech-detection.test.js`; update affected version/installer fixtures only.

**Interfaces:** Produce exported `SpeechDetector`, `SpeechDetectionEvent`, `SpeechDetectionCallback` following the design. Pin all engine filenames/tag/version consistently to `0.4.10`.

- [ ] Add failing root-import/native-boundary tests: no init/permit, start/stop/device selection, two-field events, terminal error, unsupported engine.
- [ ] Port the minimal desktop facade/type changes from the released engine; retain SDK device/gain/authorization compatibility logic.
- [ ] Run focused tests plus package assembly and affected existing desktop tests; commit the reviewed task.

## Task 2: Web public API, preemption, and asset copying

**Files:** `src/platforms/web/{index,capture,native,worker,worker-client}.ts`, new `speech-detector.ts`, `speech-detection-worker.ts`, `speech-detection-protocol.ts`, `microphone-priority.ts`; related web tests; `src/installer/copy-web-assets.ts`, `release-assets.json` web required files, `scripts/web-assets.test.js`.

**Interfaces:** `SpeechDetector.init(BrowserSpeechDetectorAssets)`, `start(callback, deviceId?)`, `stop()`, `dispose()` with released engine semantics; asset field `speechDetectionModelUrl`.

- [ ] Add/port failing public/lifecycle/preemption tests, retaining existing web tests.
- [ ] Port relevant released changes, preserving SDK differences; ensure AudioCapture and detector use the same priority coordinator.
- [ ] Add failing asset-copy cases for detection worker/model/notice, missing resources before output mutation, and app-file retention; implement minimal resource requirements/copy changes.
- [ ] Run all web tests, affected installer tests, build/type checking; commit the reviewed task.

## Task 3: React Native API and complete native/resource integration

**Files:** `src/platforms/mobile/react-native/{index,SpeechDetector-related specs and modules}.ts`, related tests; `platforms/mobile/{cpp,ios,android,nitrogen/generated}`; `TellusAudioSdk.podspec`, Android source lists/assets synchronization, new reproducible Nitro config if necessary, `release-assets.json` iOS/Android required files.

**Interfaces:** `SpeechDetector.init(NativeSpeechDetectorAssets?)` and exported event/callback/assets types; Nitro object `TellusSpeechDetector` with `loadModel`, `start`, `stop`, disposal. Default resource `silero_vad_v6.2.onnx`.

- [ ] Add/port failing RN tests for no authorization/key calls, explicit/default assets, pending/running preemption, pause/restart/disposal, and stale callbacks.
- [ ] Port detection/priority C++ and existing capture handoff changes, plus iOS/Android plain model loaders; preserve SDK weak-link/device-error behavior.
- [ ] Generate/register the Nitro object reproducibly with version `0.35.4`; update Android CMake and iOS/Android resources. Include only the intended Silero resource with existing TEMC files.
- [ ] Add tests for generated/public/native source and final model/notice packaging, and native handoff where practical. Run RN, existing weak-link, package, and native compiler/ABI checks; commit the reviewed task.

## Task 4: Consumer documentation and final package/integration verification

**Files:** root/platform READMEs and focused consumer/package tests as needed.

- [ ] Add no-permit examples for all platforms, web asset paths and copying, RN default resource installation, preemption handling, explicit restart, error and timestamp/window semantics, engine `0.4.10` requirement.
- [ ] Verify root imports/declarations from assembled/npm-packed desktop/web/mobile packages, including optional event on callback error and existing public API compatibility.
- [ ] Use actual released desktop `v0.4.10` assets for a no-server-init detector smoke test when available; verify web/mobile assets/native ABI with genuine release or explicitly labeled equivalent engine test artifacts. Do not silently substitute binary versions or weaken validation.
- [ ] Run `npm run verify:pre-commit` on unchanged final HEAD; capture exact exit and source cleanliness. PM reviews every diff and logs limitations; root independently reviews and performs selected meaningful integration checks.

## Baseline and roles

Root ran `npm ci --ignore-scripts` and `npm run verify:pre-commit` on the clean base, both exit 0. Logs: `/Users/lucas/.cache/codex/tmp/sdk-speech-baseline-{install,verify}.log`.

PM uses one worker at a time unless ownership is demonstrably independent, personally reruns task verification and reads diffs, and requests fixes before accepting. A short fresh builder review may refine minor implementation details without reopening the already approved user contract. Root updates status and owns final verification and any eventual PR. Stop only for a concrete unresolved requirement; otherwise finish all four tasks.
