const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

// 엔진 저장소가 없는 임시 설치 경로에서 실제 tgz의 공개 진입점을 실행한다.
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
    if (platform === 'web') {
      fs.writeFileSync(path.join(installed, 'consumer.mts'), `
        import { AudioEngine } from '@tellus-ai/audio-sdk-web';
        import { attachEngineAuthorization } from '@tellus-ai/audio-sdk-web/authorization';
        export const init = AudioEngine.init;
        export const authorize = attachEngineAuthorization;
      `);
      const typed = spawnSync(process.execPath, [path.resolve(__dirname, '../node_modules/typescript/bin/tsc'),
        '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2020',
        '--strict', '--skipLibCheck', 'false', '--noEmit', 'consumer.mts'], { cwd: installed, encoding: 'utf8' });
      assert.equal(typed.status, 0, typed.stdout + typed.stderr);
    }
    if (platform === 'desktop' && !fs.existsSync(path.join(installed, 'vendor'))) {
      // CI에는 엔진 archive를 설치하지 않으므로 실제 native 로더 검증은 별도 check:binary가 담당한다.
      t.skip('Native engine archive is not staged on this CI host; check:binary verifies installed native loading');
      return;
    }
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const sdk = await import('@tellus-ai/audio-sdk-${platform}');
      const auth = await import('@tellus-ai/audio-sdk-${platform}/authorization');
      if (typeof sdk.AudioEngine.init !== 'function' || typeof auth.attachEngineAuthorization !== 'function') process.exit(1);
    `], { cwd: installed, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(path.join(installed, 'src')));
    assert.ok(!fs.existsSync(path.join(temporary, 'Tellus-audio-engine')));
  });
}
