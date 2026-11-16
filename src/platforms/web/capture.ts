import type {
  AudioCapture, AudioCaptureCallback, AudioCaptureConfig, CaptureStatus,
} from '../../bindings/typescript/capture-types.js';
import type { EngineAuthorizationRequest, EngineAuthorizationStatus } from '../../bindings/typescript/authorization/contracts.js';
import type { AudioDeviceStatus } from '../../bindings/typescript/audio-devices.js';
import { validateGainDb } from '../../bindings/typescript/audio-gain.js';
import { CaptureQueue, type CaptureFrame } from './capture-queue.js';
import { audioDeviceError } from './devices.js';
import { validateCloseTalkHoldMs, validateCloseTalkKeepGapDb, validateCloseTalkLearnedLevelDbfs, validateCloseTalkLevelMarginDb, validateCloseTalkLevelMinDbfs, validateCloseTalkThresholdDb, validateDenoiseAttenuationLimitDb, validateGeneralDenoiseAttenuationLimitDb, type DeliveredChunk, type WorkerCommand, type WorkerStatus } from './protocol.js';
import { WorkerClient } from './worker-client.js';

interface NativeAuthorizationStatus {
  state: EngineAuthorizationStatus['state'];
  remaining_ms: number;
  expires_at_ms?: number;
  conversation_id?: string;
  connection_id?: string;
}

type DenoiseSetting = 'closeTalkThresholdDb' | 'denoiseAttenuationLimitDb' | 'closeTalkHoldMs' | 'closeTalkKeepGapDb' | 'closeTalkLevelMarginDb' | 'closeTalkLevelMinDbfs' | 'closeTalkLearnedLevelDbfs' | 'generalDenoiseAttenuationLimitDb';
/** The order in which start sends them to native after the session is created. */
const DENOISE_SETTINGS: DenoiseSetting[] = ['closeTalkThresholdDb', 'denoiseAttenuationLimitDb', 'closeTalkHoldMs', 'closeTalkKeepGapDb', 'closeTalkLevelMarginDb', 'closeTalkLevelMinDbfs', 'closeTalkLearnedLevelDbfs', 'generalDenoiseAttenuationLimitDb'];

/** Manages main-thread lifecycle and OS routing. Rust produces the processed samples. */
/** Validates the value with the same rules as core and builds the worker command. Invalid values are rejected before reaching the worker. */
function denoiseSettingCommand(setting: DenoiseSetting, value: number | null): WorkerCommand {
  switch (setting) {
    case 'closeTalkThresholdDb': return { operation: setting, db: validateCloseTalkThresholdDb(value as number) };
    case 'denoiseAttenuationLimitDb': return { operation: setting, db: validateDenoiseAttenuationLimitDb(value as number) };
    case 'closeTalkHoldMs': return { operation: setting, ms: validateCloseTalkHoldMs(value as number) };
    case 'closeTalkKeepGapDb': return { operation: setting, db: validateCloseTalkKeepGapDb(value as number) };
    case 'closeTalkLevelMarginDb': return { operation: setting, db: validateCloseTalkLevelMarginDb(value as number) };
    case 'closeTalkLevelMinDbfs': return { operation: setting, dbfs: validateCloseTalkLevelMinDbfs(value as number) };
    case 'closeTalkLearnedLevelDbfs': return { operation: setting, dbfs: validateCloseTalkLearnedLevelDbfs(value) };
    case 'generalDenoiseAttenuationLimitDb': return { operation: setting, db: validateGeneralDenoiseAttenuationLimitDb(value) };
  }
}

export class BrowserCapture implements AudioCapture {
  private readonly ready: Promise<number>;
  private sessionId = 0;
  private epoch = 0;
  private state: CaptureStatus['state'] = 'idle';
  private disposed = false;
  private denoiseEnabled: boolean;
  private denoiseUpdates = 0;
  // The input hold state the wrapper wants. holdInput and releaseInput change it synchronously before sending, so a later release sees a hold that has not finished yet at call time.
  private inputHeld = false;
  private inputHoldChanges = 0;
  // The engine's hold state after the last successful hold or release. When the newest hold or release fails, the desired state reverts to this value.
  private confirmedInputHeld = false;
  // The capture generation the microphone tap stamps on frames. A held release re-arms the tap with a new generation, and frames of an earlier generation are held captures and are dropped. A new tap starts at 0.
  private captureGeneration = 0;
  // Configured denoise settings stay here until they reach native, and start applies them once. A runtime change replaces them, and native keeps the values across stop and start.
  // Only a successful start application or runtime change clears them, so failed changes never drop the configured value, even when they overlap.
  private readonly unappliedDenoiseSettings: Partial<Record<DenoiseSetting, number | null>>;
  private readonly denoiseSettingChanges = new Set<Promise<void>>();
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
  private deviceStatus: AudioDeviceStatus;

  constructor(private readonly client: WorkerClient, private readonly context: AudioContext, private readonly config: AudioCaptureConfig, private readonly playbackDeviceStatus?: AudioDeviceStatus) {
    this.queue = new CaptureQueue(config.processing?.sampleRate ?? 16000);
    this.deviceStatus = { source: 'microphone', code: 'pending', ...(config.micDeviceId === undefined ? {} : { requestedDeviceId: config.micDeviceId }) };
    this.denoiseEnabled = !!config.denoiseEnabled;
    this.unappliedDenoiseSettings = { closeTalkThresholdDb: config.closeTalkThresholdDb, denoiseAttenuationLimitDb: config.denoiseAttenuationLimitDb,
      closeTalkHoldMs: config.closeTalkHoldMs, closeTalkKeepGapDb: config.closeTalkKeepGapDb, closeTalkLevelMarginDb: config.closeTalkLevelMarginDb,
      // -20 is the engine default, so there is nothing to send.
      closeTalkLevelMinDbfs: config.closeTalkLevelMinDbfs === -20 ? undefined : config.closeTalkLevelMinDbfs,
      // null means no injection (the default), so there is nothing to send.
      closeTalkLearnedLevelDbfs: config.closeTalkLearnedLevelDbfs ?? undefined,
      // null means unlimited (the default), so there is nothing to send.
      generalDenoiseAttenuationLimitDb: config.generalDenoiseAttenuationLimitDb ?? undefined };
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
    const requestedDeviceId = this.config.micDeviceId;
    this.deviceStatus = { source: 'microphone', code: 'pending', ...(requestedDeviceId === undefined ? {} : { requestedDeviceId }) };
    const resumed = this.context.resume();
    void resumed.catch(() => {});
    try {
      if (requestedDeviceId !== undefined && (typeof requestedDeviceId !== 'string' || !requestedDeviceId.trim())) throw audioDeviceError(new Error('tellus_microphone_invalid_device_id'), 'microphone', typeof requestedDeviceId === 'string' ? requestedDeviceId : undefined);
      for (const setting of DENOISE_SETTINGS) {
        // Sends only what is still unapplied once in-flight runtime changes settle, so a configured value never lands after a newer runtime value.
        while (this.denoiseSettingChanges.size) await Promise.allSettled(this.denoiseSettingChanges);
        const value = this.unappliedDenoiseSettings[setting];
        if (value !== undefined) await this.setDenoiseSetting(setting, value, epoch);
      }
      await this.request({ operation: 'start' }, epoch);
      if (epoch !== this.epoch) return;
      if (!navigator.mediaDevices?.getUserMedia) throw audioDeviceError(new DOMException('tellus_microphone_requires_secure_context', 'NotSupportedError'), 'microphone', requestedDeviceId);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        ...(requestedDeviceId === undefined ? {} : { deviceId: { exact: requestedDeviceId } }),
      } }).catch((error) => { throw audioDeviceError(error, 'microphone', requestedDeviceId); });
      if (epoch !== this.epoch) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      await resumed;
      if (epoch !== this.epoch) { stream.getTracks().forEach((track) => track.stop()); return; }
      const settings = stream.getAudioTracks()[0]?.getSettings();
      const actualDeviceId = settings?.deviceId;
      if (requestedDeviceId !== undefined && actualDeviceId !== requestedDeviceId) {
        throw Object.assign(new Error('tellus_microphone_route_mismatch'), { deviceStatus: {
          source: 'microphone', code: 'route_mismatch', requestedDeviceId, ...(actualDeviceId === undefined ? {} : { actualDeviceId }),
        } satisfies AudioDeviceStatus });
      }
      this.source = this.context.createMediaStreamSource(stream);
      this.captureGeneration = 0;
      this.tap = this.createTap(false);
      this.tap.port.onmessage = (event: MessageEvent<CaptureFrame>) => {
        if (this.state !== 'running' || event.data.epoch !== this.epoch || event.data.generation !== this.captureGeneration) return;
        this.queue.push(event.data);
        void this.pump();
      };
      this.state = 'running';
      this.tap.port.postMessage({ active: true, epoch });
      this.source.connect(this.tap);
      this.tap.connect(this.context.destination);
      for (const track of stream.getTracks()) track.addEventListener('ended', this.onDeviceEnded);
      // Without a track rate, uses the AudioContext rate the node actually delivers. If the rates differ, the browser resamples between them.
      const nativeSampleRateHz = settings?.sampleRate ?? this.context.sampleRate;
      this.deviceStatus = { source: 'microphone', code: 'ready', ...(requestedDeviceId === undefined ? {} : { requestedDeviceId }), ...(actualDeviceId === undefined ? {} : { actualDeviceId }), nativeSampleRateHz };
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (error instanceof Error && 'deviceStatus' in error) this.deviceStatus = error.deviceStatus as AudioDeviceStatus;
      await this.stop();
      throw error;
    }
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
    if (!this.tap || !this.stream?.getTracks().some((track) => track.readyState === 'live')) {
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
      // When authorization is lost, native stop discards the tail, moves to Stopped, and returns an error.
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
    const status = await this.request<WorkerStatus>({ operation: 'status' });
    return {
      state: this.state, denoiseEnabled: status.denoise_enabled, denoiseMode: status.denoise_mode,
      denoiseLoadFailed: status.denoise_load_failed, vadEnabled: !!this.config.vadEnabled,
      ...(typeof status.input_held === 'boolean' ? { inputHeld: status.input_held } : {}),
      closeTalkThresholdDb: status.close_talk_threshold_db ?? undefined, denoiseAttenuationLimitDb: status.denoise_attenuation_limit_db ?? undefined,
      closeTalkHoldMs: status.close_talk_hold_ms ?? undefined, closeTalkKeepGapDb: status.close_talk_keep_gap_db ?? undefined,
      closeTalkLevelMarginDb: status.close_talk_level_margin_db ?? undefined,
      closeTalkLevelMinDbfs: status.close_talk_level_min_dbfs ?? undefined,
      ...(status.general_denoise_attenuation_limit_db === undefined ? {} : { generalDenoiseAttenuationLimitDb: status.general_denoise_attenuation_limit_db }),
      ...(status.close_talk_learned_level_dbfs === undefined ? {} : { closeTalkLearnedLevelDbfs: status.close_talk_learned_level_dbfs }),
      ...(typeof status.close_talk_level_learned === 'boolean' ? { closeTalkLevelLearned: status.close_talk_level_learned } : {}),
      deviceStatus: [this.deviceStatus, ...(this.playbackDeviceStatus ? [this.playbackDeviceStatus] : [])],
      modelsLoaded: status.loadedModels,
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

  /** Requests the hold in order. It does not cut the epoch, so in-flight capture still reaches the engine, which counts its length while held. */
  async holdInput(): Promise<void> {
    const change = ++this.inputHoldChanges;
    this.inputHeld = true;
    try {
      await this.request<void>({ operation: 'holdInput' });
      this.confirmedInputHeld = true;
    } catch (error) {
      // Revert only when no newer hold or release exists, to the state after the last successful hold or release. If overlapping holds all fail, it returns to not held.
      if (change === this.inputHoldChanges) this.inputHeld = this.confirmedInputHeld;
      throw error;
    }
  }

  /**
   * Reads the desired hold state (including an in-flight hold) at call time and sends the request right away, so hold and release reach the worker in call order.
   * It neither cuts the epoch nor stops engine playback, so earlier settings (setMicGainDb and the like) and an in-flight start, pause, stop or playback finish as they were.
   * While held and with a running tap (the only time held captures queue on the main thread or are on their way over the port), it sets only a capture boundary.
   * - Queued held captures are sent to the worker before the release request. The core, still held, counts their length and the queue loss length (droppedSamples) and drops them.
   *   Resulting chunks are not delivered (held captures are never emitted live after the release). If pause, reset, stop or a denoise toggle is called in the same tick,
   *   that call cuts the epoch before the worker receives this capture, so it is dropped without being counted, like the other pending audio that call discards.
   * - The tap is re-armed with a new capture generation. Frames the tap stamped before it received this (the frame on its way over the port at release and the frames it made before it got the message)
   *   are dropped even if they arrive after the release. This length is not reported to the engine, so the input_held discontinuity after the release is that much shorter. Its size is
   *   the number of render quanta (128 samples each, about 2.7 ms at 48 kHz) during one port round trip, typically a few ms, and can grow by however long the main thread was busy just before the release. Handing the queue loss length to the released core would become a full discard, so it is not counted.
   * - A capture the pump already sent reaches the worker before the release, and the held core drops it.
   * Otherwise (not held, not started, during the permission prompt, during pause or stop) it only sends the ordered request.
   */
  async releaseInput(): Promise<void> {
    if (this.disposed) throw new Error('tellus_capture_disposed');
    const held = this.inputHeld;
    const change = ++this.inputHoldChanges;
    this.inputHeld = false;
    if (held && this.state === 'running' && this.tap !== undefined) {
      this.tap.port.postMessage({ active: true, epoch: this.epoch, generation: ++this.captureGeneration });
      const epoch = this.epoch;
      for (let pending = this.queue.shift(); pending; pending = this.queue.shift()) {
        const { frame, droppedSamples } = pending;
        void this.request<DeliveredChunk[]>({ operation: 'capture', samples: frame.samples, rate: frame.nativeRate, timestamp: frame.timestamp, droppedSamples }, frame.epoch)
          .catch((error) => { if (epoch === this.epoch) this.fail(error); });
      }
      // The fractional remainder of the queue loss length also belongs to the hold span, so it is not carried past the release.
      this.queue.clear();
    }
    try {
      await this.request({ operation: 'releaseInput' });
      this.confirmedInputHeld = false;
    } catch (error) {
      if (change === this.inputHoldChanges) this.inputHeld = this.confirmedInputHeld;
      throw error;
    }
  }

  async setMicGainDb(db: number): Promise<void> {
    validateGainDb(db);
    await this.request({ operation: 'micGainDb', db });
  }

  async setSpeakerGainDb(db: number): Promise<void> {
    validateGainDb(db);
    throw new Error('tellus_speaker_gain_unsupported');
  }

  setCloseTalkThresholdDb(db: number): Promise<void> {
    return this.setDenoiseSetting('closeTalkThresholdDb', db);
  }

  setDenoiseAttenuationLimitDb(db: number): Promise<void> {
    return this.setDenoiseSetting('denoiseAttenuationLimitDb', db);
  }

  setCloseTalkHoldMs(ms: number): Promise<void> {
    return this.setDenoiseSetting('closeTalkHoldMs', ms);
  }

  setCloseTalkKeepGapDb(db: number): Promise<void> {
    return this.setDenoiseSetting('closeTalkKeepGapDb', db);
  }

  setCloseTalkLevelMarginDb(db: number): Promise<void> {
    return this.setDenoiseSetting('closeTalkLevelMarginDb', db);
  }

  setCloseTalkLevelMinDbfs(dbfs: number): Promise<void> {
    return this.setDenoiseSetting('closeTalkLevelMinDbfs', dbfs);
  }

  /** null clears both the injected learned level and the gate's own learned value. Apps that switch the input device call it with null. */
  setGeneralDenoiseAttenuationLimitDb(db: number | null): Promise<void> {
    return this.setDenoiseSetting('generalDenoiseAttenuationLimitDb', db);
  }

  setCloseTalkLearnedLevelDbfs(dbfs: number | null): Promise<void> {
    return this.setDenoiseSetting('closeTalkLearnedLevelDbfs', dbfs);
  }

  private async setDenoiseSetting(setting: DenoiseSetting, value: number | null, epoch = this.epoch): Promise<void> {
    const command = denoiseSettingCommand(setting, value);
    const change = this.request(command, epoch).then(() => { this.unappliedDenoiseSettings[setting] = undefined; });
    this.denoiseSettingChanges.add(change);
    try { await change; }
    finally { this.denoiseSettingChanges.delete(change); }
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
    // The OS decoder's allocation cannot be limited directly, but the extra mono buffer allocation is limited at this boundary.
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

  private readonly onDeviceEnded = (): void => {
    const error = audioDeviceError(new Error('tellus_microphone_device_ended'), 'microphone', this.config.micDeviceId);
    this.deviceStatus = error.deviceStatus;
    this.fail(error);
  };
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
