import type { AudioCaptureConfig, AudioChunk } from '../platform/capture-types.js';
import type { DeliveredChunk } from './protocol.js';

export interface EngineModule {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  addFunction(callback: (...args: any[]) => void, signature: string): number;
  removeFunction(pointer: number): void;
  ccall(name: string, returnType: string, argumentTypes: string[], args: unknown[], options?: { async: boolean }): unknown;
  UTF8ToString(pointer: number): string;
  tellusCancellationGeneration: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** C ABI 메모리를 관리하며 각 호출 완료 후 다음 호출을 시작한다. */
export class NativeEngine {
  constructor(readonly module: EngineModule) {}

  async call(name: string, args: unknown[] = []): Promise<number> {
    const result = Number(await this.module.ccall(`tellus_audio_${name}`, 'number', args.map(() => 'number'), args, { async: true }));
    return result;
  }

  async checked(name: string, args: unknown[] = []): Promise<void> {
    const result = await this.call(name, args);
    if (result !== 0) {
      const pointer = await this.call('status_name', [result]);
      throw new Error(this.module.UTF8ToString(pointer));
    }
  }

  async bytes<T>(bytes: Uint8Array, use: (pointer: number, length: number) => Promise<T>): Promise<T> {
    const pointer = this.module._malloc(Math.max(1, bytes.length));
    if (!pointer) throw new Error('tellus_wasm_allocation_failed');
    this.module.HEAPU8.set(bytes, pointer);
    try { return await use(pointer, bytes.length); }
    finally { this.module._free(pointer); }
  }

  async text<T>(value: string, use: (pointer: number, length: number) => Promise<T>): Promise<T> {
    return this.bytes(encoder.encode(value), use);
  }

  async json<T>(name: string, args: unknown[]): Promise<T> {
    const output = this.module._malloc(4096);
    const written = this.module._malloc(4);
    if (!output || !written) {
      if (output) this.module._free(output);
      if (written) this.module._free(written);
      throw new Error('tellus_wasm_allocation_failed');
    }
    try {
      await this.checked(name, [...args, output, 4096, written]);
      const length = this.module.HEAPU32[written / 4];
      return JSON.parse(decoder.decode(this.module.HEAPU8.subarray(output, output + length))) as T;
    } finally {
      this.module._free(output);
      this.module._free(written);
    }
  }

  async create(config: AudioCaptureConfig): Promise<NativeCapture> {
    const output = this.module._malloc(4);
    if (!output) throw new Error('tellus_wasm_allocation_failed');
    let handle = 0;
    try {
      await this.checked('session_create', [output]);
      handle = this.module.HEAPU32[output / 4];
      await this.text(JSON.stringify(nativeConfig(config)), (pointer, length) => this.checked('session_configure', [handle, pointer, length]));
      return new NativeCapture(this, handle);
    } catch (error) {
      if (handle) await this.checked('session_destroy', [handle]);
      throw error;
    } finally { this.module._free(output); }
  }
}

function nativeConfig(config: AudioCaptureConfig): object {
  if (config.processing?.chunkDurationMs !== undefined && config.processing.chunkDurationMs !== 20) {
    throw new Error('tellus_chunk_duration_must_be_20ms');
  }
  if (config.micEnabled === false || config.speakerEnabled || config.enableRawAudio) {
    throw new Error('tellus_browser_capture_requires_encoded_microphone');
  }
  const vad = config.vad;
  return {
    sampleRate: config.processing?.sampleRate ?? 16000,
    denoise: config.denoiseEnabled ?? false,
    vad: config.vadEnabled ?? false,
    echoCancellation: config.echoCancellationEnabled ?? true,
    micAgc2: config.micAgc2Enabled ?? false,
    transport: { codec: config.transport?.codec ?? 'opus', ...(config.transport?.bitrateBps === undefined ? {} : { bitrateBps: config.transport.bitrateBps }) },
    ...(vad ? { vadGate: {
      positiveThreshold: vad.vadPositiveThreshold ?? 0.5,
      negativeThreshold: vad.vadNegativeThreshold ?? 0.35,
      silenceDurationMs: vad.vadSilenceDurationMs ?? 550,
      preSpeechBufferMs: vad.vadPreSpeechBufferMs ?? 500,
    } } : {}),
  };
}

export class NativeCapture {
  private chunks: DeliveredChunk[] = [];
  private readonly callback: number;

  constructor(private readonly engine: NativeEngine, readonly handle: number) {
    this.callback = engine.module.addFunction((_context, pointer, length, metadata, metadataLength, epoch: bigint, generation: bigint) => {
      const data = engine.module.HEAPU8.slice(pointer, pointer + length);
      const native = JSON.parse(decoder.decode(engine.module.HEAPU8.subarray(metadata, metadata + metadataLength)));
      const chunk: AudioChunk = {
        data: { microphone: data }, trackSource: 'microphone', codec: native.codec,
        sampleRate: native.sample_rate, sampleCount: native.sample_count,
        validSampleCount: native.valid_sample_count, durationMs: native.sample_count * 1000 / native.sample_rate,
        sample: native.sample, timestamp: native.timestamp, rms: native.rms,
        ...(native.gate_event == null ? {} : { gateEvent: native.gate_event }),
        ...(native.vad_rms == null ? {} : { vadRms: native.vad_rms }),
        ...(native.discontinuity == null ? {} : { discontinuity: {
          reason: native.discontinuity.reason, droppedChunks: native.discontinuity.dropped_chunks,
          droppedSamples: native.discontinuity.dropped_samples,
          fromSample: native.discontinuity.from_sample, toSample: native.discontinuity.to_sample,
        } }),
      };
      this.chunks.push({ chunk, epoch: epoch.toString(), authorizationGeneration: generation.toString() });
    }, 'viiiiijj');
  }

  call(operation: string, args: unknown[] = []): Promise<void> {
    return this.engine.checked(`session_${operation}`, [this.handle, ...args]);
  }

  json<T>(operation: string): Promise<T> {
    return this.engine.json(`session_${operation}`, [this.handle]);
  }

  text(operation: string, value: string): Promise<void> {
    return this.engine.text(value, (pointer, length) => this.call(operation, [pointer, length]));
  }

  authorizationRequest(conversation: string): Promise<unknown> {
    return this.engine.text(conversation, (pointer, length) => this.engine.json('session_create_authorization_request', [this.handle, pointer, length]));
  }

  async applyModelKey(modelId: string, keyId: string, wrappedKey: Uint8Array): Promise<void> {
    await this.engine.text(modelId, (model, modelLength) => this.engine.text(keyId, (key, keyLength) =>
      this.engine.bytes(wrappedKey, (wrapped, wrappedLength) => this.call('apply_model_key', [model, modelLength, key, keyLength, wrapped, wrappedLength]))));
  }

  loadModel(bytes: Uint8Array): Promise<void> {
    return this.engine.bytes(bytes, (pointer, length) => this.call('load_model', [pointer, length]));
  }

  async push(samples: Float32Array, rate: number, timestamp?: number): Promise<DeliveredChunk[]> {
    this.chunks = [];
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    await this.engine.bytes(bytes, (pointer) => timestamp === undefined
      ? this.call('push_render', [pointer, samples.length, rate])
      : this.call('push_capture', [pointer, samples.length, rate, BigInt(timestamp), this.callback, 0]));
    return this.chunks;
  }

  async stop(): Promise<DeliveredChunk[]> {
    this.chunks = [];
    await this.call('stop', [this.callback, 0]);
    return this.chunks;
  }

  async canDeliver(epoch: string, generation: string): Promise<boolean> {
    return await this.engine.call('session_can_deliver', [this.handle, BigInt(epoch), BigInt(generation)]) === 1;
  }

  async destroy(): Promise<void> {
    await this.call('destroy');
    this.engine.module.removeFunction(this.callback);
  }
}
