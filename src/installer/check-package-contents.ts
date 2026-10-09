import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type PackFile = {
  path: string;
};

type PackInfo = {
  files: PackFile[];
  entryCount: number;
  unpackedSize: number;
};

type ExportTarget = string | { [condition: string]: ExportTarget };
type PackageJson = { exports?: Record<string, ExportTarget> };

// 중첩된 browser/react-native/types 조건도 실제 배포 파일로 연결되어야 한다.
function checkExports(target: ExportTarget, files: Set<string>): void {
  if (typeof target === 'string') {
    if ((target !== './app.plugin.js' && !/^\.\/dist(?:-browser|-native)?\//.test(target)) || target.split('/').includes('..')) {
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

const ROOT = join(__dirname, '..', '..');

function npmPackDryRunJson(): string {
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--json'], {
      encoding: 'utf8',
    });
  }

  if (process.platform === 'win32') {
    return execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm pack --dry-run --json'], {
      encoding: 'utf8',
    });
  }

  return execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
}

function loadPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageJson;
}

export function checkPackageContents(): void {
  const raw = npmPackDryRunJson();
  const [pack] = JSON.parse(raw) as PackInfo[];
  const files = new Set(pack.files.map((file) => file.path));
  const pkg = loadPackageJson();

  const required = [
    'package.json',
    'app.plugin.js',
    'README.md',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/authorization/contracts.js',
    'dist/authorization/contracts.d.ts',
    'dist/authorization/realtime.js',
    'dist/authorization/realtime.d.ts',
    'dist/runtime/engine-runtime.js',
    'dist/runtime/engine-runtime.d.ts',
    'dist/platform/asset-key.js',
    'dist/platform/asset-key.d.ts',
    'dist/installer/artifact-download.js',
    'dist/installer/artifact-download.d.ts',
    'dist/installer/install-binary.js',
    'dist/installer/install-binary.d.ts',
    'dist/installer/install-binary-cli.js',
    'dist/installer/install-binary-cli.d.ts',
    'dist/installer/copy-web-assets.js',
    'dist/installer/copy-web-assets.d.ts',
    'dist/installer/check-binary.js',
    'dist/installer/check-binary.d.ts',
    'dist/installer/check-binary-cli.js',
    'dist/installer/check-binary-cli.d.ts',
    'release-assets.json',
    'licenses/onnxruntime-web/LICENSE',
    'licenses/onnxruntime-web/ThirdPartyNotices.txt',
  ];

  const forbiddenPrefixes = [
    '.claude/',
    '.codex/',
    '.github/',
    'agents/',
    'audio-test/',
    'docs/',
    'rules/',
    'scripts/',
    'skills/',
    'src/',
    'target/',
    'test_data/',
  ];

  const forbiddenSuffixes = ['.map'];

  const missing = required.filter((path) => !files.has(path));
  if (missing.length > 0) {
    throw new Error(`Package is missing required files: ${missing.join(', ')}`);
  }

  if (!pkg.exports?.['.'] || !pkg.exports['./authorization'] ||
      !pkg.exports['./browser'] || !pkg.exports['./react-native'] ||
      pkg.exports['./app.plugin.js'] !== './app.plugin.js') {
    throw new Error('Package exports must expose the built public platform entrypoints');
  }
  checkExports(pkg.exports, files);

  if (
    [...files].some(
      (path) =>
        /\.(?:node|a|lib|so|dylib|dll|wasm|onnx|temc|tellusmodel|aar|jar|class|zip|tar\.gz)$/i.test(path) ||
        path.startsWith('onnxruntime/') ||
        path.startsWith('public/models/') ||
        path.startsWith('vendor/') || path.startsWith('web-assets/'),
    )
  ) {
    throw new Error('Wrapper package must not include native binaries, ORT runtimes, models, or vendor files');
  }

  const forbidden = [...files].filter(
    (path) =>
      forbiddenPrefixes.some((prefix) => path.startsWith(prefix)) ||
      forbiddenSuffixes.some((suffix) => path.endsWith(suffix)),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Package contains forbidden files:\n${forbidden
        .sort()
        .map((path) => `  - ${path}`)
        .join('\n')}`,
    );
  }

  console.log(`Package content check passed: ${pack.entryCount} files, ${pack.unpackedSize} bytes unpacked.`);
}

if (require.main === module) {
  checkPackageContents();
}
