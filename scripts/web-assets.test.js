const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

// Static asset copying uses real files and package resolution, so it is verified with fixed boundary cases.
function webFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-web-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.cpSync(path.join(__dirname, '../dist'), path.join(root, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../platforms/web/release-assets.json'), path.join(root, 'release-assets.json'));
  fs.cpSync(path.join(__dirname, '../platforms/web/runtime'), path.join(root, 'runtime'), { recursive: true });
  const engineFiles = [
    'tellus-audio-engine.mjs', 'tellus-audio-engine.wasm', 'models/manifest.json', 'models/denoise.temc', 'models/vad.temc',
    'speech-detection/silero_vad_v6.2.onnx', 'licenses/silero-vad.txt',
  ];
  const payload = engineFiles.map((file) => `vendor/web/${file}`).concat([
    'vendor/web/licenses/NOTICE', 'vendor/web/build-manifest.json',
    'licenses/onnxruntime-web/LICENSE', 'licenses/onnxruntime-web/ThirdPartyNotices.txt',
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
  fs.mkdirSync(path.join(output, 'licenses'));
  fs.writeFileSync(path.join(output, 'licenses/app.txt'), 'retain license');
  return { root, output, copyWebAssets };
}
test('copies engine, capture and detection models, relative browser graph and notices', (t) => {
  const { output, copyWebAssets } = webFixture(t);
  copyWebAssets(output);
  for (const file of ['tellus-audio-engine.mjs', 'tellus-audio-engine.wasm', 'models/denoise.temc', 'models/vad.temc',
    'speech-detection/silero_vad_v6.2.onnx', 'licenses/silero-vad.txt',
    'platforms/web/speech-detection-worker.js', 'platforms/web/speech-detector.js', 'platforms/web/microphone-priority.js',
    'platforms/web/native.js', 'platforms/web/protocol.js', 'bindings/typescript/audio-gain.js',
    'platforms/web/worker.js', 'platforms/web/worklet.js', 'bindings/typescript/authorization/contracts.js',
    'ort/ort.wasm.bundle.min.mjs', 'ort/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.wasm',
    'licenses/NOTICE', 'licenses/onnxruntime-web/LICENSE',
    'licenses/onnxruntime-web/ThirdPartyNotices.txt', 'build-manifest.json']) assert.ok(fs.statSync(path.join(output, file)).isFile());
  assert.equal(fs.readFileSync(path.join(output, 'app.txt'), 'utf8'), 'retain');
  assert.equal(fs.readFileSync(path.join(output, 'licenses/app.txt'), 'utf8'), 'retain license');
});
test('copies POSIX manifest paths using Windows file paths', (t) => {
  const { root, output } = webFixture(t);
  const win = path.win32;
  const windowsRoot = 'C:\\sdk';
  const hostPath = (file) => path.join(root, ...win.relative(windowsRoot, file).split(win.sep));
  const fsWithWindowsPaths = {
    existsSync: (file) => fs.existsSync(hostPath(file)),
    statSync: (file) => fs.statSync(hostPath(file)),
    readFileSync: (file, encoding) => fs.readFileSync(hostPath(file), encoding),
    mkdirSync: (file, options) => fs.mkdirSync(hostPath(file), options),
    cpSync: (from, to, options) => fs.cpSync(hostPath(from), hostPath(to), options),
  };
  const windowsRequire = (id) => id === 'node:fs' ? fsWithWindowsPaths : id === 'node:path' ? win : require(id);
  windowsRequire.resolve = () => win.join(windowsRoot, 'node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs');
  const exports = {};
  const dirname = win.join(windowsRoot, 'dist', 'installer');
  runInNewContext(fs.readFileSync(path.join(root, 'dist/installer/copy-web-assets.js'), 'utf8'), {
    __dirname: dirname, require: windowsRequire, exports, console,
  });
  exports.copyWebAssets(win.join(windowsRoot, 'public', 'audio'));
  for (const file of ['speech-detection/silero_vad_v6.2.onnx', 'licenses/silero-vad.txt']) {
    assert.equal(fs.readFileSync(path.join(output, file), 'utf8'), 'vendor/web/' + file);
  }
});
test('rejects missing web runtime before copying any app asset', (t) => {
  const { root, output, copyWebAssets } = webFixture(t);
  fs.rmSync(path.join(root, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'));
  assert.throws(() => copyWebAssets(output), /missing required files/);
  assert.deepEqual(fs.readdirSync(output), ['app.txt', 'licenses']);
  assert.deepEqual(fs.readdirSync(path.join(output, 'licenses')), ['app.txt']);
});
test('rejects missing ORT notices before copying any app asset', (t) => {
  const { root, output, copyWebAssets } = webFixture(t);
  fs.rmSync(path.join(root, 'licenses/onnxruntime-web/ThirdPartyNotices.txt'));
  assert.throws(() => copyWebAssets(output), /missing required files/);
  assert.deepEqual(fs.readdirSync(output), ['app.txt', 'licenses']);
  assert.deepEqual(fs.readdirSync(path.join(output, 'licenses')), ['app.txt']);
});
for (const segments of [
  ['vendor', 'web', 'speech-detection', 'silero_vad_v6.2.onnx'],
  ['vendor', 'web', 'licenses', 'silero-vad.txt'],
  ['runtime', 'platforms', 'web', 'speech-detection-worker.js'],
  ['runtime', 'platforms', 'web', 'native.js'],
  ['runtime', 'platforms', 'web', 'protocol.js'],
  ['runtime', 'bindings', 'typescript', 'audio-gain.js'],
]) {
  test(`rejects a missing ${segments.join('/')} before touching app assets`, (t) => {
    const { root, output, copyWebAssets } = webFixture(t);
    const missing = path.join(root, ...segments);
    fs.rmSync(missing, { force: true });
    assert.throws(() => copyWebAssets(output), (error) =>
      error.message.startsWith('Web assets are missing required files:') && error.message.includes(missing));
    assert.deepEqual(fs.readdirSync(output), ['app.txt', 'licenses']);
    assert.equal(fs.readFileSync(path.join(output, 'app.txt'), 'utf8'), 'retain');
    assert.deepEqual(fs.readdirSync(path.join(output, 'licenses')), ['app.txt']);
    assert.equal(fs.readFileSync(path.join(output, 'licenses/app.txt'), 'utf8'), 'retain license');
  });
}
for (const args of [['--platform'], ['--unknown', 'web'], ['--platform', 'ios', '--out', '/tmp/example'], ['--platform', 'web', '--platform', 'android']]) {
  test(`rejects invalid installer CLI arguments: ${args.join(' ')}`, () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../dist/installer/install-binary-cli.js'), ...args], {
      encoding: 'utf8', env: { ...process.env, TELLUS_AUDIO_ENGINE_TOKEN: '' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:|requires the web|specified once/);
  });
}
