import type { SpeechDetectionEvent } from '../../bindings/typescript/speech-detection.js';
import { loadEngineModule, type EngineModule } from './native.js';
import type { SpeechDetectionCommand, SpeechDetectionRequest, SpeechDetectionResponse } from './speech-detection-protocol.js';

// Runs the detection ABI in its own engine instance and sends only state events and errors.

const scope = self as unknown as DedicatedWorkerGlobalScope;
let module: EngineModule;
let model: Uint8Array;
let detector = 0;
let operations: Promise<void> = Promise.resolve();

// Process requests in order because Asyncify is not reentrant.
scope.onmessage = (event: MessageEvent<SpeechDetectionRequest>) => {
  const { id, command } = event.data;
  operations = operations.then(async () => {
    try { scope.postMessage({ id, events: await dispatch(command) } satisfies SpeechDetectionResponse); }
    catch (error) { scope.postMessage({ id, error: error instanceof Error ? error.message : 'tellus_speech_detection_failed' } satisfies SpeechDetectionResponse); }
  });
};

async function dispatch(command: SpeechDetectionCommand): Promise<SpeechDetectionEvent[]> {
  switch (command.operation) {
    case 'init': {
      module = await loadEngineModule(command.assets);
      const response = await fetch(command.assets.speechDetectionModelUrl);
      if (!response.ok) throw new Error('tellus_model_download_failed');
      model = new Uint8Array(await response.arrayBuffer());
      return [];
    }
    case 'start': {
      await destroy();
      const output = allocate(4);
      const bytes = allocate(model.length);
      try {
        module.HEAPU8.set(model, bytes);
        await call('create', [bytes, model.length, output]);
        detector = module.HEAPU32[output / 4];
      } finally { module._free(bytes); module._free(output); }
      return [];
    }
    case 'push': return push(command.samples, command.rate);
    case 'stop': await destroy(); return [];
  }
}

// Drain events after adding the samples. Poll writes two u8 flags and an 8-byte-aligned u64 timestamp.
async function push(samples: Float32Array, rate: number): Promise<SpeechDetectionEvent[]> {
  if (!detector) throw new Error('tellus_speech_detection_not_running');
  const input = allocate(samples.byteLength);
  const output = allocate(16);
  try {
    module.HEAPF32.set(samples, input / 4);
    await call('push', [detector, input, samples.length, rate]);
    const events: SpeechDetectionEvent[] = [];
    for (;;) {
      await call('poll_event', [detector, output, output + 1, output + 8]);
      if (module.HEAPU8[output] === 0) return events;
      events.push({ speaking: module.HEAPU8[output + 1] === 1, timestampMs: Number(new DataView(module.HEAPU8.buffer).getBigUint64(output + 8, true)) });
    }
  } finally { module._free(input); module._free(output); }
}

async function destroy(): Promise<void> {
  if (!detector) return;
  const handle = detector;
  detector = 0;
  await call('destroy', [handle]);
}

function allocate(size: number): number {
  const pointer = module._malloc(Math.max(1, size));
  if (!pointer) throw new Error('tellus_wasm_allocation_failed');
  return pointer;
}

// Create and push can await ORT through Asyncify.
async function call(name: string, args: number[]): Promise<void> {
  const status = Number(await module.ccall(`tellus_audio_speech_detector_${name}`, 'number', args.map(() => 'number'), args, { async: true }));
  if (status !== 0) throw new Error(module.UTF8ToString(Number(await module.ccall('tellus_audio_status_name', 'number', ['number'], [status], { async: true }))));
}
