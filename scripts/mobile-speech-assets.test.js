const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mobile = path.join(__dirname, '../platforms/mobile');
for (const target of ['ios', 'android']) {
  test(`${target} archive requires the detector model and its notice`, () => {
    const required = require('../release-assets.json').assets[target].requiredFiles;
    for (const file of ['speech-detection/silero_vad_v6.2.onnx', 'licenses/silero-vad.txt']) {
      assert.ok(required.includes(file), `missing archive requirement: ${file}`);
    }
  });
  test(`${target} generated Nitro entry point registers the two public objects`, () => {
    const entry = target === 'ios' ? 'TellusAudioSdkAutolinking.mm' : 'TellusAudioSdkOnLoad.cpp';
    const source = fs.readFileSync(path.join(mobile, 'nitrogen/generated', target, entry), 'utf8');
    const objects = [...source.matchAll(/registerHybridObjectConstructor\(\s*"([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(objects.sort(), ['TellusCapture', 'TellusSpeechDetector']);
  });
}
