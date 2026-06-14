import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

import { currentAssetKey } from '../platform/asset-key';

type ReleaseAsset = {
  platform?: string;
  file?: string;
  sha256File?: string;
};

type ReleaseManifest = {
  sdkVersion: string;
  nativeEngineVersion: string;
  nativeEngineTag: string;
  assets?: Record<string, ReleaseAsset>;
};

type DownloadOptions = {
  label: string;
  url: string;
  destination: string;
  token: string;
  manifest: ReleaseManifest;
  key: string;
};

type GitHubReleaseAsset = {
  name?: string;
  url?: string;
};

type GitHubRelease = {
  assets?: GitHubReleaseAsset[];
};

const ROOT = join(__dirname, '..', '..');
const NATIVE_ENGINE_REPOSITORY = 'tellus-ai/Tellus-audio-engine';
const MISSING_TOKEN_MESSAGE =
  'TELLUS_AUDIO_ENGINE_TOKEN is required for GitHub release asset downloads. ' +
  'Set TELLUS_AUDIO_ENGINE_TOKEN in your project .env file or export it in your terminal before installing. ' +
  'For more details, contact lucas@tellus.ai.kr.';

function log(message: string): void {
  console.log(`[tellus-audio-sdk] ${message}`);
}

function fail(message: string): never {
  throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadManifest(): ReleaseManifest {
  return JSON.parse(readFileSync(join(ROOT, 'release-assets.json'), 'utf8')) as ReleaseManifest;
}

function loadPackageVersion(): string {
  return (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
}

function assertManifestVersion(manifest: ReleaseManifest): void {
  const packageVersion = loadPackageVersion();
  if (manifest.sdkVersion !== packageVersion) {
    fail(`manifest sdkVersion mismatch: package=${packageVersion}, manifest=${manifest.sdkVersion || '(missing)'}`);
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.nativeEngineVersion || '')) {
    fail(`manifest nativeEngineVersion is invalid: ${manifest.nativeEngineVersion || '(missing)'}`);
  }
  if (manifest.nativeEngineTag !== `v${manifest.nativeEngineVersion}`) {
    fail(
      `manifest nativeEngineTag mismatch: expected v${manifest.nativeEngineVersion}, got ${manifest.nativeEngineTag || '(missing)'}`,
    );
  }
}

function parseDotEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed.replace(/\s+#.*$/, '');
}

function tokenFromProjectDotEnv(): string {
  if (!process.env.INIT_CWD) {
    return '';
  }

  const filePath = join(process.env.INIT_CWD, '.env');
  if (!existsSync(filePath)) {
    return '';
  }

  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.trim().match(/^(?:export\s+)?TELLUS_AUDIO_ENGINE_TOKEN\s*=\s*(.*)$/);
    if (match) {
      return parseDotEnvValue(match[1]);
    }
  }
  return '';
}

function tokenForDownload(): string {
  return process.env.TELLUS_AUDIO_ENGINE_TOKEN || tokenFromProjectDotEnv();
}

function assertAssetVersion(asset: ReleaseAsset, manifest: ReleaseManifest): void {
  for (const field of ['file', 'sha256File'] as const) {
    if (asset[field] && !asset[field].includes(manifest.nativeEngineTag)) {
      fail(`${field} must include native engine tag ${manifest.nativeEngineTag}: ${asset[field]}`);
    }
  }
}

function requestHeaders(url: string, token: string, accept = 'application/octet-stream'): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'tellus-audio-sdk-installer',
    Accept: accept,
  };
  if (token && new URL(url).hostname === 'api.github.com') {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function downloadToFile(url: string, destination: string, token: string, redirectCount = 0): Promise<void> {
  if (url.startsWith('file://')) {
    return Promise.reject(new Error('local file URLs are not supported for binary downloads'));
  }

  if (redirectCount > 5) {
    return Promise.reject(new Error('too many redirects'));
  }

  return new Promise((resolvePromise, reject) => {
    const request = get(url, { headers: requestHeaders(url, token) }, (response) => {
      const statusCode = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        response.resume();
        const { location } = response.headers;
        if (!location) {
          reject(new Error(`redirect without Location header: ${statusCode}`));
          return;
        }
        const nextUrl = new URL(location, url).toString();
        downloadToFile(nextUrl, destination, token, redirectCount + 1).then(resolvePromise, reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`download failed with HTTP ${statusCode}`));
        return;
      }

      const output = createWriteStream(destination, { mode: 0o600 });
      response.pipe(output);
      output.on('finish', () => output.close(() => resolvePromise()));
      output.on('error', reject);
    });

    request.on('error', reject);
  });
}

function getJson<T>(url: string, token: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const request = get(url, { headers: requestHeaders(url, token, 'application/vnd.github+json') }, (response) => {
      const statusCode = response.statusCode || 0;
      const chunks: Buffer[] = [];

      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`GitHub API request failed with HTTP ${statusCode}`));
          return;
        }

        try {
          resolvePromise(JSON.parse(body) as T);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on('error', reject);
  });
}

async function resolveReleaseAssetUrls(manifest: ReleaseManifest, asset: ReleaseAsset): Promise<{ archiveUrl: string; sha256Url: string }> {
  if (!asset.file || !asset.sha256File) {
    fail('Release asset manifest must include file and sha256File for the current platform');
  }

  const token = tokenForDownload();
  if (!token) {
    fail(MISSING_TOKEN_MESSAGE);
  }

  const releaseUrl = `https://api.github.com/repos/${NATIVE_ENGINE_REPOSITORY}/releases/tags/${encodeURIComponent(
    manifest.nativeEngineTag,
  )}`;
  const release = await getJson<GitHubRelease>(releaseUrl, token);
  const archive = release.assets?.find((candidate) => candidate.name === asset.file);
  const checksum = release.assets?.find((candidate) => candidate.name === asset.sha256File);
  if (!archive?.url) {
    fail(`GitHub release asset was not found: ${asset.file}`);
  }
  if (!checksum?.url) {
    fail(`GitHub release asset checksum was not found: ${asset.sha256File}`);
  }

  return {
    archiveUrl: archive.url,
    sha256Url: checksum.url,
  };
}

function sha256(filePath: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function readExpectedSha256(filePath: string): string {
  const content = readFileSync(filePath, 'utf8').trim();
  const match = content.match(/[a-fA-F0-9]{64}/);
  if (!match) {
    fail(`Invalid sha256 file format: ${filePath}`);
  }
  return match[0].toLowerCase();
}

function assertSafeTarEntries(archivePath: string): void {
  const output = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  for (const entry of output.split(/\r?\n/).filter(Boolean)) {
    if (isAbsolute(entry) || entry.split('/').includes('..')) {
      fail(`Unsafe tar entry is included: ${entry}`);
    }
  }
}

function extractTarGz(archivePath: string, destination: string): void {
  assertSafeTarEntries(archivePath);
  mkdirSync(destination, { recursive: true });
  const archiveArg = relative(destination, archivePath).split(sep).join('/');
  execFileSync('tar', ['-xzf', archiveArg], {
    cwd: destination,
    stdio: 'inherit',
  });
}

function alreadyInstalled(targetDir: string, expectedSha: string): boolean {
  const statePath = join(targetDir, '.install-state.json');
  if (!existsSync(statePath)) {
    return false;
  }
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { sha256?: string };
    return state.sha256 === expectedSha;
  } catch {
    return false;
  }
}

async function downloadRequiredFile(options: DownloadOptions): Promise<void> {
  try {
    await downloadToFile(options.url, options.destination, options.token);
  } catch (error) {
    fail(
      [
        `failed to download ${options.label} for ${options.key}: ${errorMessage(error)}`,
        `url: ${options.url}`,
        `sdkVersion: ${options.manifest.sdkVersion}`,
        `nativeEngineVersion: ${options.manifest.nativeEngineVersion}`,
        `nativeEngineTag: ${options.manifest.nativeEngineTag}`,
        'Please verify release-assets.json and TELLUS_AUDIO_ENGINE_TOKEN, then contact Tellus support if the problem continues.',
      ].join('\n'),
    );
  }
}

export async function installBinary(): Promise<void> {
  const manifest = loadManifest();
  assertManifestVersion(manifest);
  const key = currentAssetKey();
  const asset = manifest.assets?.[key];
  if (!asset) {
    fail(`Release asset manifest does not include the current platform: ${key}`);
  }
  assertAssetVersion(asset, manifest);

  const { archiveUrl, sha256Url } = await resolveReleaseAssetUrls(manifest, asset);

  const platformDir = asset.platform || key;
  const targetDir = join(ROOT, 'vendor', platformDir);
  const tempDir = mkdtempSync(join(tmpdir(), 'tellus-audio-sdk-'));
  const archivePath = join(tempDir, 'asset.tar.gz');
  const shaPath = join(tempDir, 'asset.tar.gz.sha256');
  const token = tokenForDownload();

  try {
    log(`downloading checksum for ${key}`);
    await downloadRequiredFile({
      label: 'checksum',
      url: sha256Url,
      destination: shaPath,
      token,
      manifest,
      key,
    });
    const expectedSha = readExpectedSha256(shaPath);

    if (alreadyInstalled(targetDir, expectedSha)) {
      log(`binary asset already installed: vendor/${platformDir}`);
      return;
    }

    log(`downloading binary asset for ${key}`);
    await downloadRequiredFile({
      label: 'binary asset',
      url: archiveUrl,
      destination: archivePath,
      token,
      manifest,
      key,
    });

    const actualSha = sha256(archivePath);
    if (actualSha !== expectedSha) {
      fail(`sha256 mismatch: expected ${expectedSha}, got ${actualSha}`);
    }

    const extractDir = join(tempDir, 'extract');
    extractTarGz(archivePath, extractDir);
    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(dirname(targetDir), { recursive: true });
    renameSync(extractDir, targetDir);
    writeFileSync(
      join(targetDir, '.install-state.json'),
      JSON.stringify(
        {
          key,
          platform: platformDir,
          sdkVersion: manifest.sdkVersion,
          nativeEngineVersion: manifest.nativeEngineVersion,
          nativeEngineTag: manifest.nativeEngineTag,
          url: archiveUrl,
          sha256: expectedSha,
        },
        null,
        2,
      ),
    );
    log(`binary asset installed: vendor/${platformDir}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
