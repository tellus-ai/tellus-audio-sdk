import type { AudioCaptureConfig, BrowserEngineAssets, AudioCapture } from '../../bindings/typescript/capture-types.js';
import type { AudioDeviceStatus } from '../../bindings/typescript/audio-devices.js';
import { BrowserCapture } from './capture.js';
import { audioDeviceError } from './devices.js';
import { denoiseMode, outputSampleRate } from './protocol.js';
import { WorkerClient } from './worker-client.js';

export type {
  AudioCapture, AudioCaptureCallback, AudioCaptureConfig, AudioChunk, BrowserEngineAssets,
  CaptureStatus, VADConfig,
} from '../../bindings/typescript/capture-types.js';
export type {
  AudioDeviceInfo, AudioDeviceListResult, AudioDeviceOperationError, AudioDeviceSource, AudioDeviceStatus,
} from '../../bindings/typescript/audio-devices.js';
export { listAudioDevices } from './devices.js';

/** 같은 AudioContext의 캡처·재생 샘플을 엔진 AEC 시계에 전달한다. */
export class AudioEngine {
  private readonly captures = new Set<AudioCapture>();
  private disposed = false;

  private constructor(private readonly config: AudioCaptureConfig, private readonly context: AudioContext, private readonly client: WorkerClient, private readonly playbackDeviceStatus?: AudioDeviceStatus) {}

  /** 클릭 전에 준비할 수 있다. AudioContext 재개는 start의 사용자 입력 경계에서 수행한다. */
  static async init(config: AudioCaptureConfig, assets: BrowserEngineAssets): Promise<AudioEngine> {
    // 잘못된 출력 설정은 AudioContext·Worker를 만들기 전에 거부한다.
    outputSampleRate(config);
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
      denoiseMode(config);
      if (config.micDeviceId !== undefined && (typeof config.micDeviceId !== 'string' || !config.micDeviceId.trim())) {
        throw audioDeviceError(new Error('tellus_microphone_invalid_device_id'), 'microphone', typeof config.micDeviceId === 'string' ? config.micDeviceId : undefined);
      }
      if (config.systemAudioDeviceId !== undefined) throw audioDeviceError(new DOMException('tellus_browser_system_audio_unsupported', 'NotSupportedError'), 'system_audio', config.systemAudioDeviceId);
      if (config.iosOutputRoute !== undefined) throw audioDeviceError(new DOMException('tellus_browser_ios_route_unsupported', 'NotSupportedError'), 'playback');
      let playbackDeviceStatus: AudioDeviceStatus | undefined;
      const requestedDeviceId = config.playbackDeviceId;
      if (requestedDeviceId !== undefined) {
        if (typeof requestedDeviceId !== 'string' || !requestedDeviceId.trim()) throw audioDeviceError(new Error('tellus_playback_invalid_device_id'), 'playback', typeof requestedDeviceId === 'string' ? requestedDeviceId : undefined);
        const output = context as AudioContext & { setSinkId?: (id: string) => Promise<void>; readonly sinkId?: string };
        if (typeof output.setSinkId !== 'function') throw audioDeviceError(new DOMException('tellus_playback_device_selection_unsupported', 'NotSupportedError'), 'playback', requestedDeviceId);
        await output.setSinkId(requestedDeviceId).catch((error) => { throw audioDeviceError(error, 'playback', requestedDeviceId); });
        playbackDeviceStatus = { source: 'playback', code: 'ready', requestedDeviceId, actualDeviceId: output.sinkId };
        if (output.sinkId !== requestedDeviceId) throw Object.assign(new Error('tellus_playback_route_mismatch'), { deviceStatus: { ...playbackDeviceStatus, code: 'route_mismatch' } satisfies AudioDeviceStatus });
      }
      await Promise.all([
        client.request(0, 0, { operation: 'init', assets: resolved }),
        context.audioWorklet.addModule(new URL('./worklet.js', import.meta.url)),
      ]);
      return new AudioEngine(config, context, client, playbackDeviceStatus);
    } catch (error) {
      client.dispose();
      await context.close();
      throw error;
    }
  }

  createCapture(): AudioCapture {
    if (this.disposed) throw new Error('tellus_engine_disposed');
    const capture = new BrowserCapture(this.client, this.context, this.config, this.playbackDeviceStatus);
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
