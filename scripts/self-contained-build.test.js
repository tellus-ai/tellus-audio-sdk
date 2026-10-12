const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ts = require('typescript');

test('fresh SDK sources build all packages without an engine checkout or runtime kits', t => {
  const root = path.resolve(__dirname, '..');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-sdk-build-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const inputs = ['src', 'licenses', 'LICENSE', 'package.json', 'release-assets.json',
    'scripts/assemble-platforms.js', 'tsconfig.json',
    ...['desktop', 'web', 'mobile'].map(platform => `tsconfig.runtime.${platform}.json`),
    ...['desktop', 'web', 'mobile'].map(platform => `platforms/${platform}/package.json`),
    ...['cpp', 'ios', 'android/src', 'nitrogen/generated'].map(directory => `platforms/mobile/${directory}`)];
  for (const input of inputs) {
    fs.mkdirSync(path.dirname(path.join(fixture, input)), { recursive: true });
    fs.cpSync(path.join(root, input), path.join(fixture, input), { recursive: true });
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'junction');
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts/assemble-platforms.js')], {
    cwd: fixture, encoding: 'utf8',
    env: { ...process.env, TELLUS_AUDIO_ENGINE_DIST: path.join(fixture, 'missing-engine') },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const platform of ['desktop', 'web', 'mobile']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(fixture, 'platforms', platform, 'package.json')));
    assert.ok(fs.existsSync(path.join(fixture, 'platforms', platform, pkg.main)));
    assert.ok(fs.existsSync(path.join(fixture, 'platforms', platform, pkg.types)));
    const entry = path.join('platforms', platform, pkg.main).replaceAll(path.sep, '/');
    const usage = path.join(fixture, `${platform}-devices.ts`);
    fs.writeFileSync(usage, `import { listAudioDevices } from './${entry}';
import type { AudioCaptureConfig, AudioDeviceListResult, AudioDeviceOperationError } from './${entry}';
const config: AudioCaptureConfig = { micDeviceId: 'input-id', systemAudioDeviceId: 'system-id', playbackDeviceId: 'playback-id', iosOutputRoute: 'system' };
const devices: Promise<AudioDeviceListResult> = listAudioDevices('microphone');
function errorCode(error: AudioDeviceOperationError) { return error.deviceStatus.code; }
void config; void devices; void errorCode;
`);
    const program = ts.createProgram([usage], { noEmit: true, strict: true, skipLibCheck: true,
      target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
  }
});
