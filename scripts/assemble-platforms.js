const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--engine-dist')) {
  throw new Error('Usage: assemble-platforms [--engine-dist <built-engine-dist>]');
}
const engineDist = path.resolve(args[1] ?? process.env.TELLUS_AUDIO_ENGINE_DIST ?? path.join(root, '../Tellus-audio-engine/dist'));
const release = JSON.parse(fs.readFileSync(path.join(root, 'release-assets.json')));
for (const platform of ['desktop', 'web', 'mobile']) {
  const kit = path.join(engineDist, platform);
  const metadata = JSON.parse(fs.readFileSync(path.join(kit, 'engine-kit.json')));
  if (metadata.platform !== platform || metadata.nativeEngineVersion !== release.nativeEngineVersion) {
    throw new Error(`Engine kit does not match pinned ${platform} engine ${release.nativeEngineVersion}`);
  }
}
const assetKey = path.join(engineDist, 'desktop/bindings/typescript/asset-key');
fs.mkdirSync(path.join(root, '.generated/platform'), { recursive: true });
fs.copyFileSync(`${assetKey}.d.ts`, path.join(root, '.generated/platform/asset-key.d.ts'));
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' });
fs.mkdirSync(path.join(root, 'dist/platform'), { recursive: true });
for (const extension of ['js', 'd.ts']) fs.copyFileSync(`${assetKey}.${extension}`, path.join(root, `dist/platform/asset-key.${extension}`));

for (const platform of ['desktop', 'web', 'mobile']) {
  const destination = path.join(root, 'platforms', platform);
  const kit = path.join(engineDist, platform);
  const pkg = JSON.parse(fs.readFileSync(path.join(destination, 'package.json')));
  if (pkg.version !== release.sdkVersion) throw new Error(`${platform} package version differs from pinned SDK version`);
  fs.rmSync(path.join(destination, 'runtime'), { recursive: true, force: true });
  fs.cpSync(kit, path.join(destination, 'runtime'), {
    recursive: true,
    filter: source => !['cpp', 'ios', 'android', 'nitrogen'].includes(path.relative(kit, source).split(path.sep)[0]),
  });
  fs.rmSync(path.join(destination, 'dist'), { recursive: true, force: true });
  fs.cpSync(path.join(root, 'dist'), path.join(destination, 'dist'), { recursive: true });
  if (platform !== 'web') {
    for (const extension of ['js', 'd.ts']) fs.rmSync(path.join(destination, `dist/installer/copy-web-assets.${extension}`));
  }
  const keys = platform === 'web' ? ['web'] : platform === 'mobile' ? ['ios', 'android'] : Object.keys(release.assets).filter(key => !['web', 'ios', 'android'].includes(key));
  fs.writeFileSync(path.join(destination, 'release-assets.json'), JSON.stringify({ ...release, assets: Object.fromEntries(keys.map(key => [key, release.assets[key]])) }, null, 2) + '\n');
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE'));
  if (platform === 'mobile') {
    for (const directory of ['cpp', 'ios', 'android/src', 'nitrogen/generated']) {
      const source = path.join(kit, directory);
      if (!fs.existsSync(source)) throw new Error(`Mobile engine kit is missing ${directory}`);
      fs.rmSync(path.join(destination, directory), { recursive: true, force: true });
      fs.mkdirSync(path.dirname(path.join(destination, directory)), { recursive: true });
      fs.cpSync(source, path.join(destination, directory), { recursive: true });
    }
  }
  if (platform === 'web') fs.cpSync(path.join(root, 'licenses'), path.join(destination, 'licenses'), { recursive: true });
  if (!fs.existsSync(path.join(destination, pkg.main))) throw new Error(`Engine kit is missing ${pkg.main}`);
}
console.log('Assembled desktop, web and mobile SDK packages from built engine kits.');
