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

type PackageJson = {
  exports?: {
    '.'?: {
      types?: string;
      require?: string;
      default?: string;
    };
  };
};

const ROOT = join(__dirname, '..', '..');

function npmPackDryRunJson(): string {
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--json'], {
      encoding: 'utf8',
    });
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return execFileSync(npmCommand, ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
  });
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
    'README.md',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/runtime/engine-runtime.js',
    'dist/runtime/engine-runtime.d.ts',
    'dist/platform/asset-key.js',
    'dist/platform/asset-key.d.ts',
    'dist/installer/install-binary.js',
    'dist/installer/install-binary.d.ts',
    'dist/installer/install-binary-cli.js',
    'dist/installer/install-binary-cli.d.ts',
    'dist/installer/check-binary.js',
    'dist/installer/check-binary.d.ts',
    'dist/installer/check-binary-cli.js',
    'dist/installer/check-binary-cli.d.ts',
    'release-assets.json',
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
  const allowedDistFiles = new Set(required.filter((path) => path.startsWith('dist/')));

  const missing = required.filter((path) => !files.has(path));
  if (missing.length > 0) {
    throw new Error(`Package is missing required files: ${missing.join(', ')}`);
  }

  if (
    pkg.exports?.['.']?.types !== './dist/index.d.ts' ||
    pkg.exports?.['.']?.require !== './dist/index.js' ||
    pkg.exports?.['.']?.default !== './dist/index.js'
  ) {
    throw new Error('Package exports must expose only the built public entrypoint');
  }

  if (
    [...files].some(
      (path) =>
        /^audio-capture\..+\.node$/.test(path) ||
        path.startsWith('onnxruntime/') ||
        path.startsWith('public/models/') ||
        path.startsWith('vendor/'),
    )
  ) {
    throw new Error('Wrapper package must not include native binaries, ORT runtimes, models, or vendor files');
  }

  const forbidden = [...files].filter(
    (path) =>
      (forbiddenPrefixes.some((prefix) => path.startsWith(prefix)) && !allowedDistFiles.has(path)) ||
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
