const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
if (process.argv.length > 2) throw new Error('Usage: assemble-platforms');
const release = JSON.parse(fs.readFileSync(path.join(root, 'release-assets.json')));
for (const platform of ['desktop', 'web', 'mobile', 'flutter']) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'platforms', platform, 'package.json')));
  if (pkg.version !== release.sdkVersion) throw new Error(`${platform} package version differs from pinned SDK version`);
}
const flutter = path.join(root, 'platforms', 'flutter');
const pubspecVersion = /^version:[ \t]*(\S+)/m.exec(fs.readFileSync(path.join(flutter, 'pubspec.yaml'), 'utf8'))?.[1];
if (pubspecVersion !== release.sdkVersion) throw new Error('flutter pubspec version differs from pinned SDK version');
// Sources of the React Native package that the Flutter plugin also compiles.
const flutterSharedSources = [
  ...['AudioDevice.hpp', 'CaptureSession.hpp', 'CaptureSession.cpp', 'CaptureWorker.hpp', 'CaptureWorker.cpp', 'InputHold.hpp', 'InputHold.cpp',
    'LastError.hpp', 'LastError.cpp', 'MicrophonePriority.hpp', 'MicrophonePriority.cpp'].map(file => `cpp/${file}`),
  'ios/IOSAudioDevice.mm',
].map(file => path.join(root, 'platforms', 'mobile', file));
for (const source of [path.join(flutter, 'native'), ...flutterSharedSources]) {
  if (!fs.existsSync(source)) throw new Error(`Flutter native source is missing: ${path.relative(root, source).split(path.sep).join('/')}`);
}
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
const compiler = path.join(root, 'node_modules/typescript/bin/tsc');
execFileSync(process.execPath, [compiler, '-p', path.join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });

for (const platform of ['desktop', 'web', 'mobile']) {
  const destination = path.join(root, 'platforms', platform);
  const pkg = JSON.parse(fs.readFileSync(path.join(destination, 'package.json')));
  const runtime = path.join(destination, 'runtime');
  fs.rmSync(runtime, { recursive: true, force: true });
  execFileSync(process.execPath, [compiler, '-p', path.join(root, `tsconfig.runtime.${platform}.json`), '--outDir', runtime], { cwd: root, stdio: 'inherit' });
  if (platform === 'desktop') {
    for (const entry of ['screen/client/types', 'screen/client/screen-capture-client', 'screen/desktop/electron/screen-capture-process']) {
      for (const extension of ['js', 'd.ts']) {
        if (!fs.existsSync(path.join(runtime, `${entry}.${extension}`))) throw new Error(`SDK screen runtime is missing ${entry}.${extension}`);
      }
    }
  }
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ type: platform === 'desktop' ? 'commonjs' : 'module' }) + '\n');
  fs.rmSync(path.join(destination, 'dist'), { recursive: true, force: true });
  fs.cpSync(path.join(root, 'dist'), path.join(destination, 'dist'), { recursive: true });
  if (platform !== 'web') {
    for (const extension of ['js', 'd.ts']) fs.rmSync(path.join(destination, `dist/installer/copy-web-assets.${extension}`));
  }
  const keys = platform === 'web' ? ['web'] : platform === 'mobile' ? ['ios', 'android'] : Object.keys(release.assets).filter(key => !['web', 'ios', 'android'].includes(key));
  fs.writeFileSync(path.join(destination, 'release-assets.json'), JSON.stringify({ ...release, assets: Object.fromEntries(keys.map(key => [key, release.assets[key]])) }, null, 2) + '\n');
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE'));
  if (platform === 'web') fs.cpSync(path.join(root, 'licenses'), path.join(destination, 'licenses'), { recursive: true });
  if (!fs.existsSync(path.join(destination, pkg.main))) throw new Error(`SDK build is missing ${pkg.main}`);
}

// The Flutter plugin has no TypeScript runtime: it takes the installer, its manifest and the native sources.
fs.rmSync(path.join(flutter, 'dist'), { recursive: true, force: true });
fs.cpSync(path.join(root, 'dist'), path.join(flutter, 'dist'), { recursive: true });
for (const extension of ['js', 'd.ts']) fs.rmSync(path.join(flutter, `dist/installer/copy-web-assets.${extension}`));
fs.writeFileSync(path.join(flutter, 'release-assets.json'), JSON.stringify({ ...release, assets: Object.fromEntries(['ios', 'android'].map(key => [key, release.assets[key]])) }, null, 2) + '\n');
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(flutter, 'LICENSE'));
// CocoaPods cannot reference sources outside the pod folder, so the iOS pod gets a copy. Android uses relative paths.
const podSources = path.join(flutter, 'ios', 'Classes', 'native');
fs.rmSync(podSources, { recursive: true, force: true });
fs.cpSync(path.join(flutter, 'native'), podSources, { recursive: true });
// COPYFILE_EXCL: a shared source must not silently replace a Flutter source of the same name.
for (const source of flutterSharedSources) fs.copyFileSync(source, path.join(podSources, path.basename(source)), fs.constants.COPYFILE_EXCL);
console.log('Built desktop, web, mobile and Flutter SDK packages from SDK sources.');
