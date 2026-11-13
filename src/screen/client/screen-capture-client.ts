import type {
  CaptureCapabilities,
  CaptureError,
  CaptureEvent,
  CaptureResult,
  EncoderSupport,
  RecordingOutput,
  SessionConfig,
  SessionSnapshot,
} from './types.js';

/** 엔진(실행 파일·Wasm·네이티브 모듈)과 맞춰야 하는 제어 프로토콜 버전. */
export const SCREEN_CAPTURE_PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONSENT_TIMEOUT_MS = 120_000;
const MAX_PENDING_REQUESTS = 64;
const MAX_LINE_BYTES = 64 * 1024;

/** 통로가 클라이언트에 알리는 일. 통로를 여는 동안(open 안에서)에는 부르지 않는다. */
export interface TransportHandlers {
  /** 엔진이 보낸 JSON 한 줄(개행 제외). */
  line(text: string): void;
  /** 통로가 끊겼다. 그 뒤에는 줄이 오지 않는다. */
  closed(detail: string): void;
}

/** 엔진과 줄을 주고받는 통로: 실행 파일의 표준 입출력, Worker, 네이티브 모듈. */
export interface ProtocolTransport {
  /** 요청 한 줄(개행 제외)을 보낸다. */
  send(line: string): void;
  /** 통로를 끊고 엔진을 끝낸다. */
  close(): void;
}

export interface ConnectOptions {
  /** hello와 명령 응답을 기다리는 시간. 기본 30초. */
  timeoutMs?: number;
  /** 세션마다 동의 창이 뜨는 플랫폼(consent가 per_session)에서 start 응답을 기다리는 시간. 기본 120초. */
  consentTimeoutMs?: number;
  /** hello의 엔진 단조 시각(ns)이 클라이언트 시계와 같은 시계인지 본다. 다르면 이유를, 같으면 null을 돌려준다. */
  checkClock?: (remoteNs: bigint) => string | null;
}

type Outcome =
  | { status: 'ok'; snapshot?: SessionSnapshot; output?: RecordingOutput; encoder?: EncoderSupport }
  | { status: 'error'; error: CaptureError; snapshot?: SessionSnapshot };

type OkOutcome = Extract<Outcome, { status: 'ok' }>;

interface Command {
  type: string;
  [field: string]: unknown;
}

interface PendingRequest {
  resolve(outcome: Outcome): void;
  timer: ReturnType<typeof setTimeout>;
}

/** 클라이언트 전용 오류: 엔진을 쓸 수 없다. */
export function unavailable(detail: string): CaptureError {
  return { code: 'process_unavailable', detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 응답 결과가 status와 그에 맞는 필드를 갖췄는지 본다. 스냅샷 내부는 엔진이 만든 값을 믿는다.
function isOutcome(value: unknown): value is Outcome {
  if (!isRecord(value)) return false;
  if (value.status === 'ok') return true;
  return value.status === 'error' && isRecord(value.error) && typeof value.error.code === 'string';
}

// hello 줄에서 플랫폼 능력을 읽는다. 형식·프로토콜 버전·시계가 맞지 않으면 이유를 돌려준다.
function readHello(text: string, checkClock: ConnectOptions['checkClock']): { capabilities: CaptureCapabilities; audioRecording: boolean; audioRecordingPauseKeepalive: boolean } | string {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch (error) {
    return `invalid protocol message: ${(error as Error).message}`;
  }
  const hello = isRecord(message) && isRecord(message.hello) ? message.hello : null;
  if (!hello || !isRecord(hello.capabilities)) return 'invalid protocol message: expected hello';
  if (hello.protocolVersion !== SCREEN_CAPTURE_PROTOCOL_VERSION) {
    return `unsupported screen capture protocol version ${String(hello.protocolVersion)}`;
  }
  if (checkClock) {
    const remote = typeof hello.monotonicNow === 'string' && /^\d+$/.test(hello.monotonicNow)
      ? BigInt(hello.monotonicNow)
      : null;
    const mismatch = remote === null
      ? `screen capture clock ${String(hello.monotonicNow)} is not a decimal ns string`
      : checkClock(remote);
    if (mismatch) return mismatch;
  }
  return { capabilities: hello.capabilities as unknown as CaptureCapabilities, audioRecording: hello.audioRecording === true, audioRecordingPauseKeepalive: hello.audioRecordingPauseKeepalive === true };
}

// Rust u64는 JSON number이므로 안전한 정수 범위를 넘으면 시간을 잘못 해석하지 않고 거부한다.
function validAudioMetadata(audio: RecordingOutput['audio']): boolean {
  return !!audio && audio.codec === 'aac_lc' && audio.sampleRate === 48000 && audio.channels === 1 &&
    [audio.samples, audio.gaps, audio.paddingSamples, audio.queueHighWaterSamples].every(value => Number.isSafeInteger(value) && value >= 0);
}

/** 통로 하나로 엔진의 세션 호스트를 제어하는 프로토콜 클라이언트. 플랫폼 클라이언트가 통로를 만들어 쓴다. */
export class ScreenCaptureClient {
  readonly capabilities: CaptureCapabilities;
  readonly recordingAudioSupported: boolean;
  readonly recordingAudioPauseKeepaliveSupported: boolean;
  readonly #transport: ProtocolTransport;
  readonly #timeoutMs: number;
  readonly #consentTimeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<(event: CaptureEvent) => void>();
  #snapshot: SessionSnapshot | null = null;
  #running = true;
  #nextId = 0;
  #shutdown: Promise<Outcome> | null = null;

  private constructor(transport: ProtocolTransport, capabilities: CaptureCapabilities, options: ConnectOptions, audioRecording: boolean, audioRecordingPauseKeepalive: boolean) {
    this.#transport = transport;
    this.capabilities = capabilities;
    this.recordingAudioSupported = audioRecording && ['macos', 'windows'].includes(capabilities.platform);
    this.recordingAudioPauseKeepaliveSupported = this.recordingAudioSupported && audioRecordingPauseKeepalive;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#consentTimeoutMs = options.consentTimeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS;
  }

  /** 통로를 열고 hello를 기다린다. 시간 안에 오지 않거나 형식·버전·시계가 맞지 않으면 통로를 끊고 process_unavailable이다. */
  static connect(
    open: (handlers: TransportHandlers) => ProtocolTransport,
    options: ConnectOptions = {},
  ): Promise<CaptureResult<ScreenCaptureClient>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise(resolve => {
      let client: ScreenCaptureClient | null = null;
      let settled = false;
      const fail = (detail: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        transport.close();
        resolve({ ok: false, error: unavailable(detail) });
      };
      const timer = setTimeout(() => fail(`screen capture hello timed out after ${timeoutMs} ms`), timeoutMs);
      const transport = open({
        line: text => {
          if (client) return client.#receive(text);
          if (settled) return;
          const hello = readHello(text, options.checkClock);
          if (typeof hello === 'string') return fail(hello);
          settled = true;
          clearTimeout(timer);
          client = new ScreenCaptureClient(transport, hello.capabilities, options, hello.audioRecording, hello.audioRecordingPauseKeepalive);
          resolve({ ok: true, value: client });
        },
        closed: detail => (client ? client.#closed(detail) : fail(detail)),
      });
    });
  }

  /** 통로가 살아 있는지. 끊긴 뒤의 요청은 process_unavailable이다. */
  get running(): boolean {
    return this.#running;
  }

  /** 캡처 API와 H.264 인코더를 확인한다. 세션을 만들지 않는다. */
  prepare(): Promise<CaptureResult<EncoderSupport>> {
    return this.#call({ type: 'prepare' }, outcome => outcome.encoder);
  }

  /** 세션을 만들고 캡처·인코더를 준비한다. 게이트는 닫힌 채로 armed가 된다. */
  start(config: SessionConfig): Promise<CaptureResult<SessionSnapshot>> {
    if (config.includeAudio && (!this.recordingAudioSupported || config.output.type !== 'file')) {
      return Promise.resolve({ ok: false, error: { code: 'capture_unavailable', detail: 'screen recording audio is unsupported by this backend' } });
    }
    const timeoutMs = this.capabilities.consent === 'per_session' ? this.#consentTimeoutMs : this.#timeoutMs;
    return this.#call({ type: 'start', config }, outcome => outcome.snapshot, timeoutMs);
  }

  /** 게이트를 연다. boundaryNs는 엔진과 같은 단조 시계의 시각이며 생략하면 엔진이 받은 시각을 쓴다. */
  openGate(boundaryNs?: bigint): Promise<CaptureResult<SessionSnapshot>> {
    return this.#call({ type: 'open_gate', boundary: boundaryNs?.toString() ?? null }, outcome => outcome.snapshot);
  }

  /** 게이트를 닫는다. 닫힌 동안의 화면은 영상 길이에 들어가지 않는다. */
  closeGate(boundaryNs?: bigint): Promise<CaptureResult<SessionSnapshot>> {
    return this.#call({ type: 'close_gate', boundary: boundaryNs?.toString() ?? null }, outcome => outcome.snapshot);
  }

  /** 캡처를 멈추고 마지막 조각까지 쓴다. */
  seal(): Promise<CaptureResult<SessionSnapshot>> {
    return this.#call({ type: 'seal' }, outcome => outcome.snapshot);
  }

  /** 녹화를 게시하고 결과를 돌려준다. 끝난 뒤 다시 부르면 같은 결과다. */
  finalize(): Promise<CaptureResult<RecordingOutput>> {
    return this.#call({ type: 'finalize' }, outcome => outcome.output);
  }

  /** seal과 finalize를 한 번에 한다. */
  stop(): Promise<CaptureResult<RecordingOutput>> {
    return this.#call({ type: 'stop' }, outcome => outcome.output);
  }

  /** 엔진이 이번 실행에서 게시한 파일과 그 mux 결과(`.with-audio.mp4`)를 지운다. 파일 출력에서만 쓴다. */
  discard(file: string): Promise<CaptureResult<null>> {
    return this.#call({ type: 'discard', file }, () => null);
  }

  /** 진행 중인 세션을 폐기하라고 엔진에 알린다. 통로를 끊지는 않는다. */
  async shutdown(): Promise<void> {
    if (this.#running && !this.#shutdown) this.#shutdown = this.#request({ type: 'shutdown' }, this.#timeoutMs);
    await this.#shutdown;
  }

  /** 마지막으로 받은 세션 스냅샷. */
  snapshot(): SessionSnapshot | null {
    return this.#snapshot;
  }

  /** 상태·통계·이슈 이벤트를 받는다. 반환한 함수로 구독을 끊는다. */
  onEvent(listener: (event: CaptureEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 기다리는 요청을 이 이유로 실패시키고 통로를 끊는다. 통로가 끊김을 바로 알려도 이유는 바뀌지 않는다. */
  terminate(detail: string): void {
    if (!this.#running) return;
    this.#running = false;
    this.#failPending(detail);
    this.#transport.close();
  }

  async #call<T>(
    command: Command,
    pick: (outcome: OkOutcome) => T | undefined,
    timeoutMs = this.#timeoutMs,
  ): Promise<CaptureResult<T>> {
    const outcome = await this.#request(command, timeoutMs);
    if (outcome.status === 'error') return { ok: false, error: outcome.error };
    const value = pick(outcome);
    if (value !== undefined) return { ok: true, value };
    const detail = `invalid protocol message: ${command.type} response is missing its result`;
    this.terminate(detail);
    return { ok: false, error: unavailable(detail) };
  }

  #request(command: Command, timeoutMs: number): Promise<Outcome> {
    if (!this.#running) {
      return Promise.resolve({ status: 'error', error: unavailable('screen capture engine is not running') });
    }
    if (this.#shutdown && command.type !== 'shutdown') {
      return Promise.resolve({ status: 'error', error: unavailable('screen capture engine is shutting down') });
    }
    if (command.type !== 'shutdown' && this.#pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.resolve({ status: 'error', error: {
        code: 'request_queue_full', detail: `screen capture has ${MAX_PENDING_REQUESTS} pending requests`,
      } });
    }
    const id = String(++this.#nextId);
    const line = JSON.stringify({ id, command });
    if (new TextEncoder().encode(line).byteLength > MAX_LINE_BYTES) {
      return Promise.resolve({ status: 'error', error: {
        code: 'invalid_request', detail: `screen capture request exceeds ${MAX_LINE_BYTES} bytes`,
      } });
    }
    return new Promise(resolve => {
      const timer = setTimeout(
        () => this.terminate(`screen capture ${command.type} timed out after ${timeoutMs} ms`),
        timeoutMs,
      );
      this.#pending.set(id, { resolve, timer });
      this.#transport.send(line);
    });
  }

  #receive(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch (error) {
      return this.terminate(`invalid protocol message: ${(error as Error).message}`);
    }
    if (isRecord(message) && isRecord(message.response)) {
      const { id, result } = message.response;
      const pending = typeof id === 'string' ? this.#pending.get(id) : undefined;
      if (!pending || !isOutcome(result)) return this.terminate('invalid protocol message: unexpected response');
      const output = result.status === 'ok' ? result.output : undefined;
      const finished = result.snapshot?.state.phase === 'finished' ? result.snapshot.state.output : undefined;
      for (const recording of [output, finished]) {
        if (recording && recording.audio !== undefined && !validAudioMetadata(recording.audio)) {
          return this.terminate('invalid protocol message: unsafe recording audio metadata');
        }
      }
      clearTimeout(pending.timer);
      this.#pending.delete(id as string);
      if (result.snapshot) this.#snapshot = result.snapshot;
      return pending.resolve(result);
    }
    if (isRecord(message) && isRecord(message.event) && ['state', 'stats', 'issue'].includes(message.event.type as string)) {
      const event = message.event as unknown as CaptureEvent;
      if (event.type === 'state') {
        if (event.snapshot.state.phase === 'finished' && event.snapshot.state.output.audio !== undefined && !validAudioMetadata(event.snapshot.state.output.audio)) {
          return this.terminate('invalid protocol message: unsafe recording audio metadata');
        }
        this.#snapshot = event.snapshot;
      }
      for (const listener of this.#listeners) listener(event);
      return;
    }
    this.terminate('invalid protocol message: unknown message');
  }

  // 엔진 쪽에서 통로가 끊겼다. 기다리는 요청을 실패시킨다.
  #closed(detail: string): void {
    this.#running = false;
    this.#failPending(detail);
  }

  #failPending(detail: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ status: 'error', error: unavailable(detail) });
    }
    this.#pending.clear();
  }
}
