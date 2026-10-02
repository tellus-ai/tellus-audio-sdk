// Integration harness: use the real SDK and native binary against the server's /audio ASGI app.
const assert = require('node:assert/strict');
const { createInterface } = require('node:readline');
const { resolve } = require('node:path');
const { attachEngineAuthorization } = require('../dist/authorization/realtime');
const native = require(resolve(process.env.TELLUS_ENGINE_TEST_BINARY));
const capture = new native.AudioCapture();
assert.throws(() => capture.resume(), /engine_authorization_required/);

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let renew;
let renewalDelayMs;
const originalSetTimeout = global.setTimeout;
global.setTimeout = (callback, delay, ...args) => {
  if (delay > 60000) { renew = callback; renewalDelayMs = delay; }
  return originalSetTimeout(callback, delay, ...args);
};

class Socket extends EventTarget {
  readyState = 1;
  send(data) { emit(JSON.parse(data)); }
  close() { this.readyState = 3; }
  receive(data) {
    const event = new Event('message');
    event.data = JSON.stringify(data);
    this.dispatchEvent(event);
  }
}

const socket = new Socket();
const controller = attachEngineAuthorization(socket, capture, {
  conversationId: 'conversation-1',
  getAccessToken: () => process.env.TELLUS_ENGINE_TEST_ACCESS_TOKEN,
  onError: error => { emit({ error: error.message }); process.exitCode = 1; },
});
function status() { emit({ ...capture.getAuthorizationStatus(), renewalDelayMs }); }
controller.ready.then(status).catch(error => {
  emit({ error: error.message });
  process.exitCode = 1;
});
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.action === 'renew') {
    assert.equal(typeof renew, 'function');
    renew(); // Exercise the real timer callback without waiting nine minutes in the test.
  } else {
    socket.receive(message);
    if (message.type === 'engine.renewed') status();
  }
});
input.on('close', () => {
  controller.dispose();
  assert.equal(capture.getAuthorizationStatus().state, 'unapproved');
  global.setTimeout = originalSetTimeout;
});
