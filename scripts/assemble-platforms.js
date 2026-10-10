const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
if (process.argv.length > 2) throw new Error('Usage: assemble-platforms');
const release = JSON.parse(fs.readFileSync(path.join(root, 'release-assets.json')));
for (const platform of ['desktop', 'web', 'mobile']) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'platforms', platform, 'package.json')));
  if (pkg.version !== release.sdkVersion) throw new Error(`${platform} package version differs from pinned SDK version`);
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
console.log('Built desktop, web and mobile SDK packages from SDK sources.');
