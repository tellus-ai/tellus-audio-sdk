import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { currentAssetKey, nativeFileCandidates, ortRuntimeKeys } from '../platform/asset-key';

const ROOT = join(__dirname, '..', '..');

function fail(message: string): never {
  throw new Error(message);
}

function currentPlatformDir(): string {
  return process.platform === 'darwin' ? 'darwin-universal' : currentAssetKey();
}

function ortRuntimeFile(): string {
  if (process.platform === 'darwin') {
    return 'libonnxruntime.dylib';
  }
  if (process.platform === 'win32') {
    return 'onnxruntime.dll';
  }
  return 'libonnxruntime.so';
}

function existsWithVersionFallback(root: string, relativePath: string): boolean {
  const absolutePath = join(root, relativePath);
  if (existsSync(absolutePath)) {
    return true;
  }

  const fileName = basename(absolutePath);
  if (fileName !== 'libonnxruntime.so') {
    return false;
  }

  const dir = dirname(absolutePath);
  if (!existsSync(dir)) {
    return false;
  }

  return readdirSync(dir).some((entry) => entry.startsWith(`${fileName}.`));
}

function hasAny(root: string, relativePaths: string[]): boolean {
  return relativePaths.some((relativePath) => existsWithVersionFallback(root, relativePath));
}

function requiredNativeFiles(): string[] {
  if (process.platform === 'darwin') {
    return ['audio-capture.darwin-universal.node'];
  }
  return nativeFileCandidates();
}

function requiredOrtRuntimePaths(): string[] {
  const fileName = ortRuntimeFile();
  if (process.platform === 'darwin') {
    return [join('onnxruntime', 'darwin-universal', fileName)];
  }
  return [
    ...ortRuntimeKeys().map((dir) => join('onnxruntime', dir, fileName)),
    join('onnxruntime', fileName),
    fileName,
  ];
}

export function checkBinary(platform?: string): void {
  const packagePlatform = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { tellusPlatform?: string }).tellusPlatform;
  if (packagePlatform === 'web' || packagePlatform === 'mobile') {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'release-assets.json'), 'utf8')) as { assets: Record<string, { requiredFiles: string[] }> };
    const selectedPlatform = platform ?? process.env.TELLUS_AUDIO_ENGINE_PLATFORM;
    const targets = selectedPlatform !== undefined ? [selectedPlatform] :
      packagePlatform === 'web' ? ['web'] : ['ios', 'android'];
    for (const target of targets) {
      const asset = manifest.assets[target];
      if (!asset?.requiredFiles.length) fail(`Release asset does not include the installation target: ${target}`);
      const missing = asset.requiredFiles.filter(file => {
        const filename = join(ROOT, 'vendor', target, file);
        return !existsSync(filename) || !statSync(filename).isFile();
      });
      if (missing.length) fail(`Binary asset is missing required files: ${target}: ${missing.join(', ')}`);
    }
    console.log(`[tellus-audio-sdk] binary assets verified: ${targets.join(', ')}`);
    return;
  }
  if (platform !== undefined) fail('Desktop binary verification selects the current host platform');
  const platformDir = currentPlatformDir();
  const root = join(ROOT, 'vendor', platformDir);
  const nativeFiles = requiredNativeFiles();
  const missingNativeFiles = nativeFiles.filter((file) => !existsWithVersionFallback(root, file));
  const ortRuntimePaths = requiredOrtRuntimePaths();

  if (!existsSync(root)) {
    fail(`Binary asset directory is missing: vendor/${platformDir}`);
  }
  if (missingNativeFiles.length > 0) {
    fail(`Native binary is missing: ${missingNativeFiles.join(', ')}`);
  }
  if (!hasAny(root, ortRuntimePaths)) {
    fail(`ONNX Runtime file is missing: ${ortRuntimePaths.join(', ')}`);
  }

  const mod = require(ROOT);
  if (typeof mod.AudioCapture !== 'function') {
    fail('AudioCapture export was not found.');
  }

  console.log(`[tellus-audio-sdk] binary asset verified: vendor/${platformDir}`);
}
