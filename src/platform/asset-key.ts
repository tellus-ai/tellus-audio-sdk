import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { platform, arch } = process;

function isMusl(): boolean {
  if (!process.report || typeof process.report.getReport !== 'function') {
    try {
      const lddPath = execSync('which ldd').toString().trim();
      return readFileSync(lddPath, 'utf8').includes('musl');
    } catch {
      return true;
    }
  }

  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
  const { glibcVersionRuntime } = report.header;
  return !glibcVersionRuntime;
}

export function currentAssetKey(): string {
  if (platform === 'darwin') {
    return `darwin-${arch}`;
  }
  if (platform === 'win32' && arch === 'x64') {
    return 'win32-x64-msvc';
  }
  if (platform === 'linux' && arch === 'x64' && !isMusl()) {
    return 'linux-x64-gnu';
  }
  throw new Error(`Unsupported OS or architecture: ${platform}-${arch}`);
}

export function nativeFileCandidates(): string[] {
  if (platform === 'darwin') {
    return ['audio-capture.darwin-universal.node'];
  }
  if (platform === 'win32' && arch === 'x64') {
    return ['audio-capture.win32-x64-msvc.node'];
  }
  if (platform === 'linux' && arch === 'x64' && !isMusl()) {
    return ['audio-capture.linux-x64-gnu.node'];
  }
  return [];
}

export function ortRuntimeKeys(): string[] {
  if (platform === 'darwin') {
    return ['darwin-universal'];
  }
  if (platform === 'win32' && arch === 'x64') {
    return ['win32-x64', 'win32-x64-msvc'];
  }
  if (platform === 'linux' && arch === 'x64' && !isMusl()) {
    return ['linux-x64', 'linux-x64-gnu'];
  }
  return [];
}
