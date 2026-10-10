import type { AudioCaptureConfig, BrowserEngineAssets, AudioCapture } from '../../bindings/typescript/capture-types.js';
import { BrowserCapture } from './capture.js';
import { WorkerClient } from './worker-client.js';

export type {
  AudioCapture, AudioCaptureCallback, AudioCaptureConfig, AudioChunk, BrowserEngineAssets,
  CaptureStatus, VADConfig,
} from '../../bindings/typescript/capture-types.js';

/** 같은 AudioContext의 캡처·재생 샘플을 엔진 AEC 시계에 전달한다. */
export class AudioEngine {
  private readonly captures = new Set<AudioCapture>();
  private disposed = false;

  private constructor(private readonly config: AudioCaptureConfig, private readonly context: AudioContext, private readonly client: WorkerClient) {}

  /** 클릭 전에 준비할 수 있다. AudioContext 재개는 start의 사용자 입력 경계에서 수행한다. */
  static async init(config: AudioCaptureConfig, assets: BrowserEngineAssets): Promise<AudioEngine> {
    const base = document.baseURI;
    const resolved: BrowserEngineAssets = {
      ...assets,
      engineModuleUrl: new URL(assets.engineModuleUrl, base).href,
      wasmUrl: new URL(assets.wasmUrl, base).href,
      ortModuleUrl: assets.ortModuleUrl ? new URL(assets.ortModuleUrl, base).href : undefined,
      ortWasmBaseUrl: new URL(assets.ortWasmBaseUrl, base).href,
      encryptedModels: assets.encryptedModels.map((url) => new URL(url, base).href),
    };
    const context = new AudioContext();
    const client = new WorkerClient(new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
    try {
      await Promise.all([
        client.request(0, 0, { operation: 'init', assets: resolved }),
        context.audioWorklet.addModule(new URL('./worklet.js', import.meta.url)),
      ]);
      return new AudioEngine(config, context, client);
    } catch (error) {
      client.dispose();
      await context.close();
      throw error;
    }
  }

  createCapture(): AudioCapture {
    if (this.disposed) throw new Error('tellus_engine_disposed');
    const capture = new BrowserCapture(this.client, this.context, this.config);
    this.captures.add(capture);
    return capture;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try { await Promise.all([...this.captures].map((capture) => capture.dispose())); }
    finally { this.client.dispose(); await this.context.close(); this.captures.clear(); }
  }
}
