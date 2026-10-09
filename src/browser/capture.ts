import type {
  AudioCapture, AudioCaptureCallback, AudioCaptureConfig, CaptureStatus,
} from '../platform/capture-types.js';
import type { EngineAuthorizationRequest, EngineAuthorizationStatus } from '../authorization/contracts.js';
import { CaptureQueue, type CaptureFrame } from './capture-queue.js';
import type { DeliveredChunk, NativeStatus, WorkerCommand } from './protocol.js';
import { WorkerClient } from './worker-client.js';

interface NativeAuthorizationStatus {
  state: EngineAuthorizationStatus['state'];
  remaining_ms: number;
  expires_at_ms?: number;
  conversation_id?: string;
  connection_id?: string;
}

/** 메인 스레드의 수명과 OS 라우팅을 관리한다. 처리 샘플은 Rust가 생성한다. */
export class BrowserCapture implements AudioCapture {
  private readonly ready: Promise<number>;
  private sessionId = 0;
  private epoch = 0;
  private state: CaptureStatus['state'] = 'idle';
  private disposed = false;
  private denoiseEnabled: boolean;
  private denoiseUpdates = 0;
  private callback?: AudioCaptureCallback;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private tap?: AudioWorkletNode;
  private readonly queue: CaptureQueue;
  private pumping = false;
  private renderQueue: CaptureFrame[] = [];
  private rendering = false;
  private renderIdle: Promise<void> = Promise.resolve();
  private playbackSource?: AudioBufferSourceNode;
  private playbackTap?: AudioWorkletNode;
  private finishPlayback?: () => void;
  private playbackEpoch = 0;
  private playbackCleanup: Promise<void> = Promise.resolve();
  private approval?: { remainingMs: number; monotonicStart: number; wallStart: number };

  constructor(private readonly client: WorkerClient, private readonly context: AudioContext, private readonly config: AudioCaptureConfig) {
    this.queue = new CaptureQueue(config.processing?.sampleRate ?? 16000);
    this.denoiseEnabled = !!config.denoiseEnabled;
    this.ready = client.request<number>(0, 0, { operation: 'create', config }).then((id) => {
      this.sessionId = id;
      if (this.epoch) client.cancel(id, this.epoch);
      return id;
    });
    void this.ready.catch(() => {});
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private async request<T>(command: WorkerCommand, epoch = this.epoch): Promise<T> {
    if (this.disposed) throw new Error('tellus_capture_disposed');
    const id = await this.ready;
    return this.client.request<T>(id, epoch, command);
  }

  async createAuthorizationRequest(conversationId: string): Promise<EngineAuthorizationRequest> {
    const native = await this.request<{ native_instance_id: string; nonce: string; sequence: number }>({ operation: 'authorizationRequest', conversationId });
    return { nativeInstanceId: native.native_instance_id, nonce: native.nonce, sequence: native.sequence };
  }

  async applyAuthorization(token: string): Promise<EngineAuthorizationStatus> {
    const epoch = this.epoch;
    const start = { monotonicStart: performance.now(), wallStart: Date.now() };
    const status = await this.request<NativeAuthorizationStatus>({ operation: 'applyAuthorization', token }, epoch);
    if (epoch !== this.epoch) throw new Error('engine_authorization_cancelled');
    this.approval = status.state === 'authorized' ? { ...start, remainingMs: status.remaining_ms } : undefined;
    return authorizationStatus(status);
  }

  async getAuthorizationStatus(): Promise<EngineAuthorizationStatus> {
    return authorizationStatus(await this.request<NativeAuthorizationStatus>({ operation: 'authorizationStatus' }));
  }

  async invalidateAuthorization(): Promise<void> {
    this.approval = undefined;
    this.cancel();
    this.closeMicrophone();
    this.state = 'stopped';
    await this.request({ operation: 'invalidate' });
  }

  createModelKeyRequests(): Promise<{ modelId: string; keyId: string; publicKey: string }[]> {
    return this.request({ operation: 'modelRequests' });
  }

  applyModelKeys(keys: { modelId: string; keyId: string; wrappedKey: string }[]): Promise<void> {
    return this.request({ operation: 'modelKeys', keys });
  }

  async start(callback: AudioCaptureCallback): Promise<void> {
    if (this.state === 'running') throw new Error('tellus_capture_already_running');
    this.callback = callback;
    const epoch = this.epoch;
    this.state = 'running';
    const resumed = this.context.resume();
    try {
      await this.request({ operation: 'start' }, epoch);
      if (epoch !== this.epoch) return;
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('tellus_microphone_requires_secure_context');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      } });
      if (epoch !== this.epoch) { stream.getTracks().forEach((track) => track.stop()); return; }
      await resumed;
      if (epoch !== this.epoch) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      this.source = this.context.createMediaStreamSource(stream);
      this.tap = this.createTap(false);
      this.tap.port.onmessage = (event: MessageEvent<CaptureFrame>) => {
        if (this.state !== 'running' || event.data.epoch !== this.epoch) return;
        this.queue.push(event.data);
        void this.pump();
      };
      this.state = 'running';
      this.tap.port.postMessage({ active: true, epoch });
      this.source.connect(this.tap);
      this.tap.connect(this.context.destination);
      for (const track of stream.getTracks()) track.addEventListener('ended', this.onDeviceEnded);
    } catch (error) { await this.stop(); throw error; }
  }

  async pause(): Promise<void> {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.cancel();
    this.stream?.getTracks().forEach((track) => { track.enabled = false; });
    await this.request({ operation: 'pause' });
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused') throw new Error('tellus_capture_not_paused');
    if (!this.stream?.getTracks().some((track) => track.readyState === 'live')) {
      const callback = this.callback;
      if (!callback) throw new Error('tellus_capture_callback_missing');
      const previousEpoch = this.epoch;
      await this.stop();
      if (this.epoch !== previousEpoch + 1) return;
      await this.start(callback);
      return;
    }
    const epoch = this.epoch;
    await this.request({ operation: 'resume' }, epoch);
    if (epoch !== this.epoch) return;
    this.state = 'running';
    this.stream?.getTracks().forEach((track) => { track.enabled = true; });
    this.tap?.port.postMessage({ active: true, epoch });
  }

  async stop(): Promise<void> {
    const previous = this.state;
    this.state = 'stopped';
    const epoch = this.cancel();
    this.closeMicrophone();
    if (previous === 'idle') return;
    try {
      const chunks = await this.request<DeliveredChunk[]>({ operation: 'stop' }, epoch);
      await this.deliver(chunks, epoch);
    } catch (error) {
      // 승인 상실 시 native stop은 tail을 버리고 Stopped로 전환한 뒤 오류를 반환한다.
      if (!(error instanceof Error && error.message.startsWith('engine_authorization_'))) throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    try { await this.stop(); }
    finally {
      await this.request({ operation: 'destroy' });
      this.disposed = true;
      this.callback = undefined;
    }
  }

  async getStatus(): Promise<CaptureStatus> {
    const status = await this.request<NativeStatus>({ operation: 'status' });
    return {
      state: this.state, denoiseEnabled: status.denoise_enabled, vadEnabled: !!this.config.vadEnabled,
      modelsLoaded: [status.denoise_loaded ? (this.config.processing?.sampleRate ?? 16000) === 16000 ? 'fe-s16' : 'fe-s48' : '', status.vad_loaded ? 'silero-vad' : ''].filter(Boolean),
    };
  }

  async setDenoiseEnabled(enabled: boolean): Promise<void> {
    if (this.denoiseUpdates === 0 && enabled === this.denoiseEnabled) return;
    this.denoiseUpdates++;
    const epoch = this.cancel();
    try {
      const applied = await this.request<boolean | undefined>({ operation: 'denoise', enabled }, epoch);
      if (applied !== undefined) this.denoiseEnabled = applied;
    } finally {
      this.denoiseUpdates--;
      if (epoch === this.epoch && this.state === 'running') this.tap?.port.postMessage({ active: true, epoch });
    }
  }

  async reset(): Promise<void> {
    const epoch = this.cancel();
    try { await this.request({ operation: 'reset' }, epoch); }
    finally {
      if (epoch === this.epoch && this.state === 'running') this.tap?.port.postMessage({ active: true, epoch });
    }
  }

  async playback(samples: Float32Array, nativeRate: number): Promise<void> {
    if (this.state !== 'running' || !this.approved()) throw new Error('engine_authorization_required');
    if (!Number.isInteger(nativeRate) || nativeRate < 8000 || nativeRate > 192000 || !samples.length || samples.length > 4 * 1024 * 1024 || samples.some((sample) => !Number.isFinite(sample) || Math.abs(sample) > 1)) {
      throw new Error('tellus_playback_invalid_samples');
    }
    const epoch = this.epoch;
    const cleanup = this.cancelPlayback();
    const playbackEpoch = this.playbackEpoch;
    await cleanup;
    if (epoch !== this.epoch || playbackEpoch !== this.playbackEpoch || this.state !== 'running' || !this.approved()) return;
    const buffer = this.context.createBuffer(1, samples.length, nativeRate);
    buffer.copyToChannel(Float32Array.from(samples), 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    const tap = this.createTap(true);
    tap.port.onmessage = (event: MessageEvent<CaptureFrame>) => {
      if (this.playbackSource !== source || event.data.epoch !== this.epoch || this.state !== 'running') return;
      if (this.renderQueue.length === 10) { this.fail(new Error('tellus_render_queue_overrun')); return; }
      this.renderQueue.push(event.data);
      if (!this.rendering) this.renderIdle = this.pumpRender();
    };
    tap.port.postMessage({ active: true, epoch: this.epoch });
    source.connect(tap);
    tap.connect(this.context.destination);
    this.playbackSource = source;
    this.playbackTap = tap;
    const complete = new Promise<void>((resolve) => {
      this.finishPlayback = resolve;
      source.onended = () => {
        source.disconnect();
        tap.disconnect();
        tap.port.close();
        void this.renderIdle.then(() => {
          if (this.playbackSource !== source) return;
          void this.cancelPlayback().catch((error) => this.fail(error));
        });
      };
    });
    source.start();
    await complete;
  }

  async cancelPlayback(): Promise<void> {
    const active = !!this.playbackSource;
    const epoch = this.epoch;
    this.playbackEpoch++;
    if (this.playbackSource) {
      this.playbackSource.onended = null;
      this.playbackSource.stop();
      this.playbackSource.disconnect();
    }
    this.playbackTap?.port.close();
    this.playbackTap?.disconnect();
    this.playbackSource = undefined;
    this.playbackTap = undefined;
    this.finishPlayback?.();
    this.finishPlayback = undefined;
    this.renderQueue = [];
    const previous = this.playbackCleanup;
    const rendering = this.renderIdle;
    this.playbackCleanup = (async () => {
      await previous;
      await rendering;
      if (active && epoch === this.epoch && this.state === 'running' && this.approved()) {
        await this.request({ operation: 'clearRender' }, epoch);
      }
    })();
    await this.playbackCleanup;
  }

  async playbackEncoded(data: ArrayBuffer): Promise<void> {
    if (this.state !== 'running' || !this.approved()) throw new Error('engine_authorization_required');
    if (!data.byteLength) throw new Error('tellus_playback_empty_audio');
    if (data.byteLength > 16 * 1024 * 1024) throw new Error('tellus_playback_encoded_too_large');
    const epoch = this.epoch;
    const cleanup = this.cancelPlayback();
    const playbackEpoch = this.playbackEpoch;
    await cleanup;
    let buffer = await this.context.decodeAudioData(data.slice(0));
    if (epoch !== this.epoch || playbackEpoch !== this.playbackEpoch) return;
    // OS decoder의 할당은 직접 제한할 수 없지만 추가 mono buffer 할당은 이 경계에서 제한한다.
    if (buffer.length * buffer.numberOfChannels > 4 * 1024 * 1024) throw new Error('tellus_playback_decoded_too_large');
    if (buffer.numberOfChannels !== 1) {
      const mixer = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
      const source = mixer.createBufferSource();
      source.buffer = buffer;
      source.connect(mixer.destination);
      source.start();
      buffer = await mixer.startRendering();
      if (epoch !== this.epoch || playbackEpoch !== this.playbackEpoch) return;
    }
    await this.playback(buffer.getChannelData(0), buffer.sampleRate);
  }

  private createTap(render: boolean): AudioWorkletNode {
    return new AudioWorkletNode(this.context, 'tellus-audio-tap', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1,
      processorOptions: { render, timeOriginMs: Date.now() - this.context.currentTime * 1000 },
    });
  }

  private cancel(): number {
    this.epoch++;
    if (this.sessionId) this.client.cancel(this.sessionId, this.epoch);
    this.queue.clear();
    this.tap?.port.postMessage({ active: false, epoch: this.epoch });
    void this.cancelPlayback().catch((error) => { if (this.state === 'running' && this.approved()) this.fail(error); });
    return this.epoch;
  }

  private closeMicrophone(): void {
    this.tap?.port.close();
    this.tap?.disconnect();
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) {
      track.removeEventListener('ended', this.onDeviceEnded);
      track.stop();
    }
    this.tap = undefined;
    this.source = undefined;
    this.stream = undefined;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    let processingEpoch = this.epoch;
    try {
      for (let pending = this.queue.shift(); pending; pending = this.queue.shift()) {
        const { frame, droppedSamples } = pending;
        if (frame.epoch !== this.epoch || this.state !== 'running') continue;
        processingEpoch = frame.epoch;
        const chunks = await this.request<DeliveredChunk[]>({ operation: 'capture', samples: frame.samples, rate: frame.nativeRate, timestamp: frame.timestamp, droppedSamples }, frame.epoch);
        await this.deliver(chunks, frame.epoch);
      }
    } catch (error) { if (processingEpoch === this.epoch) this.fail(error); }
    finally { this.pumping = false; }
  }

  private async pumpRender(): Promise<void> {
    if (this.rendering) return;
    this.rendering = true;
    let processingEpoch = this.epoch;
    try {
      for (let frame = this.renderQueue.shift(); frame; frame = this.renderQueue.shift()) {
        if (frame.epoch !== this.epoch || this.state !== 'running') continue;
        processingEpoch = frame.epoch;
        await this.request({ operation: 'render', samples: frame.samples, rate: frame.nativeRate }, frame.epoch);
      }
    } catch (error) { if (processingEpoch === this.epoch) this.fail(error); }
    finally { this.rendering = false; }
  }

  private async deliver(chunks: DeliveredChunk[], epoch: number): Promise<void> {
    for (const item of chunks) {
      if (epoch !== this.epoch || !this.approved()) return;
      const valid = await this.request<boolean>({ operation: 'canDeliver', nativeEpoch: item.epoch, authorizationGeneration: item.authorizationGeneration }, epoch);
      if (valid && epoch === this.epoch && this.approved()) this.callback?.(null, item.chunk);
    }
  }

  private approved(): boolean {
    const approval = this.approval;
    return !!approval && Math.max(performance.now() - approval.monotonicStart, Date.now() - approval.wallStart) < approval.remainingMs;
  }

  private fail(value: unknown): void {
    const error = value instanceof Error ? value : new Error('tellus_audio_processing_failed');
    void this.invalidateAuthorization().catch(() => {});
    this.callback?.(error);
  }

  private readonly onDeviceEnded = (): void => this.fail(new Error('tellus_microphone_device_ended'));
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden' && this.approval) this.fail(new Error('engine_authorization_page_hidden'));
  };
}

function authorizationStatus(native: NativeAuthorizationStatus): EngineAuthorizationStatus {
  return {
    state: native.state, remainingMs: native.remaining_ms, expiresAtMs: native.expires_at_ms,
    conversationId: native.conversation_id, connectionId: native.connection_id,
  };
}
