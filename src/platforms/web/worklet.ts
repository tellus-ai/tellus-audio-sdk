declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

/** Copies variable input blocks. Framing, resampling, and DSP are handled by Rust in the Worker. */
class TellusAudioTap extends AudioWorkletProcessor {
  private active = false;
  private epoch = 0;
  // The capture generation the main thread raises on a held release. A control message without a generation leaves it unchanged.
  private generation = 0;
  private readonly render: boolean;
  private readonly timeOriginMs: number;

  constructor(options: { processorOptions: { render: boolean; timeOriginMs: number } }) {
    super(options);
    this.render = options.processorOptions.render;
    this.timeOriginMs = options.processorOptions.timeOriginMs;
    this.port.onmessage = (event: MessageEvent<{ active: boolean; epoch: number; generation?: number }>) => {
      this.active = event.data.active;
      this.epoch = event.data.epoch;
      if (event.data.generation !== undefined) this.generation = event.data.generation;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (this.render && input) {
      for (const channel of outputs[0] ?? []) channel.set(input);
    }
    if (this.active && input?.length) {
      const samples = input.slice();
      this.port.postMessage({ samples, nativeRate: sampleRate, timestamp: Math.floor(this.timeOriginMs + currentTime * 1000), epoch: this.epoch, generation: this.generation }, [samples.buffer]);
    }
    return true;
  }
}

registerProcessor('tellus-audio-tap', TellusAudioTap as unknown as typeof AudioWorkletProcessor);
export {};
