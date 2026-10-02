const assert = require('node:assert/strict');
const test = require('node:test');
const { attachEngineAuthorization } = require('../dist/authorization/realtime.js');

class Socket extends EventTarget {
  readyState = 1;
  sent = [];
  closed = false;

  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.readyState = 3; }
  receive(data) {
    const event = new Event('message');
    event.data = JSON.stringify(data);
    this.dispatchEvent(event);
  }
}

class Capture {
  sequence = 0;
  applied = [];
  invalidations = 0;
  remainingMs = 600000;

  createAuthorizationRequest() {
    return { nativeInstanceId: 'a'.repeat(64), nonce: String(++this.sequence).padStart(64, '0'), sequence: this.sequence };
  }
  applyAuthorization(token) {
    if (token !== 'signed-permit') throw new Error('engine_authorization_invalid');
    this.applied.push(token);
    return { state: 'authorized', remainingMs: this.remainingMs };
  }
  getAuthorizationStatus() { return { state: 'authorized', remainingMs: this.remainingMs }; }
  invalidateAuthorization() { this.invalidations++; }
}

async function waitFor(predicate) {
  for (let i = 0; i < 50 && !predicate(); i++) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.ok(predicate(), 'expected socket request');
}

for (const { name, remainingMs, renewAfterMs, expectedDelayMs } of [
  { name: 'ten-minute approval renews at nine minutes', remainingMs: 600000, renewAfterMs: 540000, expectedDelayMs: 540000 },
  { name: 'short-lived credentials renew before their earlier deadline', remainingMs: 10000, renewAfterMs: 9000, expectedDelayMs: 9000 },
  { name: 'delayed approval receipt advances renewal within native remaining time', remainingMs: 250000, renewAfterMs: 540000, expectedDelayMs: 225000 },
]) {
  test(name, async () => {
    const socket = new Socket();
    const capture = new Capture();
    capture.remainingMs = remainingMs;
    const scheduled = [];
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (callback, delay, ...args) => {
      scheduled.push({ callback, delay });
      return originalSetTimeout(callback, delay, ...args);
    };
    const controller = attachEngineAuthorization(socket, capture, {
      conversationId: 'conversation-1', getAccessToken: () => 'login-token',
    });
    try {
      await waitFor(() => socket.sent.length === 1);
      socket.receive({ type: 'engine.authorized', version: 1, sequence: 1, token: 'signed-permit', renew_after_ms: renewAfterMs });
      await controller.ready;
      const renewal = scheduled.at(-1);
      assert.equal(renewal.delay, expectedDelayMs);
      assert.equal(socket.sent.length, 1);
      renewal.callback();
      await waitFor(() => socket.sent.length === 2);
      assert.equal(socket.sent[1].type, 'engine.renew');
    } finally {
      controller.dispose();
      global.setTimeout = originalSetTimeout;
    }
  });
}

test('authenticates before readiness and forwards signed approval to the native instance', async () => {
  const socket = new Socket();
  const capture = new Capture();
  const controller = attachEngineAuthorization(socket, capture, {
    conversationId: 'conversation-1', getAccessToken: () => 'login-token',
  });
  await waitFor(() => socket.sent.length === 1);
  assert.deepEqual(socket.sent[0], { type: 'audio.authenticate', version: 1, access_token: 'login-token',
    engine: { native_instance_id: 'a'.repeat(64), nonce: '1'.padStart(64, '0'), sequence: 1 } });
  socket.receive({ type: 'engine.authorized', version: 1, sequence: 1, token: 'signed-permit', renew_after_ms: 540000 });
  await controller.ready;
  assert.deepEqual(capture.applied, ['signed-permit']);
  controller.dispose();
});

test('renews without receiving any audio frame and obtains current login credentials again', async () => {
  const socket = new Socket();
  const capture = new Capture();
  let credentials = 0;
  const controller = attachEngineAuthorization(socket, capture, {
    conversationId: 'conversation-1', getAccessToken: () => `login-${++credentials}`,
  });
  await waitFor(() => socket.sent.length === 1);
  socket.receive({ type: 'engine.authorized', version: 1, sequence: 1, token: 'signed-permit', renew_after_ms: 5 });
  await controller.ready;
  await waitFor(() => socket.sent.length === 2);
  assert.equal(socket.sent[1].type, 'engine.renew');
  assert.equal(socket.sent[1].access_token, 'login-2');
  assert.equal(socket.sent[1].engine.sequence, 2);
  controller.dispose();
});

test('native signature rejection fails readiness and invalidates capture', async () => {
  const socket = new Socket();
  const capture = new Capture();
  const controller = attachEngineAuthorization(socket, capture, {
    conversationId: 'conversation-1', getAccessToken: () => 'login-token',
  });
  const rejected = assert.rejects(controller.ready, /engine_authorization_invalid/);
  await waitFor(() => socket.sent.length === 1);
  socket.receive({ type: 'engine.authorized', version: 1, sequence: 1, token: 'forged', renew_after_ms: 540000 });
  await rejected;
  assert.equal(capture.invalidations, 1);
  assert.equal(socket.closed, true);
});

test('disconnect invalidates native permission and removes renewal listeners', async () => {
  const socket = new Socket();
  const capture = new Capture();
  const controller = attachEngineAuthorization(socket, capture, {
    conversationId: 'conversation-1', getAccessToken: () => 'login-token',
  });
  await waitFor(() => socket.sent.length === 1);
  socket.receive({ type: 'engine.authorized', version: 1, sequence: 1, token: 'signed-permit', renew_after_ms: 540000 });
  await controller.ready;
  socket.dispatchEvent(new Event('close'));
  assert.equal(capture.invalidations, 1);
  socket.receive({ type: 'engine.renewed', version: 1, sequence: 2, token: 'signed-permit', renew_after_ms: 540000 });
  assert.equal(capture.applied.length, 1);
});

test('missing server approval times out and blocks readiness', async () => {
  const socket = new Socket();
  const capture = new Capture();
  const controller = attachEngineAuthorization(socket, capture, {
    conversationId: 'conversation-1', getAccessToken: () => 'login-token', requestTimeoutMs: 10,
  });
  await assert.rejects(controller.ready, /engine_authorization_timeout/);
  assert.equal(capture.invalidations, 1);
});

test('renewal timeout retries with a new challenge and ignores the abandoned reply', async () => {
  const socket = new Socket();
  const capture = new Capture();
  const controller = attachEngineAuthorization(socket, capture, {
    conversationId: 'conversation-1', getAccessToken: () => 'login-token', requestTimeoutMs: 10,
  });
  await waitFor(() => socket.sent.length === 1);
  socket.receive({ type: 'engine.authorized', version: 1, sequence: 1, token: 'signed-permit', renew_after_ms: 2 });
  await controller.ready;
  await waitFor(() => socket.sent.length === 2);
  await new Promise(resolve => setTimeout(resolve, 20));
  socket.receive({ type: 'engine.renewed', version: 1, sequence: 2, token: 'signed-permit', renew_after_ms: 540000 });
  assert.equal(capture.applied.length, 1);
  assert.equal(socket.closed, false);
  await new Promise(resolve => setTimeout(resolve, 1000));
  await waitFor(() => socket.sent.length >= 3);
  assert.equal(socket.sent[2].engine.sequence, 3);
  controller.dispose();
});

test('revocation after initial approval invalidates native capture and reports the cause', async () => {
  const socket = new Socket();
  const capture = new Capture();
  const errors = [];
  const controller = attachEngineAuthorization(socket, capture, {
    conversationId: 'conversation-1', getAccessToken: () => 'login-token', onError: error => errors.push(error),
  });
  await waitFor(() => socket.sent.length === 1);
  socket.receive({ type: 'engine.authorized', version: 1, sequence: 1, token: 'signed-permit', renew_after_ms: 2 });
  await controller.ready;
  await waitFor(() => socket.sent.length === 2);
  socket.receive({ type: 'engine.denied', version: 1, sequence: 2, code: 'engine_access_denied', retryable: false });
  assert.equal(capture.invalidations, 1);
  assert.equal(errors[0].message, 'engine_access_denied');
  assert.equal(socket.closed, true);
});
