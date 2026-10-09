export interface CaptureFrame {
  samples: Float32Array;
  nativeRate: number;
  timestamp: number;
  epoch: number;
}

/** 입력 큐의 누락 길이는 다음 프레임 전에 처리 레이트 샘플 단위로 보고한다. */
export class CaptureQueue {
  private frames: CaptureFrame[] = [];
  private droppedSamples = 0;
  private remainder = 0;
  private remainderRate = 0;

  constructor(private readonly sampleRate: number, private readonly capacity = 10) {}

  push(frame: CaptureFrame): void {
    if (this.frames.length === this.capacity) {
      const lost = this.frames.shift()!;
      if (this.remainderRate !== lost.nativeRate) this.remainder = 0;
      this.remainderRate = lost.nativeRate;
      const mapped = lost.samples.length * this.sampleRate + this.remainder;
      const whole = Math.floor(mapped / lost.nativeRate);
      this.droppedSamples += whole;
      this.remainder = mapped % lost.nativeRate;
    }
    this.frames.push(frame);
  }

  shift(): { frame: CaptureFrame; droppedSamples: number } | undefined {
    const frame = this.frames.shift();
    if (!frame) return undefined;
    const droppedSamples = this.droppedSamples;
    this.droppedSamples = 0;
    return { frame, droppedSamples };
  }

  clear(): void {
    this.frames = [];
    this.droppedSamples = 0;
    this.remainder = 0;
    this.remainderRate = 0;
  }
}
