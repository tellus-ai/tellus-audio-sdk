const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8');

test('legacy permission exports use native APIs and remain fallbacks for structured checks', () => {
  const expectedExports = [
    'probeMicCapture',
    'checkMicCapturePermission',
    'probeSpeakerCapture',
    'checkSpeakerCapturePermission',
    'checkSystemAudioCapturePermission',
    'checkSystemAudioCapturePermissionInfo',
    'requestSystemAudioCapturePermission',
    'requestInitialSystemAudioPermission',
  ];

  for (const name of expectedExports) {
    assert.match(source, new RegExp(`export const ${name}\\b`));
  }

  for (const nativeName of [
    'nativeProbeMicCapture',
    'nativeCheckMicCapturePermission',
    'nativeProbeSpeakerCapture',
    'nativeCheckSpeakerCapturePermission',
    'nativeRequestSystemAudioCapturePermission',
    'nativeRequestInitialSystemAudioPermission',
  ]) {
    assert.match(source, new RegExp(`${nativeName}\\b`));
  }

  assert.match(source, /typeof nativeCheckMicCapturePermission === 'function'/);
  assert.match(source, /typeof nativeCheckSpeakerCapturePermission === 'function'/);
  assert.match(source, /typeof nativeRequestSystemAudioCapturePermission === 'function'/);
  assert.match(source, /typeof nativeProbeSpeakerCapture === 'function'/);
  assert.match(source, /requestSystemAudioCapturePermission:[^=]*=> boolean\s*=\s*nativeRequestSystemAudioCapturePermission/);
  assert.match(source, /typeof nativeRequestInitialSystemAudioPermission === 'function'/);
});
