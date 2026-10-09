import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type ExportTarget = string | { [condition: string]: ExportTarget };
type PackageJson = {
  tellusPlatform: 'desktop' | 'web' | 'mobile';
  main: string;
  types: string;
  exports: Record<string, ExportTarget>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function checkExports(target: ExportTarget, files: Set<string>): void {
  if (typeof target === 'string') {
    if ((target !== './app.plugin.js' && !/^\.\/(?:runtime|dist)\//.test(target)) || target.split('/').includes('..')) {
      throw new Error(`Package export must expose a built entrypoint: ${target}`);
    }
    if (!files.has(target.slice(2))) throw new Error(`Package export target is missing: ${target}`);
    return;
  }
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).length === 0) {
    throw new Error('Package exports must contain built entrypoints');
  }
  for (const value of Object.values(target)) checkExports(value, files);
}

// 실제 npm 배포 목록에서 플랫폼 경계와 공개 진입점을 검증한다.
export function checkPackageContents(packageRoot = join(__dirname, '..', '..')): void {
  const npm = process.env.npm_execpath;
  const command = npm ? process.execPath : process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const args = npm ? [npm, 'pack', '--dry-run', '--json', '--ignore-scripts'] :
    process.platform === 'win32' ? ['/d', '/s', '/c', 'npm pack --dry-run --json --ignore-scripts'] :
      ['pack', '--dry-run', '--json', '--ignore-scripts'];
  const raw = execFileSync(command, args, { cwd: packageRoot, encoding: 'utf8' });
  const [pack] = JSON.parse(raw) as { files: { path: string }[]; entryCount: number; unpackedSize: number }[];
  const files = new Set(pack.files.map(file => file.path));
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as PackageJson;
  if (!['desktop', 'web', 'mobile'].includes(pkg.tellusPlatform)) throw new Error('Package must declare its platform');
  const required = ['package.json', 'README.md', 'LICENSE', 'release-assets.json', pkg.main, pkg.types,
    'dist/installer/install-binary-cli.js', 'dist/installer/install-binary.js'];
  if (pkg.tellusPlatform === 'mobile') required.push('app.plugin.js', 'TellusAudioSdk.podspec', 'react-native.config.js',
    'cpp/CaptureSession.cpp', 'ios/IOSAudioDevice.mm', 'android/build.gradle', 'android/CMakeLists.txt',
    'android/src/main/AndroidManifest.xml', 'nitrogen/generated/ios/TellusAudioSdk+autolinking.rb');
  if (pkg.tellusPlatform === 'web') required.push('dist/installer/copy-web-assets.js',
    'licenses/onnxruntime-web/LICENSE', 'licenses/onnxruntime-web/ThirdPartyNotices.txt');
  const missing = required.filter(file => !files.has(file));
  if (missing.length) throw new Error(`Package is missing required files: ${missing.join(', ')}`);
  if (!pkg.exports?.['.'] || !pkg.exports['./authorization'] ||
      (pkg.tellusPlatform === 'mobile' && pkg.exports['./app.plugin.js'] !== './app.plugin.js') ||
      (pkg.tellusPlatform === 'web' && !pkg.exports['./installer'])) throw new Error('Package exports must expose its built public entrypoints');
  checkExports(pkg.exports, files);
  if (pkg.tellusPlatform !== 'web' && pkg.dependencies?.['onnxruntime-web']) throw new Error('Only web may depend on onnxruntime-web');
  if (pkg.tellusPlatform !== 'mobile' && pkg.peerDependencies?.['react-native']) throw new Error('Only mobile may require React Native');
  for (const file of files) {
    if (/\.(?:node|a|lib|so|dylib|dll|wasm|onnx|temc|tellusmodel|aar|jar|class|zip|tar\.gz)$/i.test(file) ||
        /^(?:vendor|onnxruntime|public\/models|web-assets)\//.test(file)) {
      throw new Error(`Wrapper package must not include binaries or models: ${file}`);
    }
    if (/^(?:src|scripts|target|tests|test_data|rules|skills|docs|\.github)\//.test(file) || file.endsWith('.map')) {
      throw new Error(`Package contains forbidden files: ${file}`);
    }
    const otherPlatforms = ['desktop', 'web', 'mobile'].filter(platform => platform !== pkg.tellusPlatform);
    if (otherPlatforms.some(platform => file.startsWith(`runtime/platforms/${platform}/`))) {
      throw new Error(`Package contains another platform runtime: ${file}`);
    }
  }
  console.log(`${pkg.tellusPlatform} package content check passed: ${pack.entryCount} files, ${pack.unpackedSize} bytes unpacked.`);
}

if (require.main === module) checkPackageContents(process.argv[2]);
