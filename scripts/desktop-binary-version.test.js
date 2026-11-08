const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { currentAssetKey, nativeFileCandidates } = require('../dist/platform/asset-key');

for (const [metadata, actual, passed] of [
  ['0.4.2', '0.3.4', false],
  ['0.3.4', '0.4.2', false],
  ['0.4.2', '0.4.2', true],
]) {
  test(`desktop binary check compares pinned 0.4.2 with package ${metadata} and loaded ${actual}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-check-version-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.cpSync(path.join(__dirname, '../platforms/desktop/dist'), path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ tellusPlatform: 'desktop', main: 'index.js' }));
    fs.writeFileSync(path.join(root, 'release-assets.json'), JSON.stringify({ nativeEngineVersion: '0.4.2' }));
    const target = process.platform === 'darwin' ? 'darwin-universal' : currentAssetKey();
    const vendor = path.join(root, 'vendor', target);
    fs.mkdirSync(vendor, { recursive: true });
    const files = process.platform === 'darwin' ? ['audio-capture.darwin-universal.node'] : nativeFileCandidates();
    for (const file of files) fs.writeFileSync(path.join(vendor, file), 'native fixture');
    const ort = process.platform === 'darwin' ? 'onnxruntime/darwin-universal/libonnxruntime.dylib'
      : process.platform === 'win32' ? 'onnxruntime.dll' : 'libonnxruntime.so';
    fs.mkdirSync(path.dirname(path.join(vendor, ort)), { recursive: true });
    fs.writeFileSync(path.join(vendor, ort), 'runtime fixture');
    fs.writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({ version: metadata }));
    fs.writeFileSync(path.join(root, 'index.js'),
      `exports.AudioCapture = class { getStatus() { return { engineVersion: '${actual}' }; } };`);
    const result = spawnSync(process.execPath, ['dist/installer/check-binary-cli.js'], { cwd: root, encoding: 'utf8' });
    if (passed) assert.equal(result.status, 0, result.stdout + result.stderr);
    else {
      assert.notEqual(result.status, 0, 'stale engine was accepted');
      assert.match(result.stderr, /engine version mismatch/i);
    }
  });
}
