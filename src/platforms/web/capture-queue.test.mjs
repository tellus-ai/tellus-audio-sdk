import assert from 'node:assert/strict';
import test from 'node:test';
import { CaptureQueue } from '../../../platforms/web/runtime/platforms/web/capture-queue.js';

test('variable native blocks preserve the exact dropped processing sample total', () => {
  for (const nativeRate of [16000, 44100, 48000]) {
    for (const processingRate of [16000, 48000]) {
      const queue = new CaptureQueue(processingRate, 3);
      let droppedNative = 0;
      const lengths = Array.from({ length: 47 }, (_, i) => 1 + (i * 79) % 512);
      for (let i = 0; i < lengths.length; i++) {
        if (i >= 3) droppedNative += lengths[i - 3];
        queue.push({ samples: new Float32Array(lengths[i]), nativeRate, timestamp: i, epoch: 1 });
      }
      const first = queue.shift();
      assert.equal(first.droppedSamples, Math.floor(droppedNative * processingRate / nativeRate));
      assert.equal(first.frame.timestamp, lengths.length - 3);
      assert.equal(queue.shift().droppedSamples, 0);
    }
  }
});

test('cancelled queued data and fractional loss cannot enter a resumed stream', () => {
  const queue = new CaptureQueue(16000, 1);
  queue.push({ samples: new Float32Array(1), nativeRate: 44100, timestamp: 0, epoch: 1 });
  queue.push({ samples: new Float32Array(1), nativeRate: 44100, timestamp: 1, epoch: 1 });
  queue.clear();
  assert.equal(queue.shift(), undefined);
  queue.push({ samples: new Float32Array(128), nativeRate: 48000, timestamp: 2, epoch: 2 });
  assert.equal(queue.shift().droppedSamples, 0);
});
