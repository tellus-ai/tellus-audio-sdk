const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

// 외부 빌드 kit의 잘못된 release 버전을 실제 조립 경계에서 거부한다.
test('SDK rejects an engine kit that differs from its pinned release', t => {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'tellus-engine-kit-'));
  t.after(() => fs.rmSync(kit, { recursive: true, force: true }));
  fs.mkdirSync(path.join(kit, 'desktop'));
  fs.writeFileSync(path.join(kit, 'desktop/engine-kit.json'), JSON.stringify({ platform: 'desktop', nativeEngineVersion: '0.0.0' }));
  const result = spawnSync(process.execPath, [path.join(__dirname, 'assemble-platforms.js'), '--engine-dist', kit], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match pinned desktop engine/);
});
