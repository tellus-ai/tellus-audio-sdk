const assert = require('node:assert/strict');
const test = require('node:test');
const { mock } = test;
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
  { name: 'ten-minute approval renews at eight minutes', remainingMs: 600000, renewAfterMs: 480000, expectedDelayMs: 480000 },
  { name: 'renewal keeps a two-minute margin even when the server asks to wait longer', remainingMs: 600000, renewAfterMs: 540000, expectedDelayMs: 480000 },
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
  assert.equal(socket.closed, false);
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
  assert.equal(socket.closed, false);
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
  assert.equal(socket.closed, false);
});

test('after authorization stops the engine, attaching again re-approves on the same socket', async () => {
  const socket = new Socket();
  const capture = new Capture();
  const first = attachEngineAuthorization(socket, capture, {
    conversationId: 'conversation-1', getAccessToken: () => 'login-token', onError: () => {},
  });
  await waitFor(() => socket.sent.length === 1);
  socket.receive({ type: 'engine.authorized', version: 1, sequence: 1, token: 'signed-permit', renew_after_ms: 2 });
  await first.ready;
  await waitFor(() => socket.sent.length === 2);
  socket.receive({ type: 'engine.denied', version: 1, sequence: 2, code: 'engine_access_denied', retryable: false });
  assert.equal(capture.invalidations, 1);

  const second = attachEngineAuthorization(socket, capture, {
    conversationId: 'conversation-1', getAccessToken: () => 'login-token',
  });
  await waitFor(() => socket.sent.length === 3);
  assert.equal(socket.sent[2].type, 'audio.authenticate');
  assert.equal(socket.sent[2].engine.sequence, 3);
  socket.receive({ type: 'engine.authorized', version: 1, sequence: 3, token: 'signed-permit', renew_after_ms: 480000 });
  await second.ready;
  assert.equal(capture.applied.length, 2);
  assert.equal(socket.closed, false);
  second.dispose();
});

test('renewal retries when current login credentials cannot be obtained', async () => {
  const socket = new Socket();
  const capture = new Capture();
  const errors = [];
  let credentials = 0;
  const controller = attachEngineAuthorization(socket, capture, {
    conversationId: 'conversation-1', onError: error => errors.push(error),
    getAccessToken: () => {
      if (++credentials === 2) throw new Error('login_refresh_failed');
      return `login-${credentials}`;
    },
  });
  await waitFor(() => socket.sent.length === 1);
  socket.receive({ type: 'engine.authorized', version: 1, sequence: 1, token: 'signed-permit', renew_after_ms: 2 });
  await controller.ready;
  await new Promise(resolve => setTimeout(resolve, 1050));
  await waitFor(() => socket.sent.length === 2);
  assert.deepEqual(errors, []);
  assert.equal(capture.invalidations, 0);
  assert.equal(socket.sent[1].access_token, 'login-3');
  assert.equal(socket.sent[1].engine.sequence, 3);
  socket.receive({ type: 'engine.renewed', version: 1, sequence: 3, token: 'signed-permit', renew_after_ms: 480000 });
  assert.equal(capture.applied.length, 2);
  controller.dispose();
});

test('renewal retries with a fresh challenge when obtaining credentials outlasts the response timeout', async () => {
  const socket = new Socket();
  const capture = new Capture();
  const errors = [];
  let credentials = 0;
  const controller = attachEngineAuthorization(socket, capture, {
    conversationId: 'conversation-1', requestTimeoutMs: 10, onError: error => errors.push(error),
    getAccessToken: () => (++credentials === 2
      ? new Promise(resolve => setTimeout(() => resolve('late-login'), 50))
      : `login-${credentials}`),
  });
  await waitFor(() => socket.sent.length === 1);
  socket.receive({ type: 'engine.authorized', version: 1, sequence: 1, token: 'signed-permit', renew_after_ms: 2 });
  await controller.ready;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(socket.sent.length, 1, 'the abandoned challenge must not be sent after its timeout');
  await new Promise(resolve => setTimeout(resolve, 1000));
  await waitFor(() => socket.sent.length === 2);
  assert.deepEqual(errors, []);
  assert.equal(socket.sent[1].access_token, 'login-3');
  assert.equal(socket.sent[1].engine.sequence, 3);
  controller.dispose();
});

test('unanswered renewal retries until native expiry, then stops only the engine', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let now = 0;
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
  const advance = async ms => { for (let step = 0; step < ms; step += 100) { now += 100; mock.timers.tick(100); await flush(); } };
  const socket = new Socket();
  const capture = new Capture();
  capture.getAuthorizationStatus = () => (now < 600000
    ? { state: 'authorized', remainingMs: 600000 - now }
    : { state: 'expired', remainingMs: 0 });
  const errors = [];
  const sentAt = [];
  const send = socket.send.bind(socket);
  socket.send = data => { sentAt.push(now); send(data); };
  const controller = attachEngineAuthorization(socket, capture, {
    conversationId: 'conversation-1', getAccessToken: () => 'login-token', onError: error => errors.push(error),
  });
  await flush();
  socket.receive({ type: 'engine.authorized', version: 1, sequence: 1, token: 'signed-permit', renew_after_ms: 480000 });
  await controller.ready;
  await advance(700000);
  const renewals = sentAt.slice(1);
  assert.equal(renewals[0], 480000);
  assert.ok(renewals.length >= 10, `renewal attempts: ${renewals.length}`);
  for (let i = 1; i < renewals.length; i++) assert.equal(renewals[i] - renewals[i - 1], 11000);
  assert.ok(renewals.at(-1) < 600000);
  const sequences = socket.sent.slice(1).map(message => message.engine.sequence);
  assert.equal(new Set(sequences).size, sequences.length);
  assert.deepEqual(errors.map(error => error.message), ['engine_authorization_expired']);
  assert.equal(capture.invalidations, 1);
  assert.equal(socket.closed, false);
  controller.dispose();
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

const modelRequest = { modelId: 'fe-s16', keyId: 'release-1', publicKey: 'b'.repeat(64) };
const modelReply = { model_id: 'fe-s16', key_id: 'release-1', wrapped_key: Buffer.alloc(80, 1).toString('base64url') };
const authorizedReply = extra => ({ type: 'engine.authorized', version: 1, sequence: 1,
  token: 'signed-permit', renew_after_ms: 480000, ...extra });

test('async approval and model keys both finish before readiness', async () => {
  const socket = new Socket();
  const capture = new Capture();
  const permit = deferred(), keys = deferred();
  const order = [];
  capture.createAuthorizationRequest = async () => Capture.prototype.createAuthorizationRequest.call(capture);
  capture.getAuthorizationStatus = async () => Capture.prototype.getAuthorizationStatus.call(capture);
  capture.createModelKeyRequests = async () => [modelRequest];
  capture.applyAuthorization = () => { order.push('permit'); return permit.promise; };
  capture.applyModelKeys = values => { order.push(values); return keys.promise; };
  const controller = attachEngineAuthorization(socket, capture, { conversationId: 'conversation-1', getAccessToken: () => 'login-token' });
  let ready = false;
  controller.ready.then(() => { ready = true; });
  await waitFor(() => socket.sent.length === 1);
  assert.deepEqual(socket.sent[0].model_keys, [{ model_id: 'fe-s16', key_id: 'release-1', public_key: 'b'.repeat(64) }]);
  socket.receive(authorizedReply({ model_keys: [modelReply] }));
  assert.deepEqual(order, ['permit']);
  assert.equal(ready, false);
  permit.resolve({ state: 'authorized', remainingMs: 600000 });
  await waitFor(() => order.length === 2);
  assert.deepEqual(order[1], [{ modelId: 'fe-s16', keyId: 'release-1', wrappedKey: modelReply.wrapped_key }]);
  assert.equal(ready, false);
  keys.resolve();
  await controller.ready;
  controller.dispose();
});

for (const reply of [
  undefined,
  [{ ...modelReply, key_id: 'another-key' }],
  [{ ...modelReply, model_id: 'silero-vad' }],
  [modelReply, modelReply],
  [{ ...modelReply, wrapped_key: `${modelReply.wrapped_key}=` }],
  [{ ...modelReply, wrapped_key: Buffer.alloc(79).toString('base64url') }],
]) {
  test(`model-key mismatch never applies native permission: ${JSON.stringify(reply)}`, async () => {
    const socket = new Socket(), capture = new Capture();
    capture.createModelKeyRequests = () => [modelRequest];
    capture.applyModelKeys = () => assert.fail('invalid key reply reached native');
    const controller = attachEngineAuthorization(socket, capture, { conversationId: 'conversation-1', getAccessToken: () => 'login-token' });
    const rejected = assert.rejects(controller.ready, /engine_model_key_response_invalid/);
    await waitFor(() => socket.sent.length === 1);
    socket.receive(authorizedReply({ model_keys: reply }));
    await rejected;
    assert.deepEqual(capture.applied, []);
    assert.equal(capture.invalidations, 1);
  });
}

for (const step of ['permit', 'keys']) {
  test(`close while async ${step} apply never completes readiness`, async () => {
    const socket = new Socket(), capture = new Capture(), pending = deferred();
    let appliedKeys = 0;
    capture.createModelKeyRequests = () => [modelRequest];
    capture.applyModelKeys = () => { appliedKeys++; return step === 'keys' ? pending.promise : undefined; };
    if (step === 'permit') capture.applyAuthorization = () => pending.promise;
    const controller = attachEngineAuthorization(socket, capture, { conversationId: 'conversation-1', getAccessToken: () => 'login-token' });
    const rejected = assert.rejects(controller.ready, /engine_authorization_connection_closed/);
    await waitFor(() => socket.sent.length === 1);
    socket.receive(authorizedReply({ model_keys: [modelReply] }));
    socket.dispatchEvent(new Event('close'));
    await rejected;
    pending.resolve(step === 'permit' ? { state: 'authorized', remainingMs: 600000 } : undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(appliedKeys, step === 'keys' ? 1 : 0);
    assert.ok(capture.invalidations >= 1);
    assert.equal(socket.sent.length, 1);
  });
}

test('pending async challenge blocks duplicate open and timeout blocks its late completion', async () => {
  const socket = new Socket(), capture = new Capture(), challenge = deferred();
  let requests = 0;
  capture.createAuthorizationRequest = () => { requests++; return challenge.promise; };
  const controller = attachEngineAuthorization(socket, capture, {
    conversationId: 'conversation-1', getAccessToken: () => 'login-token', requestTimeoutMs: 10,
  });
  const rejected = assert.rejects(controller.ready, /engine_authorization_timeout/);
  await waitFor(() => requests === 1);
  socket.dispatchEvent(new Event('open'));
  assert.equal(requests, 1);
  await rejected;
  challenge.resolve({ nativeInstanceId: 'a'.repeat(64), nonce: '1'.padStart(64, '0'), sequence: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(socket.sent, []);
});

test('renewal omits keys and does not race pending async approval', async () => {
  const socket = new Socket(), capture = new Capture(), pending = deferred();
  let keyRequests = 0, keyApplies = 0;
  capture.createModelKeyRequests = async () => { keyRequests++; return [modelRequest]; };
  capture.applyModelKeys = async () => { keyApplies++; };
  const controller = attachEngineAuthorization(socket, capture, { conversationId: 'conversation-1', getAccessToken: () => 'login-token' });
  await waitFor(() => socket.sent.length === 1);
  socket.receive(authorizedReply({ model_keys: [modelReply], renew_after_ms: 5 }));
  await controller.ready;
  await waitFor(() => socket.sent.length === 2);
  assert.equal('model_keys' in socket.sent[1], false);
  capture.applyAuthorization = () => pending.promise;
  socket.receive({ type: 'engine.renewed', version: 1, sequence: 2, token: 'signed-permit', renew_after_ms: 5 });
  socket.dispatchEvent(new Event('open'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(socket.sent.length, 2);
  pending.resolve({ state: 'authorized', remainingMs: 600000 });
  await waitFor(() => socket.sent.length === 3);
  assert.equal(keyRequests, 1);
  assert.equal(keyApplies, 1);
  controller.dispose();
});

test('terminal denial while native permit is pending revokes the late approval', async () => {
  const socket = new Socket(), capture = new Capture(), pending = deferred();
  let nativeAuthorized = false;
  capture.applyAuthorization = () => pending.promise.then(status => { nativeAuthorized = true; return status; });
  capture.invalidateAuthorization = () => { capture.invalidations++; nativeAuthorized = false; };
  const controller = attachEngineAuthorization(socket,capture, {
    conversationId:'conversation-1',getAccessToken:()=>'login-token',requestTimeoutMs:30,
  });
  const rejected = assert.rejects(controller.ready,/engine_access_denied/);
  await waitFor(()=>socket.sent.length===1);
  socket.receive(authorizedReply({}));
  socket.receive({type:'engine.denied',version:1,sequence:1,code:'engine_access_denied',retryable:false});
  await rejected;
  pending.resolve({state:'authorized',remainingMs:600000});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(nativeAuthorized,false);
  controller.dispose();
});

for (const requests of [
  [modelRequest,modelRequest],
  [{...modelRequest,publicKey:'B'.repeat(64)}],
  [{...modelRequest,keyId:'release-1\n'}],
  [{...modelRequest,modelId:'unsupported'}],
  [modelRequest,{...modelRequest,modelId:'fe-s48'},{...modelRequest,modelId:'silero-vad'},modelRequest],
]) {
  test(`invalid model requests fail before sending: ${JSON.stringify(requests)}`, async()=>{
    const socket=new Socket(),capture=new Capture();
    capture.createModelKeyRequests=()=>requests;
    capture.applyModelKeys=()=>{};
    const controller=attachEngineAuthorization(socket,capture,{conversationId:'conversation-1',getAccessToken:()=>'login-token'});
    await assert.rejects(controller.ready,/engine_model_key_request_invalid/);
    assert.deepEqual(socket.sent,[]);
  });
}

test('async model-key rejection blocks ready and async invalidation rejection is handled',async()=>{
  const socket=new Socket(),capture=new Capture(),errors=[];
  capture.createModelKeyRequests=async()=>[modelRequest];
  capture.applyModelKeys=async()=>{throw new Error('native-key-rejected');};
  capture.invalidateAuthorization=async()=>{capture.invalidations++;throw new Error('native-invalidation-rejected');};
  const controller=attachEngineAuthorization(socket,capture,{conversationId:'conversation-1',getAccessToken:()=>'login-token',onError:e=>errors.push(e.message)});
  const rejected=assert.rejects(controller.ready,/native-key-rejected/);
  await waitFor(()=>socket.sent.length===1);
  socket.receive(authorizedReply({model_keys:[modelReply]}));
  await rejected;
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(errors,['native-invalidation-rejected']);
  assert.equal(capture.invalidations,1);
});
