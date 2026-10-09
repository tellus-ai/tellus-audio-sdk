import type { WorkerCommand, WorkerResponse } from './protocol.js';

/** 요청과 응답을 연결한다. Asyncify 호출 직렬화는 Worker가 관리한다. */
export class WorkerClient {
  private nextId = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private failure: Error | undefined;

  constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error));
      else pending.resolve(response.result);
    };
    worker.onerror = () => this.fail(new Error('tellus_worker_failed'));
    worker.onmessageerror = () => this.fail(new Error('tellus_worker_message_invalid'));
  }

  request<T>(sessionId: number, epoch: number, command: WorkerCommand): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        const transfer = 'samples' in command ? [command.samples.buffer] : [];
        this.worker.postMessage({ id, sessionId, epoch, command }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('tellus_worker_post_failed'));
      }
    });
  }

  cancel(sessionId: number, epoch: number): void {
    if (!this.failure) this.worker.postMessage({ cancel: sessionId, epoch });
  }

  dispose(): void {
    this.fail(new Error('tellus_engine_disposed'));
    this.worker.terminate();
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
