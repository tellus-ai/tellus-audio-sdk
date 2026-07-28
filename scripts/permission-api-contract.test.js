const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8');

test('speaker permission exports expose only structured result APIs', () => {
  const expectedExports = [
    'checkSpeakerCapturePermissionInfo',
    'probeSpeakerCapturePermissionInfo',
    'requestInitialSystemAudioPermissionOpen',
    'requestSystemAudioPermission',
    'requestScreenCapturePermission',
  ];

  for (const name of expectedExports) {
    assert.match(source, new RegExp(`export const ${name}\\b`));
  }

  for (const legacyName of [
    'probeSpeakerCapture',
    'checkSpeakerCapturePermission',
    'checkSystemAudioCapturePermission',
    'checkSystemAudioCapturePermissionInfo',
    'requestSystemAudioCapturePermission',
    'requestInitialSystemAudioPermission',
  ]) {
    assert.doesNotMatch(source, new RegExp(`export const ${legacyName}\\b`));
  }

  assert.doesNotMatch(source, /nativeProbeSpeakerCapture\b/);
  assert.doesNotMatch(source, /nativeCheckSpeakerCapturePermission\b/);
  assert.doesNotMatch(source, /nativeRequestSystemAudioCapturePermission\b/);
  assert.doesNotMatch(source, /nativeRequestInitialSystemAudioPermission\b/);
  assert.match(source, /typeof nativeCheckSpeakerCapturePermissionInfo === 'function'/);
  assert.match(source, /typeof nativeProbeSpeakerCapturePermissionInfo === 'function'/);
});

test('speaker permission probe exposes permission and capture health as separate diagnostics', () => {
  for (const field of [
    'reason?: string',
    'probeStage?: string',
    'elapsedMs?: number',
    "captureHealth?: 'ready' | 'silent' | 'failed' | 'not-run' | null",
    'captureReady?: boolean',
    'captureError?: string',
  ]) {
    assert.ok(source.includes(field), `missing CapturePermissionCheckResult field: ${field}`);
  }
});

test('missing structured speaker APIs stay unknown without a legacy fallback', () => {
  assert.doesNotMatch(source, /callLegacySpeakerPermissionProbe/);
  assert.match(source, /'structured-permission-api-unavailable'/);
  assert.match(source, /status:\s*'unknown'/);
  assert.match(source, /captureHealth:\s*'not-run'/);
  assert.match(source, /captureReady:\s*false/);
});
