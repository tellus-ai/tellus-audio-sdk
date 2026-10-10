const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

// Android만 설치한 실제 파일 경계에서 검증 CLI의 선택 옵션을 확인한다.
test('mobile binary checker validates the explicitly installed Android target', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-check-target-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(__dirname, '../platforms/mobile/dist'), path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ tellusPlatform: 'mobile' }));
  fs.writeFileSync(path.join(root, 'release-assets.json'), JSON.stringify({ assets: {
    ios: { requiredFiles: ['engine.marker'] }, android: { requiredFiles: ['engine.marker'] },
  } }));
  fs.mkdirSync(path.join(root, 'vendor/android'), { recursive: true });
  fs.writeFileSync(path.join(root, 'vendor/android/engine.marker'), 'installed Android engine');
  const env = { ...process.env };
  delete env.TELLUS_AUDIO_ENGINE_PLATFORM;
  const run = args => spawnSync(process.execPath, ['dist/installer/check-binary-cli.js', ...args], { cwd: root, encoding: 'utf8', env });
  const selected = run(['--platform', 'android']);
  assert.equal(selected.status, 0, selected.stderr);
  const both = run([]);
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /ios/);
});
