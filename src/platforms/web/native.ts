import type { AudioCaptureConfig, AudioChunk, BrowserEngineAssets } from '../../bindings/typescript/capture-types.js';
import { gainConfig } from '../../bindings/typescript/audio-gain.js';
import { denoiseMode, outputSampleRate, type DeliveredChunk } from './protocol.js';

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

/** Loads single-threaded ORT and a separate WASM instance for each worker. */
export async function loadEngineModule(assets: Omit<BrowserEngineAssets, 'encryptedModels'>): Promise<EngineModule> {
  const ortUrl = assets.ortModuleUrl ?? new URL('ort.wasm.bundle.min.mjs', assets.ortWasmBaseUrl).href;
  const ort = await import(/* @vite-ignore */ ortUrl);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = assets.ortWasmBaseUrl;
  const imported = await import(/* @vite-ignore */ assets.engineModuleUrl);
  if (typeof imported.default !== 'function') throw new Error('tellus_engine_module_invalid');
  return imported.default({
    locateFile: (name: string) => name.endsWith('.wasm') ? assets.wasmUrl : new URL(name, assets.engineModuleUrl).href,
    tellusOrt: ort, tellusOrtWasmBaseUrl: assets.ortWasmBaseUrl, tellusCancellationGeneration: 0,
  });
}

/** Manages C ABI memory and starts each call after the previous one completes. */
export class NativeEngine {
  constructor(readonly module: EngineModule) {}

  /** Whether the loaded wasm exports a C ABI function, so engines older than an API reject it explicitly. */
  supports(name: string): boolean { return typeof (this.module as any)[`_tellus_audio_${name}`] === 'function'; }

  async call(name: string, args: unknown[] = []): Promise<number> {
    const result = Number(await this.module.ccall(`tellus_audio_${name}`, 'number', args.map(() => 'number'), args, { async: true }));
    return result;
  }

  /** Throws the status name on a non-zero status. With a session handle it appends the engine explanation as "code: explanation" (code only when there is none or the engine is old). */
  async checked(name: string, args: unknown[] = [], session?: number): Promise<void> {
    const result = await this.call(name, args);
    if (result !== 0) {
      const pointer = await this.call('status_name', [result]);
      const code = this.module.UTF8ToString(pointer);
      const message = session === undefined ? '' : await this.lastError(session);
      throw new Error(message && message !== code ? `${code}: ${message}` : code);
    }
  }

  /** The session's last failure explanation; empty when none failed or the engine has no copy_last_error export. */
  async lastError(session: number): Promise<string> {
    if (!this.supports('session_copy_last_error')) return '';
    const capacity = 1024;
    const buffer = this.module._malloc(capacity);
    if (!buffer) return '';
    try {
      if (await this.call('session_copy_last_error', [session, buffer, capacity]) === 0) return '';
      const bytes = this.module.HEAPU8.subarray(buffer, buffer + capacity);
      const end = bytes.indexOf(0);
      return decoder.decode(bytes.subarray(0, end < 0 ? capacity : end));
    } finally { this.module._free(buffer); }
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

  async json<T>(name: string, args: unknown[], session?: number): Promise<T> {
    const output = this.module._malloc(4096);
    const written = this.module._malloc(4);
    if (!output || !written) {
      if (output) this.module._free(output);
      if (written) this.module._free(written);
      throw new Error('tellus_wasm_allocation_failed');
    }
    try {
      await this.checked(name, [...args, output, 4096, written], session);
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
      await this.text(JSON.stringify(nativeConfig(config)), (pointer, length) => this.checked('session_configure', [handle, pointer, length], handle));
      return new NativeCapture(this, handle);
    } catch (error) {
      if (handle) await this.checked('session_destroy', [handle]);
      throw error;
    } finally { this.module._free(output); }
  }
}

function nativeConfig(config: AudioCaptureConfig): object {
  const gain = gainConfig(config);
  if (gain.speakerGainDb !== 0) throw new Error('tellus_speaker_gain_unsupported');
  if (config.micEnabled === false || config.speakerEnabled || config.enableRawAudio) {
    throw new Error('tellus_browser_capture_requires_encoded_microphone');
  }
  const vad = config.vad;
  return {
    micGainDb: gain.micGainDb,
    autoGainControl: gain.autoGainControl,
    sampleRate: outputSampleRate(config),
    denoise: config.denoiseEnabled ?? false,
    denoiseMode: denoiseMode(config),
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
        closeTalkGate: native.close_talk_gate == null ? null : {
          open: native.close_talk_gate.open, openRatio: native.close_talk_gate.open_ratio,
          lsnrDb: native.close_talk_gate.lsnr_db ?? null, levelDbfs: native.close_talk_gate.level_dbfs ?? null,
          learnedLevelDbfs: native.close_talk_gate.learned_level_dbfs ?? null,
        },
        ...(native.vad_rms == null ? {} : { vadRms: native.vad_rms }),
        ...(native.discontinuity == null ? {} : { discontinuity: {
          reason: native.discontinuity.reason, droppedChunks: native.discontinuity.dropped_chunks,
          droppedSamples: native.discontinuity.dropped_samples,
          fromSample: native.discontinuity.from_sample, toSample: native.discontinuity.to_sample,
        } }),
        // The engine omits zero input counts and old engines never send them.
        inputClippedSamples: native.input_clipped_samples ?? 0,
        inputNonFiniteSamples: native.input_non_finite_samples ?? 0,
        inputTimestampRegressions: native.input_timestamp_regressions ?? 0,
      };
      this.chunks.push({ chunk, epoch: epoch.toString(), authorizationGeneration: generation.toString() });
    }, 'viiiiijj');
  }

  call(operation: string, args: unknown[] = []): Promise<void> {
    return this.engine.checked(`session_${operation}`, [this.handle, ...args], this.handle);
  }

  json<T>(operation: string): Promise<T> {
    return this.engine.json(`session_${operation}`, [this.handle], this.handle);
  }

  /** This session's last failure explanation, or null when there is none. */
  async lastError(): Promise<string | null> {
    return (await this.engine.lastError(this.handle)) || null;
  }

  text(operation: string, value: string): Promise<void> {
    return this.engine.text(value, (pointer, length) => this.call(operation, [pointer, length]));
  }

  authorizationRequest(conversation: string): Promise<unknown> {
    return this.engine.text(conversation, (pointer, length) => this.engine.json('session_create_authorization_request', [this.handle, pointer, length], this.handle));
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
