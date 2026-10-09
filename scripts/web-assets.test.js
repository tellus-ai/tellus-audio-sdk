const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// 정적 자산 복사는 실제 파일과 패키지 해석을 사용하므로 고정 경계 사례로 검증한다.
function webFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-web-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.cpSync(path.join(__dirname, '../dist'), path.join(root, 'dist'), { recursive: true });
  const requiredFiles = ['tellus-audio-engine.mjs', 'tellus-audio-engine.wasm', 'models/manifest.json', 'models/fe-s16.temc'];
  fs.writeFileSync(path.join(root, 'release-assets.json'), JSON.stringify({ assets: { web: { requiredFiles } } }));
  const payload = requiredFiles.map((file) => `vendor/web/${file}`).concat([
    'vendor/web/licenses/NOTICE', 'vendor/web/build-manifest.json',
    'licenses/onnxruntime-web/LICENSE', 'licenses/onnxruntime-web/ThirdPartyNotices.txt',
    'runtime/platforms/web/worker.js', 'runtime/platforms/web/worklet.js', 'runtime/bindings/typescript/authorization/contracts.js',
    'node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
    'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  ]);
  for (const file of payload) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file);
  }
  fs.writeFileSync(path.join(root, 'node_modules/onnxruntime-web/package.json'), JSON.stringify({ main: 'dist/ort.wasm.bundle.min.mjs' }));
  const { copyWebAssets } = require(path.join(root, 'dist/installer/copy-web-assets'));
  const output = path.join(root, 'public/audio');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'app.txt'), 'retain');
  return { root, output, copyWebAssets };
}
test('copies engine, encrypted models, relative browser graph and pinned ORT files', (t) => {
  const { output, copyWebAssets } = webFixture(t);
  copyWebAssets(output);
  for (const file of ['tellus-audio-engine.mjs', 'tellus-audio-engine.wasm', 'models/fe-s16.temc',
    'platforms/web/worker.js', 'platforms/web/worklet.js', 'bindings/typescript/authorization/contracts.js',
    'ort/ort.wasm.bundle.min.mjs', 'ort/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.wasm',
    'licenses/NOTICE', 'licenses/onnxruntime-web/LICENSE',
    'licenses/onnxruntime-web/ThirdPartyNotices.txt', 'build-manifest.json']) assert.ok(fs.statSync(path.join(output, file)).isFile());
  assert.equal(fs.readFileSync(path.join(output, 'app.txt'), 'utf8'), 'retain');
});
test('rejects missing web runtime before copying any app asset', (t) => {
  const { root, output, copyWebAssets } = webFixture(t);
  fs.rmSync(path.join(root, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'));
  assert.throws(() => copyWebAssets(output), /missing required files/);
  assert.deepEqual(fs.readdirSync(output), ['app.txt']);
});
test('rejects missing ORT notices before copying any app asset', (t) => {
  const { root, output, copyWebAssets } = webFixture(t);
  fs.rmSync(path.join(root, 'licenses/onnxruntime-web/ThirdPartyNotices.txt'));
  assert.throws(() => copyWebAssets(output), /missing required files/);
  assert.deepEqual(fs.readdirSync(output), ['app.txt']);
});
for (const args of [['--platform'], ['--unknown', 'web'], ['--platform', 'ios', '--out', '/tmp/example'], ['--platform', 'web', '--platform', 'android']]) {
  test(`rejects invalid installer CLI arguments: ${args.join(' ')}`, () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../dist/installer/install-binary-cli.js'), ...args], {
      encoding: 'utf8', env: { ...process.env, TELLUS_AUDIO_ENGINE_TOKEN: '' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:|requires the web|specified once/);
  });
}
