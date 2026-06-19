import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  currentAssetKey,
  nativeFileCandidates,
  ortRuntimeKeys,
} from '../platform/asset-key';

const PACKAGE_ROOT = join(__dirname, '..', '..');
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
  const unpackedRoot = asarUnpackedPath(PACKAGE_ROOT);
  if (!unpackedRoot) {
    return [PACKAGE_ROOT];
  }

  return [unpackedRoot, PACKAGE_ROOT];
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

  const nativePath = findExistingPath(nativeFileCandidates());
  if (!nativePath) {
    throw new Error(
      [
        `Failed to find Tellus audio engine native binary for ${currentAssetKey()}.`,
        'Run `node node_modules/@tellus-ai/audio-sdk/scripts/install-binary.js` after installing the package.',
      ].join(' '),
    );
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
