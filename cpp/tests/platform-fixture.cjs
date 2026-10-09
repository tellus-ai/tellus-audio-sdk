const fs = require('node:fs');
const path = require('node:path');
if (process.env.TELLUS_ENGINE_TEST_LICENSE !== '1') throw new Error('Test-only license opt-in required');
const [engineRoot, input, output, ttlMs = '60000'] = process.argv.slice(2);
const { signTestPermit } = require(path.resolve(engineRoot, 'scripts/ci/engine-authorization-fixture.js'));
const request = JSON.parse(fs.readFileSync(input, 'utf8'));
fs.writeFileSync(output, signTestPermit({ nativeInstanceId: request.native_instance_id,
  nonce: request.nonce, sequence: request.sequence }, { ttlMs: Number(ttlMs) }), { mode: 0o600 });
