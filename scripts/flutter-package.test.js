const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const repository = path.resolve(__dirname, '..');
const sharedSources = [
  ...['AudioDevice.hpp', 'CaptureSession.hpp', 'CaptureSession.cpp', 'CaptureWorker.hpp', 'CaptureWorker.cpp', 'InputHold.hpp', 'InputHold.cpp',
    'LastError.hpp', 'LastError.cpp', 'MicrophonePriority.hpp', 'MicrophonePriority.cpp'].map(file => `cpp/${file}`),
  'ios/IOSAudioDevice.mm',
];
const flutterSources = ['tellus_flutter_capture.h', 'tellus_flutter_capture.cpp', 'shim/tellus_flutter_shim.c'];

// Builds a copy of the SDK sources in a temporary folder: the engine kits extracted in platforms/flutter are never touched.
function sdkFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-flutter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputs = ['src', 'licenses', 'LICENSE', 'package.json', 'release-assets.json', 'scripts/assemble-platforms.js', 'tsconfig.json',
    ...['desktop', 'web', 'mobile'].map(platform => `tsconfig.runtime.${platform}.json`),
    ...['desktop', 'web', 'mobile', 'flutter'].map(platform => `platforms/${platform}/package.json`),
    'platforms/flutter/pubspec.yaml', 'platforms/mobile/cpp', 'platforms/mobile/ios'];
  for (const input of inputs) {
    fs.mkdirSync(path.dirname(path.join(root, input)), { recursive: true });
    fs.cpSync(path.join(repository, input), path.join(root, input), { recursive: true });
  }
  const flutter = path.join(root, 'platforms/flutter');
  for (const file of flutterSources) {
    fs.mkdirSync(path.dirname(path.join(flutter, 'native', file)), { recursive: true });
    fs.writeFileSync(path.join(flutter, 'native', file), `Flutter source ${file}`);
  }
  fs.symlinkSync(path.join(repository, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  const assemble = () => spawnSync(process.execPath, [path.join(root, 'scripts/assemble-platforms.js')], { cwd: root, encoding: 'utf8' });
  return { root, flutter, assemble };
}

function listFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ?
    listFiles(path.join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);
}

test('Flutter package is private, names its platform and never downloads during npm install', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repository, 'platforms/flutter/package.json')));
  assert.equal(pkg.name, '@tellus-ai/audio-sdk-flutter');
  assert.equal(pkg.private, true);
  assert.equal(pkg.tellusPlatform, 'flutter');
  assert.deepEqual(pkg.scripts, {
    'install:binary': 'node dist/installer/install-binary-cli.js',
    'check:binary': 'node dist/installer/check-binary-cli.js',
  });
});

test('build assembles the Flutter package with the installer, the iOS and Android manifest and the pod sources', async t => {
  const { root, flutter, assemble } = sdkFixture(t);
  const pod = path.join(flutter, 'ios/Classes/native');
  fs.mkdirSync(pod, { recursive: true });
  fs.writeFileSync(path.join(pod, 'Removed.cpp'), 'left by an earlier build');
  const result = assemble();
  assert.equal(result.status, 0, result.stdout + result.stderr);

  for (const file of ['install-binary-cli.js', 'install-binary.js', 'check-binary-cli.js', 'check-binary.js']) {
    assert.ok(fs.statSync(path.join(flutter, 'dist/installer', file)).isFile());
  }
  assert.ok(!fs.existsSync(path.join(flutter, 'dist/installer/copy-web-assets.js')));
  assert.ok(!fs.existsSync(path.join(flutter, 'runtime')));
  const release = JSON.parse(fs.readFileSync(path.join(root, 'release-assets.json')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(flutter, 'release-assets.json'))),
    { ...release, assets: { ios: release.assets.ios, android: release.assets.android } });
  assert.deepEqual(fs.readFileSync(path.join(flutter, 'LICENSE')), fs.readFileSync(path.join(root, 'LICENSE')));

  // CocoaPods cannot reference sources outside the pod folder, so the pod must hold exactly the sources it compiles.
  assert.deepEqual(listFiles(pod).sort(), [...flutterSources, ...sharedSources.map(file => path.basename(file))].sort());
  for (const file of flutterSources) assert.equal(fs.readFileSync(path.join(pod, file), 'utf8'), `Flutter source ${file}`);
  for (const file of sharedSources) {
    assert.deepEqual(fs.readFileSync(path.join(pod, path.basename(file))), fs.readFileSync(path.join(root, 'platforms/mobile', file)));
  }

  await t.test('assembled installer verifies each kit inside its own platform folder', () => {
    const env = { ...process.env };
    delete env.TELLUS_AUDIO_ENGINE_PLATFORM;
    const check = (...args) => spawnSync(process.execPath, ['dist/installer/check-binary-cli.js', ...args], { cwd: flutter, encoding: 'utf8', env });
    const stage = (directory, target) => {
      for (const file of release.assets[target].requiredFiles) {
        fs.mkdirSync(path.dirname(path.join(flutter, directory, file)), { recursive: true });
        fs.writeFileSync(path.join(flutter, directory, file), 'installed engine file');
      }
    };
    // The React Native layout is outside the folders CocoaPods and Gradle read.
    stage('vendor/ios', 'ios');
    stage('vendor/android', 'android');
    assert.notEqual(check().status, 0);
    stage('android/vendor/android', 'android');
    const android = check('--platform', 'android');
    assert.equal(android.status, 0, android.stderr);
    const missingIos = check();
    assert.notEqual(missingIos.status, 0);
    assert.match(missingIos.stderr, /ios/);
    stage('ios/vendor/ios', 'ios');
    const both = check();
    assert.equal(both.status, 0, both.stderr);
    assert.match(both.stdout, /ios, android/);
  });
});

for (const [name, file, change] of [
  ['package', 'package.json', text => JSON.stringify({ ...JSON.parse(text), version: '0.0.1' })],
  ['pubspec', 'pubspec.yaml', text => text.replace(/^version:.*$/m, 'version: 0.0.1')],
]) {
  test(`build rejects a Flutter ${name} version that differs from the pinned SDK version`, t => {
    const { flutter, assemble } = sdkFixture(t);
    fs.writeFileSync(path.join(flutter, file), change(fs.readFileSync(path.join(flutter, file), 'utf8')));
    const result = assemble();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`flutter ${name} version differs from pinned SDK version`));
  });
}

for (const source of ['platforms/mobile/cpp/InputHold.cpp', 'platforms/mobile/ios/IOSAudioDevice.mm', 'platforms/flutter/native']) {
  test(`build names the missing Flutter native source ${source}`, t => {
    const { root, assemble } = sdkFixture(t);
    fs.rmSync(path.join(root, source), { recursive: true });
    const result = assemble();
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`Flutter native source is missing: ${source}`), result.stderr);
  });
}
