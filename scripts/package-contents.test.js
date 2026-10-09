const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// 실제 npm pack 목록과 파일 경계를 검증하므로 고정 사례를 사용한다.
function packageFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['dist', 'dist-browser', 'dist-native', 'licenses']) {
    fs.cpSync(path.join(__dirname, '..', directory), path.join(root, directory), { recursive: true });
  }
  for (const file of ['README.md', 'release-assets.json', 'app.plugin.js']) fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json')));
  delete pkg.scripts;
  pkg.files = ['dist', 'dist-browser', 'dist-native', 'README.md', 'release-assets.json', 'cpp', 'ios', 'android', 'nitrogen', 'licenses', 'app.plugin.js'];
  for (const file of ['cpp/Capture.cpp', 'ios/Capture.mm', 'android/build.gradle', 'nitrogen/generated.cpp']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '// native wrapper');
  }
  const run = () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    return spawnSync(process.execPath, ['dist/installer/check-package-contents.js'], { cwd: root, encoding: 'utf8' });
  };
  return { root, pkg, run };
}

test('packs built Node, browser, native exports and native wrapper source', (t) => {
  const { run } = packageFixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});
for (const condition of ['browser', 'react-native']) {
  test(`rejects a missing nested ${condition} export target`, (t) => {
    const { pkg, run } = packageFixture(t);
    pkg.exports['.'][condition].default = `./dist-${condition}/missing.js`;
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /export.*missing|missing.*export/i);
  });
}
test('rejects a nested export that exposes TypeScript source', (t) => {
  const { pkg, run } = packageFixture(t);
  pkg.exports['.'].browser.types = './src/browser/index.ts';
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /export.*built/i);
});
for (const file of ['cpp/engine.a', 'ios/model.temc', 'android/engine.so', 'nitrogen/engine.wasm']) {
  test(`rejects a binary/model hidden beside native wrapper source: ${file}`, (t) => {
    const { root, run } = packageFixture(t);
    fs.writeFileSync(path.join(root, file), 'not wrapper source');
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /binary|binaries|model/i);
  });
}

test('actual package file rules exclude Android build outputs and copied models', (t) => {
  const { root, pkg, run } = packageFixture(t);
  pkg.files = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'))).files;
  for (const file of ['android/build/engine.so', 'android/build/model.temc', 'android/.cxx/engine.a']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'generated output');
  }
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});

test('rejects a missing public Expo plugin export', (t) => {
  const { pkg, run } = packageFixture(t);
  delete pkg.exports['./app.plugin.js'];
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exports/i);
});
