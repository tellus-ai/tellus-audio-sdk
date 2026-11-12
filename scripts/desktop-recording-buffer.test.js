const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const wrapperPath = path.resolve(__dirname,
  '../platforms/desktop/runtime/platforms/desktop/electron/index.js');

function loadWrapper(NativeAudioCapture) {
  const exports = {};
  vm.runInNewContext(fs.readFileSync(wrapperPath, 'utf8'), {
    exports,
    setTimeout,
    Date,
    require(specifier) {
      if (specifier === './runtime/engine-runtime.js') {
        return { prepareEngineRuntime: () => ({ nativeBinding: { AudioCapture: NativeAudioCapture } }) };
      }
      return specifier.startsWith('.') ? require(path.resolve(path.dirname(wrapperPath), specifier)) : require(specifier);
    },
  }, { filename: wrapperPath });
  return exports;
}

test('desktop recording retains configuration and returns the complete native batch', () => {
  const calls = [];
  const batch = { chunks: [], queuedChunks: 0, capacityChunks: 500, capacityBytes: 33554432,
    droppedChunks: 1, droppedSamples: 960, error: 'recording_buffer_payload_too_large' };
  const { AudioCapture } = loadWrapper(class {
    constructor(config) { calls.push(['config', config]); }
    getStatus() { return { deliveryQueueCapacityBytes: 33554432 }; }
    enableRecordingBuffer() { calls.push(['enable']); }
    readRecordingBuffer() { return batch; }
  });
  const config = { deliveryBufferDurationMs: 10000, enableRawAudio: true };
  const capture = new AudioCapture(config);
  capture.enableRecordingBuffer();
  assert.equal(capture.readRecordingBuffer(), batch);
  assert.deepEqual(calls.map(([name]) => name), ['config', 'enable']);
  assert.equal(calls[0][1].deliveryBufferDurationMs, 10000);
  assert.equal(calls[0][1].enableRawAudio, true);
});

test('desktop pause/resume waits for native acknowledgement and stop cancels pending transitions', async () => {
  let state = 'recording';
  const { AudioCapture } = loadWrapper(class {
    pause() { state = 'pausing'; }
    resume() { state = 'resuming'; }
    stop() { state = 'idle'; }
    getState() { return state; }
  });
  const capture = new AudioCapture();
  let completed = false;
  const pausing = capture.pauseAndDrain().then(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(completed, false);
  state = 'paused';
  await pausing;
  const resuming = capture.resumeWhenReady();
  state = 'recording';
  await resuming;
  const cancelled = capture.pauseAndDrain();
  capture.stop();
  state = 'paused';
  await assert.rejects(cancelled, /capture_transition_replaced/);
});

test('desktop recording refuses an engine without the independent buffer API', () => {
  const { AudioCapture } = loadWrapper(class {});
  const capture = new AudioCapture();
  assert.throws(() => capture.enableRecordingBuffer(), /recording_buffer_unsupported/);
  assert.throws(() => capture.readRecordingBuffer(), /recording_buffer_unsupported/);
});

test('an explicit delivery budget is refused when the native engine cannot enforce it', () => {
  const { AudioCapture } = loadWrapper(class {
    getStatus() { return { deliveryQueueCapacityChunks: 25 }; }
  });
  assert.throws(() => new AudioCapture({ deliveryBufferDurationMs: 10000 }), /delivery_buffer_unsupported/);
});

test('desktop audio recording endpoint delegates one token without stopping shared capture',()=>{
  const stopped=[];
  const {AudioCapture}=loadWrapper(class{
    createRecordingAudioSource(){return {port:12345,token:'session-token'};}
    stopRecordingAudioSource(token){stopped.push(token);}
    stop(){throw new Error('shared capture must survive');}
  });
  const capture=new AudioCapture();
  assert.deepEqual(capture.createRecordingAudioSource(),{port:12345,token:'session-token'});
  capture.stopRecordingAudioSource('session-token');
  assert.deepEqual(stopped,['session-token']);
});
test('desktop audio recording rejects old native method sets before attaching',()=>{
  let attached=0;
  const {AudioCapture}=loadWrapper(class{createRecordingAudioSource(){attached++;return {port:1,token:'bad'};}});
  const capture=new AudioCapture();
  assert.throws(()=>capture.createRecordingAudioSource(),/recording_audio_unsupported/);
  assert.equal(attached,0);
});
