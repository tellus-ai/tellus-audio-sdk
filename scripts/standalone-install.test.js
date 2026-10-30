const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

// Runs the real tgz's public entry points from a temporary install path with no engine repository.
for (const platform of ['desktop', 'web', 'mobile']) {
  test(`${platform} package imports after unpacking without engine sources`, t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-standalone-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const source = path.resolve(__dirname, '../platforms', platform);
    const npm = process.env.npm_execpath;
    const command = npm ? process.execPath : process.platform === 'win32' ? 'cmd.exe' : 'npm';
    const packArgs = ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary];
    const args = npm ? [npm, ...packArgs] : process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', ...packArgs] : packArgs;
    const [pack] = JSON.parse(execFileSync(command, args, { cwd: source, encoding: 'utf8' }));
    execFileSync('tar', ['-xzf', path.join(temporary, pack.filename), '-C', temporary]);
    const installed = path.join(temporary, 'package');
    if (platform === 'desktop' && fs.existsSync(path.join(source, 'vendor'))) {
      fs.cpSync(path.join(source, 'vendor'), path.join(installed, 'vendor'), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    }
    if (platform === 'mobile') {
      const peer = path.join(installed, 'node_modules/react-native-nitro-modules');
      fs.mkdirSync(peer, { recursive: true });
      fs.writeFileSync(path.join(peer, 'package.json'), JSON.stringify({ name: 'react-native-nitro-modules', type: 'module', exports: './index.js' }));
      fs.writeFileSync(path.join(peer, 'index.js'), "export const NitroModules = { createHybridObject() { throw new Error('native host required'); } };\n");
    }
    {
      fs.writeFileSync(path.join(installed, 'consumer.mts'), `
        import { AudioEngine, listAudioDevices } from '@tellus-ai/audio-sdk-${platform}';
        import type { AudioCaptureConfig, AudioDeviceListResult, AudioDeviceOperationError, CaptureStatus } from '@tellus-ai/audio-sdk-${platform}';
        import { attachEngineAuthorization } from '@tellus-ai/audio-sdk-${platform}/authorization';
        export const init = AudioEngine.init;
        export const authorize = attachEngineAuthorization;
        const config: AudioCaptureConfig = { micDeviceId: 'input-id', systemAudioDeviceId: 'system-id', playbackDeviceId: 'playback-id', iosOutputRoute: 'system' };
        const devices: Promise<AudioDeviceListResult> = listAudioDevices('microphone');
        function selectedId(status: CaptureStatus) { return status.deviceStatus?.[0].actualDeviceId; }
        function errorCode(error: AudioDeviceOperationError) { return error.deviceStatus.code; }
        void config; void devices; void selectedId; void errorCode;
      `);
      const typed = spawnSync(process.execPath, [path.resolve(__dirname, '../node_modules/typescript/bin/tsc'),
        '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2020',
        ...(platform === 'desktop' ? ['--types', 'node', '--typeRoots', path.resolve(__dirname, '../node_modules/@types')] : []),
        '--strict', '--skipLibCheck', 'false', '--noEmit', 'consumer.mts'], { cwd: installed, encoding: 'utf8' });
      assert.equal(typed.status, 0, typed.stdout + typed.stderr);
    }
    if (platform === 'desktop' && !fs.existsSync(path.join(installed, 'vendor'))) {
      // CI installs no engine archive, so the real native loader check is left to check:binary.
      t.skip('Native engine archive is not staged on this CI host; check:binary verifies installed native loading');
      return;
    }
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const sdk = await import('@tellus-ai/audio-sdk-${platform}');
      const auth = await import('@tellus-ai/audio-sdk-${platform}/authorization');
      if (typeof sdk.AudioEngine.init !== 'function' || typeof sdk.listAudioDevices !== 'function' || typeof auth.attachEngineAuthorization !== 'function') process.exit(1);
      if ('${platform}' === 'desktop') {
        const devices = await sdk.listAudioDevices('microphone');
        if (devices.status.code === 'unsupported') {
          let rejected = false;
          try { new sdk.AudioCapture({ micDeviceId: 'explicit-device' }); }
          catch (error) { rejected = error.deviceStatus?.code === 'unsupported'; }
          if (!rejected) throw new Error('Old native engine silently accepted an explicit device');
        }
      }
    `], { cwd: installed, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(path.join(installed, 'src')));
    assert.ok(!fs.existsSync(path.join(temporary, 'Tellus-audio-engine')));
  });
}
