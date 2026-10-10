declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

/** 가변 입력 블록을 복사한다. 프레이밍·리샘플·DSP는 Worker의 Rust가 처리한다. */
class TellusAudioTap extends AudioWorkletProcessor {
  private active = false;
  private epoch = 0;
  private readonly render: boolean;
  private readonly timeOriginMs: number;

  constructor(options: { processorOptions: { render: boolean; timeOriginMs: number } }) {
    super(options);
    this.render = options.processorOptions.render;
    this.timeOriginMs = options.processorOptions.timeOriginMs;
    this.port.onmessage = (event: MessageEvent<{ active: boolean; epoch: number }>) => {
      this.active = event.data.active;
      this.epoch = event.data.epoch;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (this.render && input) {
      for (const channel of outputs[0] ?? []) channel.set(input);
    }
    if (this.active && input?.length) {
      const samples = input.slice();
      this.port.postMessage({ samples, nativeRate: sampleRate, timestamp: Math.floor(this.timeOriginMs + currentTime * 1000), epoch: this.epoch }, [samples.buffer]);
    }
    return true;
  }
}

registerProcessor('tellus-audio-tap', TellusAudioTap as unknown as typeof AudioWorkletProcessor);
export {};
