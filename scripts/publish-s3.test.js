const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { publishRelease } = require('./publish-s3');

function releaseFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-s3-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const file of ['tellus-ai-audio-sdk-0.3.0.tgz']) {
    const body = Buffer.from('SDK package archive fixture');
    fs.writeFileSync(path.join(directory, file), body);
    fs.writeFileSync(path.join(directory, `${file}.sha256`), `${createHash('sha256').update(body).digest('hex')}  ${file}\n`);
  }
  return directory;
}

test('publishes all verified release files with conditional writes and S3 SHA-256 verification', (t) => {
  const directory = releaseFixture(t);
  const requests = [];
  publishRelease({ directory, version: '0.3.0', bucket: 'private-artifacts', environment: 'dev', runAws: (args) => { requests.push(args); return '{}'; } });
  assert.equal(requests.length, 2);
  for (const args of requests) {
    assert.deepEqual(args.slice(0, 2), ['s3api', 'put-object']);
    assert.equal(args[args.indexOf('--if-none-match') + 1], '*');
    const file = path.basename(args[args.indexOf('--body') + 1]);
    assert.equal(args[args.indexOf('--key') + 1], `dev/audio/sdk/v0.3.0/${file}`);
    assert.equal(args[args.indexOf('--checksum-sha256') + 1], createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('base64'));
  }
});

test('validates the entire release before uploading any file', (t) => {
  const directory = releaseFixture(t);
  fs.writeFileSync(path.join(directory, 'tellus-ai-audio-sdk-0.3.0.tgz'), 'corrupt');
  const requests = [];
  assert.throws(() => publishRelease({ directory, version: '0.3.0', bucket: 'private-artifacts', environment: 'dev', runAws: (args) => { requests.push(args); return '{}'; } }), /checksum mismatch/);
  assert.equal(requests.length, 0);
});

test('can retry an interrupted release without overwriting existing files', (t) => {
  const directory = releaseFixture(t);
  let lastDigest;
  let reused = 0;
  publishRelease({ directory, version: '0.3.0', bucket: 'private-artifacts', environment: 'dev', runAws: (args) => {
    if (args[1] === 'put-object') {
      lastDigest = args[args.indexOf('--checksum-sha256') + 1];
      throw Object.assign(new Error('AWS conditional write failed'), { stderr: 'PreconditionFailed' });
    }
    reused += 1;
    return JSON.stringify({ ChecksumSHA256: lastDigest });
  } });
  assert.equal(reused, 2);
});

test('refuses to replace different bytes under an existing release version', (t) => {
  const directory = releaseFixture(t);
  assert.throws(() => publishRelease({ directory, version: '0.3.0', bucket: 'private-artifacts', environment: 'dev', runAws: (args) => {
    if (args[1] === 'put-object') throw Object.assign(new Error('conflict'), { stderr: 'PreconditionFailed' });
    return JSON.stringify({ ChecksumSHA256: 'different-checksum' });
  } }), /already exists with different content/);
});

for (const environment of ['dev', 'stg', 'prod']) {
  test(`uploads only to the ${environment} release prefix`, (t) => {
    const directory = releaseFixture(t);
    const keys = [];
    publishRelease({ directory, version: '0.3.0', bucket: 'private-artifacts', environment, runAws: (args) => {
      keys.push(args[args.indexOf('--key') + 1]);
      return '{}';
    } });
    assert.ok(keys.every(key => key.startsWith(`${environment}/audio/sdk/v0.3.0/`)));
  });
}

for (const environment of [undefined, '', 'production', '../prod', 'dev/../prod', 'prod/', 'DEV']) {
  test(`rejects invalid environment ${String(environment)} before uploading`, (t) => {
    const directory = releaseFixture(t);
    const calls = [];
    assert.throws(() => publishRelease({ directory, version: '0.3.0', bucket: 'private-artifacts', environment,
      runAws: (args) => { calls.push(args); return '{}'; } }), /AUDIO_ARTIFACTS_ENVIRONMENT/);
    assert.equal(calls.length, 0);
  });
}
