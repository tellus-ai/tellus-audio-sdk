const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

test('raw audio public contract allows a temporarily unavailable speaker frame', () => {
  assert.match(source, /speaker\?: RawAudioFrame \| null;/);
  assert.match(
    source,
    /Speaker PCM16 frame at the original speaker device sample rate, or null when disabled or temporarily unavailable\./,
  );
});

test('AudioCapture forwards raw audio callbacks without normalizing speaker null', () => {
  assert.match(
    source,
    /start\(callback: AudioChunkCallback\): void\s*\{\s*this\.#native\.start\(callback\);\s*\}/s,
  );
  assert.doesNotMatch(source, /rawAudio\.speaker\s*=\s*Buffer\.alloc/);
  assert.doesNotMatch(source, /rawAudio\.speaker\s*\?\?\s*Buffer\.alloc/);
});

test('README distinguishes speaker null from a real silent PCM frame', () => {
  assert.match(readme, /rawAudio\.speaker.*actual speaker PCM is available/s);
  assert.match(readme, /rawAudio\.speaker.*can still be `null`/s);
  assert.match(readme, /real speaker callback.*all zero.*non-null PCM frame/s);
  assert.match(readme, /rawAudio\.mixed.*rawAudio\.speaker.*null/s);
});
