const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

// Run the tgz's public entry points from a separate app without an engine source checkout.
for (const platform of ['desktop', 'web', 'mobile']) {
  test(`${platform} package imports after unpacking without engine sources`, async t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-standalone-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const source = path.resolve(__dirname, '../platforms', platform);
    const packageName = `@tellus-ai/audio-sdk-${platform}`;
    const npm = process.env.npm_execpath;
    const command = npm ? process.execPath : process.platform === 'win32' ? 'cmd.exe' : 'npm';
    const packArgs = ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary];
    const args = npm ? [npm, ...packArgs] : process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', ...packArgs] : packArgs;
    const [pack] = JSON.parse(execFileSync(command, args, { cwd: source, encoding: 'utf8' }));
    execFileSync('tar', ['-xzf', pack.filename], { cwd: temporary });
    const installed = path.join(temporary, 'node_modules', packageName);
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.renameSync(path.join(temporary, 'package'), installed);
    if (platform === 'desktop' && fs.existsSync(path.join(source, 'vendor'))) {
      fs.cpSync(path.join(source, 'vendor'), path.join(installed, 'vendor'), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    }
    if (platform === 'mobile') {
      const peer = path.join(temporary, 'node_modules/react-native-nitro-modules');
      fs.mkdirSync(peer, { recursive: true });
      fs.writeFileSync(path.join(peer, 'package.json'), JSON.stringify({ name: 'react-native-nitro-modules', type: 'module', exports: './index.js' }));
      fs.writeFileSync(path.join(peer, 'index.js'), `
        import assert from 'node:assert/strict';
        export const NitroModules = {
          createHybridObject(name) {
            assert.equal(name, 'TellusSpeechDetector');
            return {
              async loadModel(model) { assert.equal(model, 'silero_vad_v6.2.onnx'); },
              async start(deviceId, onEvent, onError) {
                if (deviceId === 'preempted-input') throw new Error('speech_detection_preempted_by_capture');
                globalThis.input = { onEvent, onError };
              },
              async stop() {},
              dispose() {},
            };
          },
        };
      `);
    }

    fs.writeFileSync(path.join(temporary, 'consumer.mts'), `
      import { AudioEngine, listAudioDevices, SpeechDetector } from '${packageName}';
      import type { AudioCapture, AudioCaptureConfig, AudioDeviceListResult, AudioDeviceOperationError, CaptureStatus, AutoGainControlConfig, SpeechDetectionCallback, SpeechDetectionEvent } from '${packageName}';
      import { attachEngineAuthorization } from '${packageName}/authorization';
      export const init = AudioEngine.init;
      export const authorize = attachEngineAuthorization;
      const autoGainControl: AutoGainControlConfig = { enabled: true, maxGainDb: 8, maxOutputNoiseLevelDbfs: -50, maxGainChangeDbPerSecond: 3, headroomDb: 6, peakLevelDbfs: -3 };
      const config: AudioCaptureConfig = { micDeviceId: 'input-id', systemAudioDeviceId: 'system-id', playbackDeviceId: 'playback-id', iosOutputRoute: 'system', micGainDb: -6, speakerGainDb: 0, autoGainControl };
      async function gain(capture: AudioCapture) { await capture.setMicGainDb(-3); await capture.setSpeakerGainDb(0); }
      const devices: Promise<AudioDeviceListResult> = listAudioDevices('microphone');
      function selectedId(status: CaptureStatus) { return status.deviceStatus?.[0].actualDeviceId; }
      function errorCode(error: AudioDeviceOperationError) { return error.deviceStatus.code; }
      void config; void devices; void selectedId; void errorCode; void gain;

      type Assert<T extends true> = T;
      type EventFields = Assert<Exclude<keyof SpeechDetectionEvent, 'speaking' | 'timestampMs'> extends never ? true : false>;
      const onSpeech: SpeechDetectionCallback = (error, event) => {
        if (error) return;
        // @ts-expect-error The callback's event must be guarded.
        const unguardedTimestamp: number = event.timestampMs;
        if (!event) return;
        const speaking: boolean = event.speaking;
        const timestampMs: number = event.timestampMs;
        void speaking; void timestampMs; void unguardedTimestamp;
      };
      onSpeech(new Error('speech_detection_preempted_by_capture'));
      ${platform === 'desktop' ? `
        const detector = new SpeechDetector();
        try {
          const started: void = detector.start(onSpeech, 'input-id');
          void started;
        } catch (error) { console.error(error); }
        const stopped: void = detector.stop();
        void stopped;
      ` : `
        ${platform === 'web' ? `
          import type { BrowserSpeechDetectorAssets } from '${packageName}';
          import { copyWebAssets } from '${packageName}/installer';
          const copied: void = copyWebAssets('./public/tellus-audio');
          void copied;
          const assets: BrowserSpeechDetectorAssets = {
            engineModuleUrl: '/tellus-audio/tellus-audio-engine.mjs',
            wasmUrl: '/tellus-audio/tellus-audio-engine.wasm',
            ortWasmBaseUrl: '/tellus-audio/ort/',
            speechDetectionModelUrl: '/tellus-audio/speech-detection/silero_vad_v6.2.onnx',
          };
          const detector: SpeechDetector = await SpeechDetector.init(assets);
          await SpeechDetector.init({ ...assets, ortModuleUrl: '/tellus-audio/ort/ort.wasm.bundle.min.mjs' });
        ` : `
          import type { NativeSpeechDetectorAssets } from '${packageName}';
          const assets: NativeSpeechDetectorAssets = { speechDetectionModel: 'file:///app/silero_vad_v6.2.onnx' };
          const detector: SpeechDetector = await SpeechDetector.init();
          await SpeechDetector.init(assets);
        `}
        try {
          const started: Promise<void> = detector.start(onSpeech, 'input-id');
          await started;
        } catch (error) { console.error(error); }
        const stopped: Promise<void> = detector.stop();
        const disposed: Promise<void> = detector.dispose();
        await stopped;
        await disposed;
      `}
    `);
    const typed = spawnSync(process.execPath, [path.resolve(__dirname, '../node_modules/typescript/bin/tsc'),
      '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2020',
      ...(platform === 'desktop' ? ['--types', 'node', '--typeRoots', path.resolve(__dirname, '../node_modules/@types')] : []),
      '--strict', '--skipLibCheck', 'false', '--noEmit', 'consumer.mts'], { cwd: temporary, encoding: 'utf8' });
    assert.equal(typed.status, 0, typed.stdout + typed.stderr);
    assert.ok(!fs.existsSync(path.join(installed, 'src')));
    assert.ok(!fs.existsSync(path.join(temporary, 'Tellus-audio-engine')));

    await t.test(`${platform} runtime package root`, native => {
      if (platform === 'desktop' && !fs.existsSync(path.join(installed, 'vendor'))) {
        native.skip('Native engine archive is not staged on this CI host; check:binary verifies installed native loading');
        return;
      }
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import * as sdk from '${packageName}';
        import { attachEngineAuthorization } from '${packageName}/authorization';
        assert.equal(typeof sdk.AudioEngine.init, 'function');
        assert.equal(typeof sdk.listAudioDevices, 'function');
        assert.equal(typeof attachEngineAuthorization, 'function');
        assert.equal(typeof sdk.SpeechDetector, 'function');
        ${platform === 'desktop' ? `
          const devices = await sdk.listAudioDevices('microphone');
          if (devices.status.code === 'unsupported') {
            assert.throws(() => new sdk.AudioCapture({ micDeviceId: 'explicit-device' }),
              error => error.deviceStatus?.code === 'unsupported');
          } else {
            assert.equal(new sdk.SpeechDetector().stop(), undefined);
          }
        ` : platform === 'web' ? `
          globalThis.document = { baseURI: 'https://app.example/' };
          let endInput;
          const track = {
            addEventListener(_event, listener) { endInput = listener; },
            removeEventListener() {},
            stop() {},
          };
          Object.defineProperty(globalThis, 'navigator', { value: {
            mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
          } });
          globalThis.AudioContext = class {
            audioWorklet = { addModule: async () => {} };
            createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
            resume() { return Promise.resolve(); }
            close() { return Promise.resolve(); }
          };
          globalThis.AudioWorkletNode = class {
            port = { postMessage() {}, close() {} };
            connect() {}
            disconnect() {}
          };
          let failStart = true;
          globalThis.Worker = class {
            constructor(url) { assert.match(url.pathname, /speech-detection-worker\\.js$/); }
            postMessage({ id, command }) {
              const error = command.operation === 'start' && failStart ? 'fixture_input_unavailable' : undefined;
              this.onmessage({ data: { id, events: [], error } });
            }
            terminate() {}
          };
          const detector = await sdk.SpeechDetector.init({
            engineModuleUrl: '/tellus-audio/tellus-audio-engine.mjs',
            wasmUrl: '/tellus-audio/tellus-audio-engine.wasm',
            ortWasmBaseUrl: '/tellus-audio/ort/',
            speechDetectionModelUrl: '/tellus-audio/speech-detection/silero_vad_v6.2.onnx',
          });
          await assert.rejects(detector.start(() => assert.fail('failed start callback')), /fixture_input_unavailable/);
          failStart = false;
          const received = [];
          await detector.start((error, event) => received.push([error, event]));
          endInput();
          endInput();
          assert.equal(received.length, 1);
          assert.ok(received[0][0] instanceof Error);
          assert.equal(received[0][1], undefined);
          await detector.stop();
          await detector.dispose();
        ` : `
          const detector = await sdk.SpeechDetector.init();
          await assert.rejects(detector.start(() => assert.fail('preempted start callback'), 'preempted-input'),
            /speech_detection_preempted_by_capture/);
          const received = [];
          await detector.start((error, event) => received.push([error?.message ?? null, event]));
          globalThis.input.onEvent(false, 1024);
          globalThis.input.onError('speech_detection_preempted_by_capture');
          globalThis.input.onEvent(true, 2048);
          assert.deepEqual(received, [
            [null, { speaking: false, timestampMs: 1024 }],
            ['speech_detection_preempted_by_capture', undefined],
          ]);
          await detector.start(() => {});
          await detector.stop();
          await detector.dispose();
        `}
      `], { cwd: temporary, encoding: 'utf8', timeout: 30000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    });

    if (platform === 'web') await t.test('packed web installer copies public assets and an importable worker graph', () => {
      const engineFiles = [
        'tellus-audio-engine.mjs', 'tellus-audio-engine.wasm', 'models/manifest.json', 'models/denoise.temc',
        'models/vad.temc', 'speech-detection/silero_vad_v6.2.onnx', 'licenses/silero-vad.txt',
      ];
      for (const file of engineFiles) {
        const destination = path.join(installed, 'vendor/web', file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, file);
      }
      fs.symlinkSync(path.resolve(__dirname, '../node_modules/onnxruntime-web'),
        path.join(temporary, 'node_modules/onnxruntime-web'), 'junction');
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { copyWebAssets } from '${packageName}/installer';
        copyWebAssets('./public/tellus-audio');
        globalThis.self = {};
        await import('./public/tellus-audio/platforms/web/speech-detection-worker.js');
        assert.equal(typeof self.onmessage, 'function');
      `], { cwd: temporary, encoding: 'utf8', timeout: 30000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const output = path.join(temporary, 'public/tellus-audio');
      for (const file of engineFiles) assert.equal(fs.readFileSync(path.join(output, file), 'utf8'), file);
      for (const file of ['ort.wasm.bundle.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
        assert.deepEqual(fs.readFileSync(path.join(output, 'ort', file)),
          fs.readFileSync(path.join(temporary, 'node_modules/onnxruntime-web/dist', file)));
      }
      for (const file of ['LICENSE', 'ThirdPartyNotices.txt']) {
        assert.deepEqual(fs.readFileSync(path.join(output, 'licenses/onnxruntime-web', file)),
          fs.readFileSync(path.join(installed, 'licenses/onnxruntime-web', file)));
      }
    });
  });
}
