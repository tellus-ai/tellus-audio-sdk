const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const packageName = '@tellus-ai/audio-sdk-desktop';
const entry = require.resolve(packageName);
const engineRuntime = require(path.join(path.dirname(entry), 'runtime/engine-runtime.js'));

function loadDesktop(nativeBinding) {
  const prepareEngineRuntime = engineRuntime.prepareEngineRuntime;
  engineRuntime.prepareEngineRuntime = () => ({ nativeBinding });
  try {
    return require(packageName);
  } finally {
    delete require.cache[entry];
    engineRuntime.prepareEngineRuntime = prepareEngineRuntime;
  }
}

function recordingBinding(calls) {
  return {
    initLogging(...args) { calls.push(['initLogging', ...args]); },
    configureLogging(...args) { calls.push(['configureLogging', ...args]); },
  };
}

test('desktop initLogging keeps the legacy level form on native initLogging', () => {
  const calls = [];
  const { initLogging } = loadDesktop(recordingBinding(calls));

  initLogging('audio_capture=debug');
  initLogging(null);
  initLogging();

  assert.deepEqual(calls, [
    ['initLogging', 'audio_capture=debug'],
    ['initLogging', null],
    ['initLogging', undefined],
  ]);
});

test('desktop initLogging options configure the engine without console output and without a sink by default', () => {
  const calls = [];
  const { initLogging } = loadDesktop(recordingBinding(calls));

  initLogging({ level: 'audio_capture=info' });

  assert.deepEqual(calls, [['configureLogging', { level: 'audio_capture=info', console: undefined }, undefined]]);
});

test('desktop initLogging delivers each native entry to onLog and isolates a throwing handler', () => {
  const calls = [];
  const { initLogging } = loadDesktop(recordingBinding(calls));
  const received = [];

  initLogging({
    level: 'trace',
    console: true,
    onLog: (logEntry) => {
      received.push(logEntry);
      if (received.length === 1) throw new Error('host log handler failed');
    },
  });

  const [[name, options, deliver]] = calls;
  assert.equal(name, 'configureLogging');
  assert.deepEqual(options, { level: 'trace', console: true });
  const entries = [
    { level: 'info', target: 'audio_capture', message: 'Microphone initialized sample_rate=48000', timestampMs: 1 },
    { level: 'warn', target: 'audio_capture::logging', message: '3 engine log entries dropped', timestampMs: 2 },
  ];
  assert.doesNotThrow(() => deliver(entries));
  assert.deepEqual(received, entries);
});

test('desktop initLogging surfaces an invalid level from the engine', () => {
  const { initLogging } = loadDesktop({
    configureLogging() { throw new Error('logging_level_invalid'); },
  });

  assert.throws(() => initLogging({ level: 'audio_capture=loud' }), /logging_level_invalid/);
});
