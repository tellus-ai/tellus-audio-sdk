import { NitroModules } from 'react-native-nitro-modules';
import type { TellusCapture } from './TellusCapture.nitro.js';
import type { AudioCapture, AudioCaptureCallback, AudioCaptureConfig, AudioChunk, CaptureStatus, NativeEngineAssets, RecordingNotificationConfig } from '../../../bindings/typescript/capture-types.js';
import type { EngineAuthorizationRequest, EngineAuthorizationStatus, EngineModelKey, EngineModelKeyRequest } from '../../../bindings/typescript/authorization/contracts.js';
import type { AudioDeviceListResult, AudioDeviceSource, AudioDeviceStatus } from '../../../bindings/typescript/audio-devices.js';

export type { AudioCapture, AudioCaptureCallback, AudioCaptureConfig, AudioChunk, CaptureStatus, NativeEngineAssets, RecordingNotificationConfig, VADConfig } from '../../../bindings/typescript/capture-types.js';
export type { AudioDeviceInfo, AudioDeviceListResult, AudioDeviceOperationError, AudioDeviceSource, AudioDeviceStatus } from '../../../bindings/typescript/audio-devices.js';

/** Lists the devices the OS currently exposes. Does not request permission or start capture. */
export async function listAudioDevices(source: AudioDeviceSource): Promise<AudioDeviceListResult> {
  if (!['microphone', 'system_audio', 'playback'].includes(source)) throw new Error('invalid_audio_device_source');
  const native = NitroModules.createHybridObject<TellusCapture>('TellusCapture');
  try {
    if (typeof native.listAudioDevices !== 'function') return { status: { source, code: 'unsupported' }, devices: [] };
    return JSON.parse(await native.listAudioDevices(source));
  } finally { try { await native.close(); } finally { native.dispose(); } }
}

// Accepts only standard unpadded base64url for 80 bytes. Does not depend on Buffer or a Node runtime.
function wrappedKeyBytes(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]{107}$/.test(value)) throw new Error('model_key_invalid');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = new Uint8Array(80);
  let bits = 0, available = 0, index = 0;
  for (const character of value) {
    bits = (bits << 6) | alphabet.indexOf(character);
    available += 6;
    if (available >= 8) { available -= 8; bytes[index++] = (bits >>> available) & 255; }
  }
  if ((bits & 3) !== 0) throw new Error('model_key_invalid');
  return bytes.buffer;
}

// Validates the public denoiseMode with the same rules as core (surrounding spaces and case ignored). Omitting it selects close_talk; unknown values are rejected.
function denoiseMode(config: AudioCaptureConfig): NonNullable<AudioCaptureConfig['denoiseMode']> {
  const value: unknown = config.denoiseMode ?? 'close_talk';
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (mode !== 'close_talk' && mode !== 'general') throw new Error('invalid_denoise_mode');
  return mode;
}

// Rates libopus encodes. core TransportEncoderConfig decides; this fails early at init.
const OPUS_SAMPLE_RATES = [8_000, 12_000, 16_000, 24_000, 48_000];

// Same as the core output rate rule. A fixed 20 ms frame must be a whole number of samples within 8k..192 kHz so the sample clock does not drift.
function isExactOutputRate(rate: number): boolean {
  return Number.isInteger(rate) && rate >= 8_000 && rate <= 192_000 && rate % 50 === 0;
}

// Decides whether transport is Opus with the same rules as core codec parsing (surrounding spaces and case ignored, opus when omitted).
function usesOpus(config: AudioCaptureConfig): boolean {
  const codec: unknown = config.transport?.codec ?? 'opus';
  return typeof codec === 'string' && codec.trim().toLowerCase() === 'opus';
}

function authorizationStatus(raw: string): EngineAuthorizationStatus {
  const status = JSON.parse(raw);
  return { state: status.state, remainingMs: status.remaining_ms, expiresAtMs: status.expires_at_ms,
    conversationId: status.conversation_id, connectionId: status.connection_id };
}

/** Connects one OS microphone to an authorized Rust session. The data callback receives only encoded transport payloads. */
class NativeAudioCapture implements AudioCapture {
  private native = NitroModules.createHybridObject<TellusCapture>('TellusCapture');
  private ready: Promise<void>;
  private devicesReady: Promise<void>;
  private models = new Map<string, { keyId: string; path: string }>();
  private loaded = new Set<string>();
  // Models that failed to load and are skipped so capture continues without denoise. Load is impossible after the first start, so reauthorization does not retry them.
  private failed = new Set<string>();
  private deliveryEpoch = 0;
  private controlRevision = 0;
  private notificationRevision = 0;
  private notificationConfig?: RecordingNotificationConfig;
  private receiving = false;
  private disposed = false;
  private denoiseEnabled: boolean;
  private sequence = 0;

  constructor(private config: AudioCaptureConfig, private assets: NativeEngineAssets) {
    const rate = config.processing?.sampleRate ?? 16_000;
    this.denoiseEnabled = config.denoiseEnabled ?? true;
    this.ready = this.native.configure(JSON.stringify({
      sampleRate: rate, denoise: this.denoiseEnabled, denoiseMode: denoiseMode(config), vad: config.vadEnabled ?? true,
      echoCancellation: config.echoCancellationEnabled ?? true, micAgc2: config.micAgc2Enabled ?? false,
      transport: { codec: config.transport?.codec ?? 'opus', bitrateBps: config.transport?.bitrateBps },
      vadGate: config.vad ? { positiveThreshold: config.vad.vadPositiveThreshold,
        negativeThreshold: config.vad.vadNegativeThreshold, silenceDurationMs: config.vad.vadSilenceDurationMs,
        preSpeechBufferMs: config.vad.vadPreSpeechBufferMs } : undefined,
    }), rate);
    this.devicesReady = this.ready.then(async () => {
      if (typeof this.native.configureAudioDevices !== 'function') {
        const source = config.micDeviceId !== undefined ? 'microphone' : 'playback';
        if (config.micDeviceId !== undefined || config.playbackDeviceId !== undefined || config.iosOutputRoute !== undefined) {
          throw Object.assign(new Error('audio_device_selection_unsupported'), { deviceStatus: { source, code: 'unsupported',
            requestedDeviceId: config.micDeviceId ?? config.playbackDeviceId } });
        }
        return;
      }
      try { await this.native.configureAudioDevices(config.micDeviceId ?? '', config.playbackDeviceId ?? '', config.iosOutputRoute ?? ''); }
      catch (error) { throw await this.deviceError(error); }
    });
    // A configuration failure propagates from the API that was called and raises no unhandled rejection even without a consumer yet.
    void this.ready.catch(() => {});
    void this.devicesReady.catch(() => {});
  }

  async createAuthorizationRequest(conversationId: string): Promise<EngineAuthorizationRequest> {
    await this.ready;
    const request = JSON.parse(await this.native.createAuthorizationRequest(conversationId));
    return { nativeInstanceId: request.native_instance_id, nonce: request.nonce, sequence: request.sequence };
  }
  async applyAuthorization(token: string): Promise<EngineAuthorizationStatus> {
    await this.ready;
    return authorizationStatus(await this.native.applyAuthorization(token));
  }
  async getAuthorizationStatus(): Promise<EngineAuthorizationStatus> {
    await this.ready;
    return authorizationStatus(await this.native.getAuthorizationStatus());
  }
  invalidateAuthorization(): void {
    ++this.controlRevision;
    ++this.notificationRevision;
    this.receiving = false;
    if (!this.disposed) this.native.invalidateAuthorization();
  }
  async createModelKeyRequests(): Promise<EngineModelKeyRequest[]> {
    await this.ready;
    const models: EngineModelKeyRequest[] = [];
    if (this.models.size === 0) {
      const registry = new Map<string, { keyId: string; path: string }>();
      for (const path of this.assets.encryptedModels) {
        const header = JSON.parse(await this.native.inspectModelFile(path));
        if (registry.has(header.model_id)) throw new Error('duplicate_encrypted_model');
        registry.set(header.model_id, { keyId: header.key_id, path });
      }
      // The engine owns the denoise model choice, so only the model count and the VAD model are checked here. Core rejects a model it does not support.
      const vad = this.config.vadEnabled ?? true;
      if (registry.size !== (vad ? 2 : 1) || registry.has('silero-vad') !== vad) throw new Error('encrypted_model_binding_invalid');
      this.models = registry;
    }
    const request = JSON.parse(await this.native.createModelKeyRequest());
    for (const [modelId, info] of this.models) {
      if (!this.loaded.has(modelId) && !this.failed.has(modelId)) models.push({ modelId, keyId: info.keyId, publicKey: request.public_key });
    }
    return models;
  }
  async applyModelKeys(keys: EngineModelKey[]): Promise<void> {
    await this.ready;
    for (const key of keys) {
      const model = this.models.get(key.modelId);
      if (!model || model.keyId !== key.keyId) throw new Error('model_key_binding_invalid');
      if (this.loaded.has(key.modelId) || this.failed.has(key.modelId)) continue;
      await this.native.applyModelKey(key.modelId, key.keyId, wrappedKeyBytes(key.wrappedKey));
      try { await this.native.loadModelFile(model.path); }
      catch (error) {
        // Capture continues without denoise if the denoise model fails to load. Only a failure core recorded that way is tolerated; key and container errors still throw.
        if (key.modelId === 'silero-vad' || !JSON.parse(await this.native.getStatus()).denoise_load_failed) throw error;
        console.warn('denoise_load_failed: capture continues without denoise', error);
        this.failed.add(key.modelId);
        continue;
      }
      this.loaded.add(key.modelId);
    }
  }
  async start(callback: AudioCaptureCallback): Promise<void> {
    const revision = ++this.controlRevision;
    await this.devicesReady;
    this.checkControl(revision);
    if (this.notificationConfig) await this.setRecordingNotification(this.notificationConfig);
    this.checkControl(revision);
    const deliveryEpoch = ++this.deliveryEpoch;
    this.receiving = true;
    this.sequence = 0;
    try {
      await this.native.start((payload, raw, epoch, generation) => {
        try {
          if (this.disposed || !this.receiving || deliveryEpoch !== this.deliveryEpoch || !this.native.canDeliver(epoch, generation)) return;
          const chunk = JSON.parse(raw);
          const gap = chunk.discontinuity;
          if (!this.native.canDeliver(epoch, generation)) return;
          callback(null, {
            data: { microphone: new Uint8Array(payload) }, trackSource: 'microphone', codec: chunk.codec,
            sampleRate: chunk.sample_rate, sample: chunk.sample, sampleCount: chunk.sample_count,
            validSampleCount: chunk.valid_sample_count, timestamp: chunk.timestamp, rms: chunk.rms,
            durationMs: chunk.sample_count * 1000 / chunk.sample_rate, gateEvent: chunk.gate_event,
            vadRms: chunk.vad_rms, sequence: this.sequence++,
            discontinuity: gap ? { reason: gap.reason, droppedChunks: gap.dropped_chunks, droppedSamples: gap.dropped_samples,
              fromSample: gap.from_sample, toSample: gap.to_sample } : undefined,
          });
        } finally { if (!this.disposed) this.native.acknowledgeChunk(); }
      }, code => {
        if (this.disposed || deliveryEpoch !== this.deliveryEpoch) return;
        this.receiving = false;
        const errorRevision = this.controlRevision;
        void this.deviceError(new Error(code)).then(error => {
          if (!this.disposed && deliveryEpoch === this.deliveryEpoch && errorRevision === this.controlRevision) callback(error);
        });
      });
    } catch (error) { if (revision === this.controlRevision) this.receiving = false; throw await this.deviceError(error); }
  }
  async pause(): Promise<void> { ++this.controlRevision; this.receiving = false; await this.native.pause(); }
  async resume(): Promise<void> {
    const revision = ++this.controlRevision;
    await this.devicesReady;
    if (this.notificationConfig) await this.setRecordingNotification(this.notificationConfig);
    this.checkControl(revision);
    this.receiving = true;
    try { await this.native.resume(); } catch (error) { if (revision === this.controlRevision) this.receiving = false; throw await this.deviceError(error); }
  }
  async stop(): Promise<void> {
    const revision = ++this.controlRevision;
    ++this.notificationRevision;
    try { await this.native.stop(); }
    finally { if (revision === this.controlRevision) { this.receiving = false; ++this.deliveryEpoch; } }
  }
  async reset(): Promise<void> {
    const receiving = this.receiving;
    const revision = ++this.controlRevision;
    this.receiving = false;
    await this.native.reset();
    if (revision === this.controlRevision) this.receiving = receiving;
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.notificationConfig = undefined;
    ++this.controlRevision;
    ++this.notificationRevision;
    this.receiving = false;
    ++this.deliveryEpoch;
    try { await this.native.close(); } finally { this.native.dispose(); }
  }
  async getStatus(): Promise<CaptureStatus> {
    await this.ready;
    const status = JSON.parse(await this.native.getStatus());
    const deviceStatus = typeof this.native.getAudioDeviceStatus === 'function'
      ? JSON.parse(await this.native.getAudioDeviceStatus()) as AudioDeviceStatus[] : undefined;
    return { state: status.lifecycle, denoiseEnabled: status.denoise_enabled, denoiseMode: status.denoise_mode,
      denoiseLoadFailed: status.denoise_load_failed, vadEnabled: this.config.vadEnabled ?? true,
      modelsLoaded: [...this.loaded], deviceStatus };
  }
  async setDenoiseEnabled(enabled: boolean): Promise<void> {
    await this.ready;
    await this.native.setDenoiseEnabled(enabled);
    this.denoiseEnabled = enabled;
  }
  async setRecordingNotification(config: RecordingNotificationConfig): Promise<void> {
    await this.ready;
    if (!config.title || config.title.length > 256 || config.contentText.length > 1024) throw new Error('invalid_recording_notification');
    config = { ...config };
    this.notificationConfig = config;
    const revision = ++this.notificationRevision;
    await this.native.setRecordingNotification(config.title, config.contentText, !!config.onPause, !!config.onResume, action => {
      if (this.disposed || revision !== this.notificationRevision) return;
      void this.getAuthorizationStatus().then(status => {
        if (this.disposed || revision !== this.notificationRevision || status.state !== 'authorized' || status.remainingMs <= 0) return;
        if (action === 'pause') config.onPause?.();
        else if (action === 'resume') config.onResume?.();
      }).catch(() => {});
    });
  }
  private checkControl(revision: number): void {
    if (this.disposed || revision !== this.controlRevision) throw new Error('capture_cancelled');
  }
  private async deviceError(error: unknown, source?: AudioDeviceSource): Promise<Error> {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (typeof this.native.getAudioDeviceStatus !== 'function' || this.disposed) return failure;
    try {
      const statuses = JSON.parse(await this.native.getAudioDeviceStatus()) as AudioDeviceStatus[];
      const failures = statuses.filter(status => source === undefined || status.source === source);
      // Reports a permission or selection failure ahead of the unavailable status of another stream stopped with it.
      const deviceStatus = failures.find(status => status.code === 'permission_denied')
        ?? failures.find(status => status.code === 'route_mismatch')
        ?? failures.find(status => status.code === 'unsupported')
        ?? failures.find(status => status.code === 'unavailable');
      if (deviceStatus) Object.assign(failure, { deviceStatus });
    } catch { /* A failed status lookup must not replace the original operation error. */ }
    return failure;
  }
  async playback(samples: Float32Array, nativeRate: number): Promise<void> {
    await this.devicesReady;
    try { await this.native.playback(samples.slice().buffer, nativeRate); }
    catch (error) { throw await this.deviceError(error, 'playback'); }
  }
  async cancelPlayback(): Promise<void> { await this.native.cancelPlayback(); }
  async playbackEncoded(encoded: ArrayBuffer): Promise<void> {
    await this.devicesReady;
    try { await this.native.playbackEncoded(encoded); }
    catch (error) { throw await this.deviceError(error, 'playback'); }
  }
}

/** Each capture owns its own authorization, models, and processing state. Default models are the encrypted resources the SDK copied. */
export class AudioEngine {
  private constructor(private config: AudioCaptureConfig, private assets: NativeEngineAssets) {}
  static async init(config: AudioCaptureConfig = {}, assets?: NativeEngineAssets): Promise<AudioEngine> {
    for (const id of [config.micDeviceId, config.systemAudioDeviceId, config.playbackDeviceId]) {
      if (id !== undefined && (typeof id !== 'string' || !id.trim() || id.includes('\0'))) throw new Error('invalid_audio_device_id');
    }
    if (config.iosOutputRoute !== undefined && config.iosOutputRoute !== 'speaker' && config.iosOutputRoute !== 'system') throw new Error('invalid_ios_output_route');
    if (config.systemAudioDeviceId !== undefined) throw Object.assign(new Error('audio_device_selection_unsupported'), {
      deviceStatus: { source: 'system_audio', code: 'unsupported', requestedDeviceId: config.systemAudioDeviceId },
    });
    const rate = config.processing?.sampleRate ?? 16_000;
    if (!isExactOutputRate(rate) || (config.processing?.chunkDurationMs ?? 20) !== 20) throw new Error('invalid_processing_config');
    if (usesOpus(config) && !OPUS_SAMPLE_RATES.includes(rate)) throw new Error('opus_sample_rate_unsupported');
    if (config.micEnabled === false || config.speakerEnabled === true || config.enableRawAudio === true) throw new Error('unsupported_mobile_capture_config');
    const mode = denoiseMode(config);
    // Each capture loads one denoise model and an optional VAD model, so the default assets pick only those.
    const encryptedModels = assets?.encryptedModels ?? ['dfn3-48.temc',
      ...((config.vadEnabled ?? true) ? ['silero-vad.temc'] : [])];
    if (!encryptedModels.length || encryptedModels.length > 2 || encryptedModels.some(path => !path)) throw new Error('invalid_encrypted_model_assets');
    return new AudioEngine({ ...config, denoiseMode: mode, processing: { ...config.processing }, transport: { ...config.transport }, vad: config.vad ? { ...config.vad } : undefined },
      { encryptedModels: [...encryptedModels] });
  }
  createCapture(): AudioCapture { return new NativeAudioCapture(this.config, this.assets); }
}
