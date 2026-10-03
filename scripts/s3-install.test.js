const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { test } = require('node:test');

function installerFixture(t, { corrupt = false, denied = false, baseUrl = 'https://speech.example.test', redirectLocation } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(__dirname, '../dist'), path.join(root, 'dist'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../release-assets.json')));
  fs.writeFileSync(path.join(root, 'release-assets.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: manifest.sdkVersion }));
  const key = require(path.join(root, 'dist/platform/asset-key')).currentAssetKey();
  const asset = manifest.assets[key];
  const content = path.join(root, 'content');
  fs.mkdirSync(content);
  fs.writeFileSync(path.join(content, 'installed.txt'), 'verified native archive');
  execFileSync('tar', ['-czf', path.join(root, 'archive.tar.gz'), '-C', content, 'installed.txt']);
  const archive = fs.readFileSync(path.join(root, 'archive.tar.gz'));
  const digest = createHash('sha256').update(archive).digest('hex');
  const requests = [];
  const originalGet = https.get;
  const oldBase = process.env.TELLUS_AUDIO_DOWNLOAD_BASE_URL;
  const oldToken = process.env.TELLUS_AUDIO_ENGINE_TOKEN;
  process.env.TELLUS_AUDIO_DOWNLOAD_BASE_URL = baseUrl;
  process.env.TELLUS_AUDIO_ENGINE_TOKEN = 'login-access-token';
  t.after(() => {
    https.get = originalGet;
    if (oldBase === undefined) delete process.env.TELLUS_AUDIO_DOWNLOAD_BASE_URL;
    else process.env.TELLUS_AUDIO_DOWNLOAD_BASE_URL = oldBase;
    if (oldToken === undefined) delete process.env.TELLUS_AUDIO_ENGINE_TOKEN;
    else process.env.TELLUS_AUDIO_ENGINE_TOKEN = oldToken;
  });
  https.get = (url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => request.emit('error', error);
    requests.push({ url, headers: options.headers });
    process.nextTick(() => {
      const parsed = new URL(url);
      let statusCode = 200;
      let body = Buffer.alloc(0);
      const headers = {};
      if (parsed.origin === 'https://speech.example.test') {
        statusCode = denied ? 401 : 307;
        headers.location = redirectLocation ?? `https://bucket.s3.ap-northeast-2.amazonaws.com${parsed.pathname}?X-Amz-Signature=private-signature`;
      } else if (parsed.hostname.endsWith('.amazonaws.com')) {
        body = parsed.pathname.endsWith('.sha256')
          ? Buffer.from(`${corrupt ? '0'.repeat(64) : digest}  ${asset.file}\n`)
          : archive;
      } else {
        statusCode = 403;
      }
      const response = Readable.from([body]);
      response.statusCode = statusCode;
      response.headers = headers;
      callback(response);
    });
    return request;
  };
  const { installBinary } = require(path.join(root, 'dist/installer/install-binary'));
  return { root, installBinary, requests, asset, manifest };
}

test('installs the pinned S3 artifact through authenticated Speech redirects without forwarding the login token', async (t) => {
  const { root, installBinary, requests, asset, manifest } = installerFixture(t);
  await installBinary();
  const serviceRequests = requests.filter(({ url }) => new URL(url).hostname === 'speech.example.test');
  assert.deepEqual(serviceRequests.map(({ url }) => url), [
    `https://speech.example.test/v1/audio-artifacts/engine/${manifest.nativeEngineVersion}/${asset.sha256File}`,
    `https://speech.example.test/v1/audio-artifacts/engine/${manifest.nativeEngineVersion}/${asset.file}`,
  ]);
  assert.ok(serviceRequests.every(({ headers }) => headers.Authorization === 'Bearer login-access-token'));
  const s3Requests = requests.filter(({ url }) => new URL(url).hostname.endsWith('.amazonaws.com'));
  assert.equal(s3Requests.length, 2);
  assert.ok(s3Requests.every(({ headers }) => headers.Authorization === undefined));
  const target = path.join(root, 'vendor', asset.platform);
  assert.equal(fs.readFileSync(path.join(target, 'installed.txt'), 'utf8'), 'verified native archive');
  const state = fs.readFileSync(path.join(target, '.install-state.json'), 'utf8');
  assert.ok(!state.includes('private-signature'));
  assert.ok(!state.includes('login-access-token'));
});

test('rejects a corrupt S3 archive before replacing the installed engine', async (t) => {
  const { root, installBinary, asset } = installerFixture(t, { corrupt: true });
  const target = path.join(root, 'vendor', asset.platform);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'installed.txt'), 'previous engine');
  await assert.rejects(installBinary(), /sha256 mismatch/);
  assert.equal(fs.readFileSync(path.join(target, 'installed.txt'), 'utf8'), 'previous engine');
  assert.deepEqual(fs.readdirSync(path.join(root, 'vendor')), [asset.platform]);
});

test('does not fall back to GitHub when Speech rejects the download credentials', async (t) => {
  const { installBinary, requests } = installerFixture(t, { denied: true });
  await assert.rejects(installBinary(), /HTTP 401/);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).hostname, 'speech.example.test');
});

for (const baseUrl of ['http://speech.example.test', 'https://user:password@speech.example.test', 'https://speech.example.test?secret=value']) {
  test(`rejects an unsafe download service URL: ${new URL(baseUrl).protocol} ${new URL(baseUrl).hostname}`, async (t) => {
    const { installBinary, requests } = installerFixture(t, { baseUrl });
    await assert.rejects(installBinary(), /TELLUS_AUDIO_DOWNLOAD_BASE_URL/);
    assert.equal(requests.length, 0);
  });
}

test('rejects a downgrade redirect before sending any request or login token over HTTP', async (t) => {
  const { installBinary, requests } = installerFixture(t, { redirectLocation: 'http://bucket.example.test/archive' });
  await assert.rejects(installBinary(), /require HTTPS/);
  assert.equal(requests.length, 1);
});

test('reports a malformed redirect as an installation failure', async (t) => {
  const { installBinary, requests } = installerFixture(t, { redirectLocation: 'https://[' });
  await assert.rejects(installBinary(), /invalid download redirect/);
  assert.equal(requests.length, 1);
});
