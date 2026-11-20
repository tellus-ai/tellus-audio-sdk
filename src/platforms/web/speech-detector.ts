import type { SpeechDetectionEvent } from '../../bindings/typescript/speech-detection.js';
import { audioDeviceError } from './devices.js';
import { registerDetector, SPEECH_DETECTION_PREEMPTED, trackDetectorInput, unregisterDetector } from './microphone-priority.js';
import type { BrowserSpeechDetectorAssets, SpeechDetectionCommand, SpeechDetectionResponse } from './speech-detection-protocol.js';

/** A running detector reports one terminal error when it loses input, is preempted, or fails. */
export type SpeechDetectionCallback = (error: Error | null, event?: SpeechDetectionEvent) => void;

/**
 * Reports speech state from microphone input without a capture permit.
 * Uses a dedicated Worker, engine instance, and AudioContext.
 */
export class SpeechDetector {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(events: SpeechDetectionEvent[]): void; reject(error: Error): void }>();
  private failure: Error | undefined;
  private disposed = false;
  // Use the run ID to discard microphone frames and worker results from previous starts.
  private run = 0;
  private running = false;
  private interruptStart?: (error: Error) => void;
  private callback?: SpeechDetectionCallback;
  private deviceId?: string;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private tap?: AudioWorkletNode;

  private constructor(private readonly worker: Worker, private readonly context: AudioContext) {
    worker.onmessage = (event: MessageEvent<SpeechDetectionResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error));
      else pending.resolve(response.events ?? []);
    };
    worker.onerror = () => this.onWorkerFailure(new Error('tellus_worker_failed'));
    worker.onmessageerror = () => this.onWorkerFailure(new Error('tellus_worker_message_invalid'));
  }

  /** Prepares the engine and plaintext Silero model before user interaction. Start opens the microphone. */
  static async init(assets: BrowserSpeechDetectorAssets): Promise<SpeechDetector> {
    const base = document.baseURI;
    const resolved: BrowserSpeechDetectorAssets = {
      engineModuleUrl: new URL(assets.engineModuleUrl, base).href,
      wasmUrl: new URL(assets.wasmUrl, base).href,
      ortModuleUrl: assets.ortModuleUrl ? new URL(assets.ortModuleUrl, base).href : undefined,
      ortWasmBaseUrl: new URL(assets.ortWasmBaseUrl, base).href,
      speechDetectionModelUrl: new URL(assets.speechDetectionModelUrl, base).href,
    };
    const context = new AudioContext();
    const detector = new SpeechDetector(new Worker(new URL('./speech-detection-worker.js', import.meta.url), { type: 'module' }), context);
    try {
      await Promise.all([
        detector.request({ operation: 'init', assets: resolved }),
        context.audioWorklet.addModule(new URL('./worklet.js', import.meta.url)),
      ]);
      return detector;
    } catch (error) {
      await detector.dispose();
      throw error;
    }
  }

  /**
   * Opens the default microphone or the requested device. Call from a user gesture to resume the AudioContext.
   * Rejects with a deviceStatus error if the microphone cannot open or with speech_detection_already_running for a duplicate start.
   * Rejects with speech_detection_preempted_by_capture if capture has priority or takes it before start completes.
   */
  async start(callback: SpeechDetectionCallback, deviceId?: string): Promise<void> {
    if (this.disposed) throw new Error('tellus_speech_detector_disposed');
    if (this.running) throw new Error('speech_detection_already_running');
    if (deviceId !== undefined && (typeof deviceId !== 'string' || !deviceId.trim())) throw audioDeviceError(new Error('tellus_microphone_invalid_device_id'), 'microphone', typeof deviceId === 'string' ? deviceId : undefined);
    if (this.failure) throw this.failure;
    registerDetector(this.preempt);
    this.running = true;
    const run = ++this.run;
    this.callback = callback;
    this.deviceId = deviceId;
    const interrupted = new Promise<never>((_resolve, reject) => { this.interruptStart = reject; });
    try {
      await Promise.race([this.openMicrophone(run, deviceId), interrupted]);
    } finally {
      if (run === this.run) this.interruptStart = undefined;
    }
  }

  private async openMicrophone(run: number, deviceId?: string): Promise<void> {
    try {
      const resumed = this.context.resume();
      void resumed.catch(() => {});
      await this.request({ operation: 'start' });
      if (run !== this.run) return;
      if (!navigator.mediaDevices?.getUserMedia) throw audioDeviceError(new DOMException('tellus_microphone_requires_secure_context', 'NotSupportedError'), 'microphone', deviceId);
      const stream = await trackDetectorInput(navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        ...(deviceId === undefined ? {} : { deviceId: { exact: deviceId } }),
      } }).then((stream) => {
        if (run !== this.run) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        this.stream = stream;
        return stream;
      }, (error) => { throw audioDeviceError(error, 'microphone', deviceId); }));
      if (!stream || run !== this.run) return;
      await resumed;
      if (run !== this.run) return;
      this.source = this.context.createMediaStreamSource(stream);
      // Use the capture worklet to forward microphone input only.
      this.tap = new AudioWorkletNode(this.context, 'tellus-audio-tap', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1,
        processorOptions: { render: false, timeOriginMs: 0 },
      });
      this.tap.port.onmessage = (event: MessageEvent<{ samples: Float32Array; nativeRate: number }>) => {
        if (run === this.run) this.push(run, event.data.samples, event.data.nativeRate);
      };
      this.tap.port.postMessage({ active: true, epoch: run });
      this.source.connect(this.tap);
      this.tap.connect(this.context.destination);
      for (const track of stream.getTracks()) track.addEventListener('ended', this.onDeviceEnded);
    } catch (error) {
      if (run !== this.run) return;
      await this.stop().catch(() => {});
      throw error;
    }
  }

  /** Stops detection and closes microphone tracks when active. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.run++;
    this.callback = undefined;
    this.interruptStart = undefined;
    try {
      for (const track of this.stream?.getTracks() ?? []) {
        track.removeEventListener('ended', this.onDeviceEnded);
        track.stop();
      }
      this.tap?.port.close();
      this.tap?.disconnect();
      this.source?.disconnect();
    } finally {
      this.tap = undefined;
      this.source = undefined;
      this.stream = undefined;
      unregisterDetector(this.preempt);
    }
    await this.request({ operation: 'stop' });
  }

  /** Stops detection and closes the Worker and AudioContext. Later starts reject with tellus_speech_detector_disposed. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try { await this.stop(); }
    finally {
      this.reject(new Error('tellus_speech_detector_disposed'));
      this.worker.terminate();
      await this.context.close();
    }
  }

  private request(command: SpeechDetectionCommand): Promise<SpeechDetectionEvent[]> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, command }, command.operation === 'push' ? [command.samples.buffer] : []);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('tellus_worker_post_failed'));
      }
    });
  }

  // Responses arrive in request order. Forward only the two public event fields.
  private push(run: number, samples: Float32Array, rate: number): void {
    this.request({ operation: 'push', samples, rate }).then((events) => {
      for (const event of events) if (run === this.run) this.callback?.(null, { speaking: event.speaking, timestampMs: event.timestampMs });
    }, (error) => { if (run === this.run) this.fail(error); });
  }

  private readonly preempt = (): (() => void) | undefined => this.end(new Error(SPEECH_DETECTION_PREEMPTED));

  private fail(error: Error): void {
    this.end(error)?.();
  }

  private end(error: Error): (() => void) | undefined {
    const notify = this.interruptStart ?? this.callback;
    void this.stop().catch(() => {});
    if (!notify) return;
    return () => {
      try { notify(error); }
      catch (callbackError) { console.error('Speech detection callback failed', callbackError); }
    };
  }

  private onWorkerFailure(error: Error): void {
    if (this.failure) return;
    this.reject(error);
    this.fail(error);
  }

  private reject(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private readonly onDeviceEnded = (): void => {
    this.fail(audioDeviceError(new Error('tellus_microphone_device_ended'), 'microphone', this.deviceId));
  };
}
