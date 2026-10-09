#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function runAws(args) {
  return execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function publishRelease({ directory, version, bucket, environment, runAws: execute = runAws }) {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
    throw new Error('A stable release version X.Y.Z is required');
  }
  if (!bucket || !directory) throw new Error('AUDIO_ARTIFACTS_S3_BUCKET and release directory are required');
  if (!['dev', 'stg', 'prod'].includes(environment)) {
    throw new Error('AUDIO_ARTIFACTS_ENVIRONMENT must be dev, stg, or prod');
  }
  const files = [];
  for (const filename of ['desktop', 'web', 'mobile'].map(platform => `tellus-ai-audio-sdk-${platform}-${version}.tgz`)) {
    const body = fs.readFileSync(path.join(directory, filename));
    const digest = createHash('sha256').update(body).digest('hex');
    const checksum = fs.readFileSync(path.join(directory, `${filename}.sha256`), 'utf8').trim();
    if (checksum !== `${digest}  ${filename}` && checksum !== `${digest} *${filename}`) {
      throw new Error(`Release checksum mismatch: ${filename}`);
    }
    files.push(filename, `${filename}.sha256`);
  }
  for (const filename of files) {
    const bodyPath = path.join(directory, filename);
    const digest = createHash('sha256').update(fs.readFileSync(bodyPath)).digest('base64');
    const key = `${environment}/audio/sdk/v${version}/${filename}`;
    try {
      execute([
        's3api', 'put-object', '--bucket', bucket, '--key', key, '--body', bodyPath,
        '--if-none-match', '*', '--checksum-algorithm', 'SHA256', '--checksum-sha256', digest,
        '--content-type', filename.endsWith('.sha256') ? 'text/plain' : 'application/gzip',
        '--server-side-encryption', 'AES256', '--output', 'json',
      ]);
    } catch (error) {
      if (!String(error.stderr).includes('PreconditionFailed')) throw error;
      const existing = JSON.parse(execute([
        's3api', 'head-object', '--bucket', bucket, '--key', key,
        '--checksum-mode', 'ENABLED', '--output', 'json',
      ]));
      if (existing.ChecksumSHA256 !== digest) {
        throw new Error(`Release object already exists with different content: ${key}`);
      }
    }
    console.log(`Verified release object: s3://${bucket}/${key}`);
  }
}

if (require.main === module) {
  try {
    publishRelease({
      version: process.argv[2],
      directory: process.argv[3],
      bucket: process.env.AUDIO_ARTIFACTS_S3_BUCKET,
      environment: process.env.AUDIO_ARTIFACTS_ENVIRONMENT,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { publishRelease };
