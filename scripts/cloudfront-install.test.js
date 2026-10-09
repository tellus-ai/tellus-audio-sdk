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

// 실제 파일·압축·다운로드 경계는 기록된 플랫폼 경로의 고정 사례로 검증한다.
const platformFiles = {
  ios: ['TellusAudioEngine.xcframework/Info.plist', 'TellusAudioEngine.xcframework/ios-arm64/libtellus_audio_engine.a',
    'TellusAudioEngine.xcframework/ios-arm64-simulator/libtellus_audio_engine.a', 'include/tellus_audio_engine.h',
    'models/manifest.json', 'models/fe-s16.temc', 'models/fe-s48.temc', 'models/silero-vad.temc'],
  android: ['jniLibs/arm64-v8a/libtellus_audio_engine.so', 'jniLibs/x86_64/libtellus_audio_engine.so',
    'include/tellus_audio_engine.h', 'models/manifest.json', 'models/fe-s16.temc', 'models/fe-s48.temc', 'models/silero-vad.temc'],
  web: ['tellus-audio-engine.mjs', 'tellus-audio-engine.wasm', 'models/manifest.json',
    'models/fe-s16.temc', 'models/fe-s48.temc', 'models/silero-vad.temc'],
};

function installerFixture(t, { corrupt = false, denied = false, baseUrl = 'https://speech.example.test', redirectLocation, grantUrl, malformedGrant = false, cdnDenials = 0, platform, missingFile, packagePlatform } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(__dirname, '../dist'), path.join(root, 'dist'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../release-assets.json')));
  if (platform) {
    const suffix = platform === 'web' ? 'wasm32-emscripten' : platform;
    const file = `tellus-audio-engine-${manifest.nativeEngineTag}-${suffix}.tar.gz`;
    manifest.assets[platform] = { platform, file, sha256File: `${file}.sha256`, requiredFiles: platformFiles[platform] };
  }
  fs.writeFileSync(path.join(root, 'release-assets.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: manifest.sdkVersion, tellusPlatform: packagePlatform }));
  const key = platform || require(path.join(root, 'dist/platform/asset-key')).currentAssetKey();
  const asset = manifest.assets[key];
  const content = path.join(root, 'content');
  fs.mkdirSync(content);
  const payloadFiles = platform ? platformFiles[platform] : ['installed.txt'];
  for (const file of payloadFiles.filter((file) => file !== missingFile)) {
    fs.mkdirSync(path.dirname(path.join(content, file)), { recursive: true });
    fs.writeFileSync(path.join(content, file), 'verified native archive');
  }
  execFileSync('tar', ['-czf', path.join(root, 'archive.tar.gz'), '-C', content, '.']);
  const archive = fs.readFileSync(path.join(root, 'archive.tar.gz'));
  const digest = createHash('sha256').update(archive).digest('hex');
  const requests = [];
  const originalGet = https.get;
  const originalRequest = https.request;
  const oldBase = process.env.TELLUS_AUDIO_DOWNLOAD_BASE_URL;
  const oldToken = process.env.TELLUS_AUDIO_ENGINE_TOKEN;
  process.env.TELLUS_AUDIO_DOWNLOAD_BASE_URL = baseUrl;
  process.env.TELLUS_AUDIO_ENGINE_TOKEN = 'customer-installation-token';
  t.after(() => {
    https.get = originalGet;
    https.request = originalRequest;
    if (oldBase === undefined) delete process.env.TELLUS_AUDIO_DOWNLOAD_BASE_URL;
    else process.env.TELLUS_AUDIO_DOWNLOAD_BASE_URL = oldBase;
    if (oldToken === undefined) delete process.env.TELLUS_AUDIO_ENGINE_TOKEN;
    else process.env.TELLUS_AUDIO_ENGINE_TOKEN = oldToken;
  });
  const httpRequest = (url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.end = () => request;
    request.destroy = (error) => request.emit('error', error);
    requests.push({ url, headers: options.headers, method: options.method || "GET" });
    process.nextTick(() => {
      const parsed = new URL(url);
      let statusCode = 200;
      let body = Buffer.alloc(0);
      const headers = {};
      if (parsed.origin === 'https://speech.example.test') {
        statusCode = denied ? 401 : 200;
        const filename = parsed.pathname.split('/').at(-2);
        body = Buffer.from(malformedGrant ? '{invalid' : JSON.stringify({
          url: grantUrl || `https://download.tellus.ai.kr/dev/audio/engine/v${manifest.nativeEngineVersion}/${filename}`,
          token: `download.${Buffer.from(filename).toString('base64url')}.signature`,
          expires_at: Math.floor(Date.now() / 1000) + 2_592_000,
          token_type: 'Bearer',
        }));
      } else if (parsed.hostname === 'download.tellus.ai.kr') {
        if (cdnDenials > 0) {
          statusCode = 401;
          cdnDenials -= 1;
        } else if (redirectLocation) {
          statusCode = 307;
          headers.location = redirectLocation;
        } else {
          body = parsed.pathname.endsWith('.sha256')
            ? Buffer.from(`${corrupt ? '0'.repeat(64) : digest}  ${asset.file}\n`)
            : archive;
        }
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
  https.get = httpRequest;
  https.request = httpRequest;
  const { installBinary } = require(path.join(root, 'dist/installer/install-binary'));
  return { root, installBinary, requests, asset, manifest };
}

test('installs the pinned CloudFront artifact through dedicated bearer tokens without forwarding the installation token', async (t) => {
  const { root, installBinary, requests, asset, manifest } = installerFixture(t);
  await installBinary();
  const serviceRequests = requests.filter(({ url }) => new URL(url).hostname === 'speech.example.test');
  assert.deepEqual(serviceRequests.map(({ url }) => url), [
    `https://speech.example.test/v1/audio-artifacts/engine/${manifest.nativeEngineVersion}/${asset.sha256File}/token`,
    `https://speech.example.test/v1/audio-artifacts/engine/${manifest.nativeEngineVersion}/${asset.file}/token`,
  ]);
  assert.ok(serviceRequests.every(({ headers, method }) => method === 'POST' && headers.Authorization === 'Bearer customer-installation-token'));
  const cdnRequests = requests.filter(({ url }) => new URL(url).hostname === 'download.tellus.ai.kr');
  assert.equal(cdnRequests.length, 2);
  assert.ok(cdnRequests.every(({ headers }) => headers.Authorization.startsWith("Bearer download.")));
  const target = path.join(root, 'vendor', asset.platform);
  assert.equal(fs.readFileSync(path.join(target, 'installed.txt'), 'utf8'), 'verified native archive');
  const state = fs.readFileSync(path.join(target, '.install-state.json'), 'utf8');
  assert.ok(!state.includes('download.'));
  assert.ok(cdnRequests.every(({ url }) => new URL(url).search === ''));
  assert.ok(!state.includes('customer-installation-token'));
});

test('rejects a corrupt CloudFront archive before replacing the installed engine', async (t) => {
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

for (const redirectLocation of ['http://download.tellus.ai.kr/other', 'https://attacker.example.test/file', 'https://download.tellus.ai.kr/other']) {
  test(`rejects CDN redirects without forwarding a download token: ${redirectLocation}`, async (t) => {
    const { installBinary, requests } = installerFixture(t, { redirectLocation });
    await assert.rejects(installBinary(), /HTTP 307/);
    assert.equal(requests.length, 2);
  });
}
for (const grantUrl of ['http://download.tellus.ai.kr/file', 'https://attacker.example.test/file', 'https://download.tellus.ai.kr/file?token=secret', 'https://download.tellus.ai.kr/prod/audio/engine/v9.9.9/other.tar.gz']) {
  test(`rejects an unexpected token download URL: ${grantUrl}`, async (t) => {
    const { installBinary, requests } = installerFixture(t, { grantUrl });
    await assert.rejects(installBinary(), /invalid artifact download grant/);
    assert.equal(requests.length, 1);
  });
}
test('rejects malformed grant JSON without a CDN request', async (t) => {
  const { installBinary, requests } = installerFixture(t, { malformedGrant: true });
  await assert.rejects(installBinary(), /invalid artifact download grant/);
  assert.equal(requests.length, 1);
});


test('gets a fresh download token once after a CDN authentication failure', async (t) => {
  const { installBinary, requests } = installerFixture(t, { cdnDenials: 1 });
  await installBinary();
  assert.equal(requests.filter(({ method }) => method === 'POST').length, 3);
  assert.equal(requests.length, 6);
});
test('stops after a second CDN authentication failure', async (t) => {
  const { installBinary, requests } = installerFixture(t, { cdnDenials: 2 });
  await assert.rejects(installBinary(), /HTTP 401/);
  assert.equal(requests.length, 4);
});

for (const platform of ['ios', 'android', 'web']) {
  test(`installs an explicitly selected ${platform} archive with its required payload`, async (t) => {
    const { root, installBinary, requests, asset } = installerFixture(t, { platform });
    await installBinary(platform);
    const target = path.join(root, 'vendor', platform);
    for (const file of platformFiles[platform]) assert.ok(fs.statSync(path.join(target, file)).isFile());
    assert.ok(requests.some(({ url }) => url.endsWith(`/${asset.file}/token`)));
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, '.install-state.json'))).key, platform);
  });
  test(`rejects an incomplete ${platform} archive before replacing the installed asset`, async (t) => {
    const missingFile = platformFiles[platform].at(-1);
    const { root, installBinary } = installerFixture(t, { platform, missingFile });
    const target = path.join(root, 'vendor', platform);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'previous.txt'), 'previous engine');
    await assert.rejects(installBinary(platform), /required.*file|missing.*file/i);
    assert.equal(fs.readFileSync(path.join(target, 'previous.txt'), 'utf8'), 'previous engine');
  });
}

for (const platform of ['ios', 'android', 'web']) {
  test(`selects ${platform} through the explicit environment and repairs missing installed files`, async (t) => {
    const { root, installBinary, requests } = installerFixture(t, { platform });
    const previous = process.env.TELLUS_AUDIO_ENGINE_PLATFORM;
    process.env.TELLUS_AUDIO_ENGINE_PLATFORM = platform;
    t.after(() => {
      if (previous === undefined) delete process.env.TELLUS_AUDIO_ENGINE_PLATFORM;
      else process.env.TELLUS_AUDIO_ENGINE_PLATFORM = previous;
    });
    await installBinary();
    const installed = path.join(root, 'vendor', platform, platformFiles[platform].at(-1));
    fs.rmSync(installed);
    await installBinary();
    assert.ok(fs.statSync(installed).isFile());
    assert.equal(requests.length, 8);
  });
}


test('web package chooses web artifacts on a desktop host', async (t) => {
  const { installBinary, requests } = installerFixture(t, { platform: 'web', packagePlatform: 'web' });
  await installBinary();
  assert.ok(requests.every(({ url }) => !url.includes('darwin') && !url.includes('linux') && !url.includes('win32')));
});
for (const [packagePlatform, target] of [['desktop', 'web'], ['web', 'ios'], ['mobile', undefined], ['mobile', 'web']]) {
  test(`${packagePlatform} rejects the wrong target ${String(target)} before downloading`, async (t) => {
    const { installBinary, requests } = installerFixture(t, { packagePlatform });
    await assert.rejects(installBinary(target), /only installs|requires/);
    assert.equal(requests.length, 0);
  });
}
