const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { attachEngineAuthorization } = require('../dist/authorization/realtime');

function loadCapture(NativeCapture) {
  const filename = path.resolve(__dirname, '../dist/index.js');
  const requireBuilt = createRequire(filename);
  const exports = {};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports, Error,
    require: name => name === './runtime/engine-runtime'
      ? { prepareEngineRuntime: () => ({ nativeBinding: { AudioCapture: NativeCapture } }) }
      : requireBuilt(name),
  }, { filename });
  return exports.AudioCapture;
}

class LegacyCapture {
  state = 'idle';
  start(callback) { this.callback = callback; this.state = 'running'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'running'; }
  stop() { this.state = 'idle'; }
  getState() { return this.state; }
}

test('legacy native capture can be constructed and used without authorization', () => {
  const Capture = loadCapture(LegacyCapture);
  const capture = new Capture();
  capture.start(() => {});
  assert.equal(capture.getState(), 'running');
  capture.pause();
  assert.equal(capture.getState(), 'paused');
  capture.resume();
  assert.equal(capture.getState(), 'running');
  capture.stop();
  assert.equal(capture.getState(), 'idle');
});

for (const method of [
  'createAuthorizationRequest', 'applyAuthorization',
  'getAuthorizationStatus', 'invalidateAuthorization',
]) {
  test(`legacy native ${method} rejects with a stable unsupported error`, () => {
    const Capture = loadCapture(LegacyCapture);
    const capture = new Capture();
    assert.throws(() => capture[method]('conversation-1'), /engine_authorization_unsupported/);
  });
}

test('unsupported authorization adapter fails before registering a socket or invalidating capture', () => {
  const Capture = loadCapture(LegacyCapture);
  const capture = new Capture();
  capture.start(() => {});
  const socket = new EventTarget();
  socket.readyState = 1;
  socket.send = () => assert.fail('unsupported capture must not send authorization');
  socket.close = () => assert.fail('unsupported capture must not close the audio socket');
  const listeners = [];
  socket.addEventListener = name => listeners.push(name);
  assert.throws(() => attachEngineAuthorization(socket, capture, {
    conversationId: 'conversation-1',
    getAccessToken: () => assert.fail('unsupported capture must not request credentials'),
  }), /engine_authorization_unsupported/);
  assert.deepEqual(listeners, []);
  assert.equal(capture.getState(), 'running');
});
