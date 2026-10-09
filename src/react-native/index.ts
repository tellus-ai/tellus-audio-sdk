import { NitroModules } from 'react-native-nitro-modules';
import type { TellusCapture } from './TellusCapture.nitro';
import type { AudioCapture, AudioCaptureCallback, AudioCaptureConfig, AudioChunk, CaptureStatus, NativeEngineAssets, RecordingNotificationConfig } from '../platform/capture-types';
import type { EngineAuthorizationRequest, EngineAuthorizationStatus, EngineModelKey, EngineModelKeyRequest } from '../authorization/contracts';

export type { AudioCapture, AudioCaptureCallback, AudioCaptureConfig, AudioChunk, CaptureStatus, NativeEngineAssets, RecordingNotificationConfig, VADConfig } from '../platform/capture-types';

// 표준 padding 없는 base64url 80바이트만 허용한다. Buffer/Node runtime에 의존하지 않는다.
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

function authorizationStatus(raw: string): EngineAuthorizationStatus {
  const status = JSON.parse(raw);
  return { state: status.state, remainingMs: status.remaining_ms, expiresAtMs: status.expires_at_ms,
    conversationId: status.conversation_id, connectionId: status.connection_id };
}

/** OS 마이크 한 개를 승인된 Rust 세션에 연결한다. 데이터 callback에는 인코딩된 전송 payload만 제공한다. */
class NativeAudioCapture implements AudioCapture {
  private native = NitroModules.createHybridObject<TellusCapture>('TellusCapture');
  private ready: Promise<void>;
  private models = new Map<string, { keyId: string; path: string }>();
  private loaded = new Set<string>();
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
      sampleRate: rate, denoise: this.denoiseEnabled, vad: config.vadEnabled ?? true,
      echoCancellation: config.echoCancellationEnabled ?? true, micAgc2: config.micAgc2Enabled ?? false,
      transport: { codec: config.transport?.codec ?? 'opus', bitrateBps: config.transport?.bitrateBps },
      vadGate: config.vad ? { positiveThreshold: config.vad.vadPositiveThreshold,
        negativeThreshold: config.vad.vadNegativeThreshold, silenceDurationMs: config.vad.vadSilenceDurationMs,
        preSpeechBufferMs: config.vad.vadPreSpeechBufferMs } : undefined,
    }), rate);
    // 구성 실패는 호출한 API에서 전파하며 아직 소비자가 없어도 unhandled rejection을 만들지 않는다.
    void this.ready.catch(() => {});
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
      const expected = [(this.config.processing?.sampleRate ?? 16000) === 16000 ? 'fe-s16' : 'fe-s48',
        ...((this.config.vadEnabled ?? true) ? ['silero-vad'] : [])];
      if (registry.size !== expected.length || expected.some(model => !registry.has(model))) throw new Error('encrypted_model_binding_invalid');
      this.models = registry;
    }
    const request = JSON.parse(await this.native.createModelKeyRequest());
    for (const [modelId, info] of this.models) {
      if (!this.loaded.has(modelId)) models.push({ modelId, keyId: info.keyId, publicKey: request.public_key });
    }
    return models;
  }
  async applyModelKeys(keys: EngineModelKey[]): Promise<void> {
    await this.ready;
    for (const key of keys) {
      const model = this.models.get(key.modelId);
      if (!model || model.keyId !== key.keyId) throw new Error('model_key_binding_invalid');
      if (this.loaded.has(key.modelId)) continue;
      await this.native.applyModelKey(key.modelId, key.keyId, wrappedKeyBytes(key.wrappedKey));
      await this.native.loadModelFile(model.path);
      this.loaded.add(key.modelId);
    }
  }
  async start(callback: AudioCaptureCallback): Promise<void> {
    const revision = ++this.controlRevision;
    await this.ready;
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
        callback(new Error(code));
      });
    } catch (error) { if (revision === this.controlRevision) this.receiving = false; throw error; }
  }
  async pause(): Promise<void> { ++this.controlRevision; this.receiving = false; await this.native.pause(); }
  async resume(): Promise<void> {
    const revision = ++this.controlRevision;
    if (this.notificationConfig) await this.setRecordingNotification(this.notificationConfig);
    this.checkControl(revision);
    this.receiving = true;
    try { await this.native.resume(); } catch (error) { if (revision === this.controlRevision) this.receiving = false; throw error; }
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
    return { state: status.lifecycle, denoiseEnabled: status.denoise_enabled,
      vadEnabled: this.config.vadEnabled ?? true, modelsLoaded: [...this.loaded] };
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
  async playback(samples: Float32Array, nativeRate: number): Promise<void> {
    await this.ready;
    await this.native.playback(samples.slice().buffer, nativeRate);
  }
  async cancelPlayback(): Promise<void> { await this.native.cancelPlayback(); }
  async playbackEncoded(encoded: ArrayBuffer): Promise<void> {
    await this.ready;
    await this.native.playbackEncoded(encoded);
  }
}

/** 각 capture는 독립 승인·모델·처리 상태를 소유한다. 기본 모델은 SDK가 복사한 암호화 resource다. */
export class AudioEngine {
  private constructor(private config: AudioCaptureConfig, private assets: NativeEngineAssets) {}
  static async init(config: AudioCaptureConfig = {}, assets?: NativeEngineAssets): Promise<AudioEngine> {
    const rate = config.processing?.sampleRate ?? 16_000;
    if (![16_000, 48_000].includes(rate) || (config.processing?.chunkDurationMs ?? 20) !== 20) throw new Error('invalid_processing_config');
    if (config.micEnabled === false || config.speakerEnabled === true || config.enableRawAudio === true) throw new Error('unsupported_mobile_capture_config');
    const encryptedModels = assets?.encryptedModels ?? [rate === 16_000 ? 'fe-s16.temc' : 'fe-s48.temc',
      ...((config.vadEnabled ?? true) ? ['silero-vad.temc'] : [])];
    if (!encryptedModels.length || encryptedModels.length > 2 || encryptedModels.some(path => !path)) throw new Error('invalid_encrypted_model_assets');
    return new AudioEngine({ ...config, processing: { ...config.processing }, transport: { ...config.transport }, vad: config.vad ? { ...config.vad } : undefined },
      { encryptedModels: [...encryptedModels] });
  }
  createCapture(): AudioCapture { return new NativeAudioCapture(this.config, this.assets); }
}
