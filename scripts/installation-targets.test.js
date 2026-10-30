const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

// Runs the real CLI and records only the per-package download selection through a double.
for (const [platform, targets, args = [], selectedPlatform] of [
  ['desktop', [null]], ['web', ['web']], ['mobile', ['ios', 'android']],
  ['mobile', ['android'], ['--platform', 'android']], ['mobile', ['ios'], [], 'ios'],
]) {
  test(`${platform} selects ${targets.join(',')} using package identity and existing options`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-targets-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'dist/installer'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../dist/installer/install-binary-cli.js'), path.join(root, 'dist/installer/install-binary-cli.js'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ tellusPlatform: platform }));
    fs.writeFileSync(path.join(root, 'dist/installer/install-binary.js'), `exports.installBinary = async platform => require('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'targets'))}, JSON.stringify([platform]) + '\\n');`);
    const env = { ...process.env };
    delete env.TELLUS_AUDIO_ENGINE_PLATFORM;
    if (selectedPlatform !== undefined) env.TELLUS_AUDIO_ENGINE_PLATFORM = selectedPlatform;
    fs.rmSync(path.join(root, 'targets'), { force: true });
    const installed = spawnSync(process.execPath, ['dist/installer/install-binary-cli.js', ...args], { cwd: root, encoding: 'utf8', env });
    assert.equal(installed.status, 0, installed.stderr);
    const actual = fs.readFileSync(path.join(root, 'targets'), 'utf8').trim().split('\n').map(line => JSON.parse(line)[0]);
    assert.deepEqual(actual, targets);
  });
}
