import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioEngine } from '../../dist-browser/browser/index.js';

test('init completes before a gesture even when AudioContext resume cannot complete', async () => {
  let resumes = 0;
  let closed = false;
  globalThis.document = { baseURI: 'https://example.test/' };
  globalThis.AudioContext = class {
    audioWorklet = { addModule: async () => {} };
    resume() { resumes++; return new Promise(() => {}); }
    async close() { closed = true; }
  };
  globalThis.Worker = class {
    postMessage(message) { queueMicrotask(() => this.onmessage({ data: { id: message.id } })); }
    terminate() {}
  };
  let timer;
  const initialization = AudioEngine.init({}, { engineModuleUrl: 'engine.mjs', wasmUrl: 'engine.wasm', ortWasmBaseUrl: 'ort/', encryptedModels: [] });
  const engine = await Promise.race([initialization, new Promise((resolve) => { timer = setTimeout(() => resolve('waiting_for_gesture'), 100); })]);
  clearTimeout(timer);
  assert.notEqual(engine, 'waiting_for_gesture');
  assert.equal(resumes, 0);
  await engine.dispose();
  assert.equal(closed, true);
});
