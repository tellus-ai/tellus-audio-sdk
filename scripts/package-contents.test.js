const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const repository = path.resolve(__dirname, '..');
// npm 실제 배포 파일과 공개 exports를 확인하는 파일 시스템 경계 테스트다.
function packageFixture(t, platform = 'mobile') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(repository, 'platforms', platform);
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
  for (const file of pkg.files) {
    if (fs.existsSync(path.join(source, file))) fs.cpSync(path.join(source, file), path.join(root, file), { recursive: true });
  }
  delete pkg.scripts;
  const run = () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    return spawnSync(process.execPath, [path.join(repository, 'dist/installer/check-package-contents.js'), root], { cwd: root, encoding: 'utf8' });
  };
  return { root, pkg, run };
}

for (const platform of ['desktop', 'web', 'mobile']) {
  test(`packs an independent ${platform} runtime and installer`, t => {
    const { run } = packageFixture(t, platform);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
  });
  test(`rejects a missing ${platform} public entrypoint`, t => {
    const { pkg, run } = packageFixture(t, platform);
    pkg.exports['.'].default = './runtime/missing.js';
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /export.*missing|missing.*export/i);
  });
}

test('rejects an export that exposes engine TypeScript source', t => {
  const { pkg, run } = packageFixture(t);
  pkg.exports['.'].types = './src/react-native/index.ts';
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /export.*built/i);
});
for (const file of ['cpp/engine.a', 'ios/model.temc', 'android/engine.so', 'nitrogen/generated/engine.wasm']) {
  test(`rejects a binary or model beside native wrapper source: ${file}`, t => {
    const { root, pkg, run } = packageFixture(t);
    pkg.files.push('android');
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'not wrapper source');
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /binary|binaries|model/i);
  });
}

test('actual package file rules exclude Android outputs and downloaded models', t => {
  const { root, run } = packageFixture(t);
  for (const file of ['android/build/engine.so', 'android/build/model.temc', 'android/.cxx/engine.a']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'generated output');
  }
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});
test('rejects a missing public Expo plugin export', t => {
  const { pkg, run } = packageFixture(t);
  delete pkg.exports['./app.plugin.js'];
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exports/i);
});
test('rejects another platform runtime in a desktop package', t => {
  const { root, run } = packageFixture(t, 'desktop');
  fs.mkdirSync(path.join(root, 'runtime/platforms/mobile'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime/platforms/mobile/index.js'), '');
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another platform/i);
});
