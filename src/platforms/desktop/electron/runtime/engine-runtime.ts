import { existsSync, readdirSync } from 'node:fs';
import { basename, delimiter, dirname, join, normalize } from 'node:path';

import {
  currentAssetKey,
  nativeFileCandidates,
  ortRuntimeKeys,
} from '../../../../bindings/typescript/asset-key.js';

const PACKAGE_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const { platform } = process;

function assetRoots(): string[] {
  const key = currentAssetKey();
  const platformVendorDir = platform === 'darwin' ? 'darwin-universal' : key;
  const packageRoots = packageRootCandidates();
  return uniquePaths([
    ...packageRoots.map((root) => join(root, 'vendor', platformVendorDir)),
    ...packageRoots,
  ]);
}

function packageRootCandidates(): string[] {
  const developmentRoot = basename(PACKAGE_ROOT) === 'dist' ? dirname(PACKAGE_ROOT) : null;
  const roots = developmentRoot ? [PACKAGE_ROOT, developmentRoot] : [PACKAGE_ROOT];
  const unpackedRoot = asarUnpackedPath(PACKAGE_ROOT);
  if (!unpackedRoot) {
    return roots;
  }

  return [unpackedRoot, ...roots];
}

function asarUnpackedPath(filePath: string): string | null {
  const unpackedPath = filePath.replace(/(^|[/\\])app\.asar(?=([/\\]|$))/, '$1app.asar.unpacked');

  return unpackedPath === filePath ? null : unpackedPath;
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

function resolveExistingPath(candidate: string): string | null {
  if (existsSync(candidate)) {
    return candidate;
  }

  const fileName = basename(candidate);
  if (fileName !== 'libonnxruntime.so') {
    return null;
  }

  const dir = dirname(candidate);
  if (!existsSync(dir)) {
    return null;
  }

  const versionedFileName = readdirSync(dir).find((entry) => entry.startsWith(`${fileName}.`));
  return versionedFileName ? join(dir, versionedFileName) : null;
}

function findExistingPath(relativePaths: string[]): string | null {
  for (const root of assetRoots()) {
    for (const relativePath of relativePaths) {
      const found = resolveExistingPath(join(root, relativePath));
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function configureOrtDylibPath(): void {
  if (process.env.ORT_DYLIB_PATH) {
    process.env.ORT_DYLIB_PATH = normalize(process.env.ORT_DYLIB_PATH);
    return;
  }
  const fileNameByPlatform: Record<string, string> = {
    darwin: 'libonnxruntime.dylib',
    linux: 'libonnxruntime.so',
    win32: 'onnxruntime.dll',
  };
  const fileName = fileNameByPlatform[platform];
  if (!fileName) {
    return;
  }

  const relativePaths =
    platform === 'darwin'
      ? [join('onnxruntime', 'darwin-universal', fileName)]
      : [
          ...ortRuntimeKeys().map((runtimeKey) => join('onnxruntime', runtimeKey, fileName)),
          join('onnxruntime', fileName),
          fileName,
        ];
  const found = findExistingPath(relativePaths);
  if (found) {
    process.env.ORT_DYLIB_PATH = found;
  }
}

function configureModelDir(): void {
  if (process.env.TELLUS_AUDIO_ENGINE_MODEL_DIR) {
    process.env.TELLUS_AUDIO_ENGINE_MODEL_DIR = normalize(process.env.TELLUS_AUDIO_ENGINE_MODEL_DIR);
    return;
  }

  for (const root of assetRoots()) {
    const modelDir = join(root, 'models');
    if (existsSync(modelDir)) {
      process.env.TELLUS_AUDIO_ENGINE_MODEL_DIR = modelDir;
      return;
    }
  }
}

function loadNativeBinding(): any {
  configureOrtDylibPath();
  configureModelDir();

  const candidates = nativeFileCandidates();
  if (basename(PACKAGE_ROOT) === 'dist' && platform === 'darwin') {
    candidates.unshift(`audio-capture.${currentAssetKey()}.node`);
  }
  const nativePath = findExistingPath(candidates);
  if (!nativePath) {
    throw new Error(
      [
        `Failed to find Tellus audio engine native binary for ${currentAssetKey()}.`,
        'Run the SDK installer after installing @tellus-ai/audio-sdk-desktop.',
      ].join(' '),
    );
  }

  if (platform === 'win32') {
    // SDK는 엔진 index.js를 거치지 않으므로 동봉 MSVC DLL의 검색 경로도 준비한다.
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'Path';
    const currentPath = process.env[pathKey];
    const nativeDir = normalize(dirname(nativePath));
    const nativeDirKey = nativeDir.replace(/[\\/]+$/, '').toLowerCase();
    const otherPaths = (currentPath ? currentPath.split(delimiter) : []).filter(
      (entry) => normalize(entry).replace(/[\\/]+$/, '').toLowerCase() !== nativeDirKey,
    );
    process.env[pathKey] = [nativeDir, ...otherPaths].join(delimiter);
  }

  return require(nativePath);
}

export function prepareEngineRuntime(): {
  nativeBinding: any;
} {
  return {
    nativeBinding: loadNativeBinding(),
  };
}
