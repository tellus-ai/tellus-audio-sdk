const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
for (const platform of ['desktop', 'web', 'mobile']) {
  test(`${platform} has an independent install package and only its dependencies`, () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'platforms', platform, 'package.json')));
    assert.equal(pkg.name, `@tellus-ai/audio-sdk-${platform}`);
    assert.equal(pkg.tellusPlatform, platform);
    assert.ok(pkg.exports['.']);
    assert.ok(pkg.exports['./authorization']);
    assert.equal(pkg.dependencies?.['onnxruntime-web'], platform === 'web' ? '1.24.1' : undefined);
    assert.equal(pkg.peerDependencies?.['react-native-nitro-modules'], platform === 'mobile' ? '0.35.4' : undefined);
    assert.equal(pkg.scripts.postinstall, 'node dist/installer/install-binary-cli.js');
    assert.doesNotMatch(JSON.stringify(pkg), /Tellus-audio-engine|\.\.\/\.\./);
  });
}
test('workspace root is private and never downloads host artifacts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.equal(pkg.private, true);
  assert.equal(pkg.scripts.postinstall, undefined);
  assert.equal(pkg.exports, undefined);
});
