import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveScreenCaptureExecutable } from '../../../platforms/desktop/electron/runtime/engine-runtime.js';

import { ScreenCaptureClient } from '../../client/screen-capture-client.js';
import type {
  CaptureCapabilities,
  CaptureEvent,
  CaptureResult,
  EncoderSupport,
  RecordingOutput,
  SessionConfig,
  SessionSnapshot,
} from '../../client/types.js';

export { SCREEN_CAPTURE_PROTOCOL_VERSION } from '../../client/screen-capture-client.js';
export type * from '../../client/types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export type ScreenCaptureEvent =
  | CaptureEvent
  /** 클라이언트 전용: 실행 파일이 끝났다. 비정상 종료의 복구 파일은 녹화 루트에서 관리한다. */
  | { type: 'process_exited'; exitCode: number | null; signal: string | null }
  | { type: 'audio_source_error'; error: { code: 'capture_unavailable'; detail: string } };

export interface ScreenCaptureLaunchOptions {
  executablePath?: string;
  /**
   * 녹화 루트. 실행 파일은 이 디렉터리 밖에 쓰지 않는다. 다른 실행의 partial은 보존한다.
   * 앱이 복구·보관 기간을 관리한다. 파일 재생·후처리 조건은 docs/screen-capture-sdk-file-contract.md 참고.
   */
  root: string;
  /** hello와 명령 응답을 기다리는 시간. 기본 30초. */
  timeoutMs?: number;
  /** 실행 파일의 표준 오류 한 줄. 앱 로그로 보낸다. */
  onLog?: (line: string) => void;
}

export interface RecordingAudioSource { port: number; token: string }

/** caller 소유 캡처. 녹화 종료는 이 캡처의 stop을 호출하지 않는다. */
export interface RecordingAudioCapture {
  createRecordingAudioSource(): RecordingAudioSource | Promise<RecordingAudioSource>;
  stopRecordingAudioSource(token: string): void | Promise<void>;
}

export type ScreenCaptureStartConfig = Omit<SessionConfig, 'audioInput'> & { audioCapture?: RecordingAudioCapture };
type Listener = (event: ScreenCaptureEvent) => void;
interface AudioBinding { capture: RecordingAudioCapture; token: string; detaching?: Promise<void>; error?: string }
interface StartIdentity { captureId: string; includeAudio: boolean; capture?: RecordingAudioCapture; ended: boolean; sessionId?: string; earlyTerminalSessions: Set<string>; wire?: SessionConfig }

/** 화면 캡처 실행 파일 하나를 띄우고 표준 입출력 프로토콜로 제어한다. Electron main에서 쓴다. */
export class ScreenCaptureProcess {
  readonly capabilities: CaptureCapabilities;
  readonly #client: ScreenCaptureClient;
  readonly #child: ChildProcess;
  readonly #timeoutMs: number;
  #current: StartIdentity | null = null;
  #starting: { identity: StartIdentity; promise: Promise<CaptureResult<SessionSnapshot>> } | null = null;
  #audio: AudioBinding | null = null;
  #detaching: Promise<void> = Promise.resolve();
  #closing = false;

  readonly #exited: Promise<void>;
  readonly #exitListeners: Set<Listener>;

  private constructor(
    client: ScreenCaptureClient,
    child: ChildProcess,
    exited: Promise<void>,
    exitListeners: Set<Listener>,
    timeoutMs: number,
  ) {
    this.#client = client;
    this.capabilities = client.capabilities;
    this.#child = child;
    this.#exited = exited;
    this.#exitListeners = exitListeners;
    this.#timeoutMs = timeoutMs;
    child.stdin?.on('error', error => client.terminate(`screen capture input failed: ${error.message}`));
    child.once('exit', () => { this.#closing = true; void this.#detachAudio(); });
    exitListeners.add(event => {
      if (event.type === 'process_exited') { this.#closing = true; void this.#detachAudio(); }
    });
    client.onEvent(event => {
      const identity = this.#current;
      if (event.type === 'state' && identity && event.snapshot.captureId === identity.captureId && ['finished', 'failed'].includes(event.snapshot.state.phase)) {
        // start 응답 전 종료는 응답의 sessionId를 확인한 뒤 해당 소스만 정리한다.
        if (identity.sessionId === undefined) identity.earlyTerminalSessions.add(event.snapshot.sessionId);
        else if (event.snapshot.sessionId === identity.sessionId) {
          identity.ended = true;
          void this.#detachAudio();
        }
      }
    });
  }

  /**
   * 실행 파일을 띄우고 hello를 기다린다. 시작하지 못하거나 프로토콜 버전이 다르면 process_unavailable이다.
   * 실행 파일의 단조 시계가 `process.hrtime.bigint()`와 다른 시계여도 실패한다. 게이트 경계가 의미를 잃기 때문이다.
   */
  static async launch(options: ScreenCaptureLaunchOptions): Promise<CaptureResult<ScreenCaptureProcess>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const launchedAt = process.hrtime.bigint();
    let executable: string;
    try { executable = options.executablePath ?? resolveScreenCaptureExecutable(); }
    catch (error) { return { ok: false, error: { code: 'process_unavailable', detail: String(error) } }; }
    const child = spawn(executable, ['--root', options.root], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Windows의 Node는 자식을 부모와 함께 끝나는 Job에 넣는다. 그러면 앱이 강제로 끝날 때 실행 파일도 바로 끝나 진행 중인
      // 마지막 조각을 보존하지 못한다. Job 밖에서 띄우면 입력 닫힘을 받아 복구 파일을 남기고 스스로 끝난다.
      detached: process.platform === 'win32',
    });
    if (options.onLog) {
      const log = options.onLog;
      createInterface({ input: child.stderr! }).on('line', line => log(line));
    } else {
      // 소비하지 않는 stderr는 가득 차면 캡처 스레드의 로그 쓰기를 막는다.
      child.stderr!.resume();
    }
    const exitListeners = new Set<Listener>();
    let markExited: () => void = () => {};
    const exited = new Promise<void>(resolve => { markExited = resolve; });
    let client: ScreenCaptureClient | null = null;
    const connected = await ScreenCaptureClient.connect(handlers => {
      let closed = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null, detail: string) => {
        if (closed) return;
        closed = true;
        clearTimeout(drainTimer);
        handlers.closed(detail);
        markExited();
        for (const listener of exitListeners) listener({ type: 'process_exited', exitCode, signal });
      };
      createInterface({ input: child.stdout! }).on('line', line => { if (!closed) handlers.line(line); });
      child.on('error', error => (client ? client.terminate(error.message) : handlers.closed(error.message)));
      child.on('exit', (exitCode, signal) => {
        // exit 뒤에도 마지막 stdout 줄이 남을 수 있다. 상속된 파이프가 계속 열리는 경우만 시간을 제한한다.
        drainTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(exitCode, signal, 'screen capture output did not close after process exit');
        }, timeoutMs);
      });
      child.on('close', (exitCode, signal) => finish(exitCode, signal,
        `screen capture process exited (code ${exitCode}, signal ${signal})`));
      return { send: line => child.stdin!.write(`${line}\n`), close: () => child.kill() };
    }, {
      timeoutMs,
      checkClock: remote => {
        const receivedAt = process.hrtime.bigint();
        return remote < launchedAt || remote > receivedAt
          ? `screen capture clock ${remote} is outside process.hrtime ${launchedAt}..${receivedAt}`
          : null;
      },
    });
    if (!connected.ok) return connected;
    client = connected.value;
    return { ok: true, value: new ScreenCaptureProcess(client, child, exited, exitListeners, timeoutMs) };
  }

  /** 캡처 API와 H.264 인코더를 확인한다. 세션을 만들지 않는다. */
  prepare(): Promise<CaptureResult<EncoderSupport>> {
    return this.#client.prepare();
  }

  /** native 실행 파일이 DSP 믹스 AAC 녹화를 지원하는지. 구버전 hello에서는 false다. */
  get recordingAudioSupported(): boolean { return this.#client.recordingAudioSupported; }

  /** 세션을 armed로 준비한다. includeAudio를 켜면 caller의 실행 중인 AudioCapture를 연결한다. */
  start(config: ScreenCaptureStartConfig): Promise<CaptureResult<SessionSnapshot>> {
    const audio = config.includeAudio === undefined ? false : config.includeAudio;
    const invalid = (detail: string): Promise<CaptureResult<SessionSnapshot>> => Promise.resolve({ ok: false, error: { code: 'invalid_request', detail } });
    if (typeof audio !== 'boolean' || ('audioInput' in config) || (!audio && config.audioCapture !== undefined)) return invalid('includeAudio and audioCapture must be configured together; audioInput is internal');
    if (this.#closing || !this.#client.running) return invalid('screen capture process is closing');
    if (audio && (!this.recordingAudioSupported || config.output.type !== 'file')) return Promise.resolve({ ok: false, error: { code: 'capture_unavailable', detail: 'screen recording audio is unsupported by this backend' } });
    if (audio && (typeof config.audioCapture?.createRecordingAudioSource !== 'function' || typeof config.audioCapture?.stopRecordingAudioSource !== 'function')) return invalid('includeAudio requires a recording-audio-enabled native AudioCapture');
    const identity: StartIdentity = { captureId: config.captureId, includeAudio: audio, capture: config.audioCapture, ended: false, earlyTerminalSessions: new Set() };
    const current = this.#starting?.identity ?? this.#current;
    if (current && (!current.ended || this.#starting)) {
      if (current.captureId === identity.captureId) {
        if (current.includeAudio !== audio || current.capture !== config.audioCapture) return invalid('captureId already has a different recording audio source or setting');
        if (this.#starting) return this.#starting.promise;
        return this.#client.start(current.wire!);
      }
      if (!current.ended || this.#starting) return Promise.resolve({ ok: false, error: { code: 'session_active', detail: 'a screen recording is already active' } });
    }
    const promise = Promise.resolve().then(() => this.#start(config, identity)).finally(() => { this.#starting = null; });
    this.#starting = { identity, promise };
    return promise;
  }

  async #start(config: ScreenCaptureStartConfig, identity: StartIdentity): Promise<CaptureResult<SessionSnapshot>> {
    await this.#detaching;
    const { audioCapture, ...wire } = config;
    let binding: AudioBinding | null = null;
    try {
      if (identity.includeAudio) {
        const endpoint = await audioCapture!.createRecordingAudioSource();
        if (typeof endpoint?.token === 'string') this.#audio = binding = { capture: audioCapture!, token: endpoint.token };
        if (!Number.isInteger(endpoint?.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== 'string' || endpoint.token.length === 0 || endpoint.token.length > 256) throw new Error('invalid recording audio endpoint');
        Object.assign(wire, { audioInput: { port: endpoint.port, token: endpoint.token } });
      }
      identity.wire = wire;
      this.#current = identity;
      const result = await this.#client.start(wire);
      if (result.ok) {
        identity.sessionId = result.value.sessionId;
        identity.ended = identity.earlyTerminalSessions.has(identity.sessionId) || ['finished', 'failed'].includes(result.value.state.phase);
      } else identity.ended = true;
      identity.earlyTerminalSessions.clear();
      if (identity.ended) await this.#detachAudio(binding);
      return result;
    } catch (error) {
      identity.ended = true;
      await this.#detachAudio(binding);
      return { ok: false, error: { code: 'capture_unavailable', detail: String(error) } };
    }
  }

  async #detachAudio(binding = this.#audio): Promise<void> {
    if (!binding) return this.#detaching;
    if (binding !== this.#audio) return binding.detaching;
    this.#audio = null;
    binding.detaching = Promise.resolve().then(() => binding.capture.stopRecordingAudioSource(binding.token)).catch(error => {
      binding.error = String(error);
      for (const listener of this.#exitListeners) listener({ type: 'audio_source_error', error: { code: 'capture_unavailable', detail: binding.error } });
    });
    this.#detaching = binding.detaching;
    await binding.detaching;
  }

  async #finish<T>(operation: () => Promise<CaptureResult<T>>, ended: boolean): Promise<CaptureResult<T>> {
    await this.#starting?.promise;
    const identity = this.#current;
    const binding = this.#audio;
    const result = await operation();
    const snapshot = this.#client.snapshot();
    const terminal = identity?.ended || (identity?.sessionId !== undefined && snapshot?.sessionId === identity.sessionId && ['finished', 'failed'].includes(snapshot.state.phase));
    if (result.ok || terminal || !this.#client.running) {
      if ((ended || terminal || !this.#client.running) && this.#current === identity && identity) identity.ended = true;
      await this.#detachAudio(binding);
    }
    return binding?.error ? { ok: false, error: { code: 'capture_unavailable', detail: `recording audio cleanup failed: ${binding.error}` } } : result;
  }

  /** 게이트를 연다. boundaryNs는 `process.hrtime.bigint()` 같은 OS 단조 시각이며 생략하면 받은 시각을 쓴다. */
  openGate(boundaryNs?: bigint): Promise<CaptureResult<SessionSnapshot>> {
    return this.#client.openGate(boundaryNs);
  }

  /** 게이트를 닫는다. 닫힌 동안의 화면은 영상 길이에 들어가지 않는다. */
  closeGate(boundaryNs?: bigint): Promise<CaptureResult<SessionSnapshot>> {
    return this.#client.closeGate(boundaryNs);
  }

  /** 캡처를 멈추고 마지막 조각까지 쓴다. */
  seal(): Promise<CaptureResult<SessionSnapshot>> {
    return this.#finish(() => this.#client.seal(), false);
  }

  /** 파일을 게시하고 결과를 돌려준다. 끝난 뒤 다시 부르면 같은 결과다. */
  finalize(): Promise<CaptureResult<RecordingOutput>> {
    return this.#finish(() => this.#client.finalize(), true);
  }

  /** seal과 finalize를 한 번에 한다. */
  stop(): Promise<CaptureResult<RecordingOutput>> {
    return this.#finish(() => this.#client.stop(), true);
  }

  /** 이 실행 파일이 이번 실행에서 게시한 파일과 그 mux 결과(`.with-audio.mp4`)를 지운다. */
  discard(file: string): Promise<CaptureResult<null>> {
    return this.#client.discard(file);
  }

  /** 마지막으로 받은 세션 스냅샷. */
  snapshot(): SessionSnapshot | null {
    return this.#client.snapshot();
  }

  /** 상태·통계·이슈·프로세스 종료 이벤트를 받는다. 반환한 함수로 구독을 끊는다. */
  onEvent(listener: (event: ScreenCaptureEvent) => void): () => void {
    const unsubscribe = this.#client.onEvent(listener);
    this.#exitListeners.add(listener);
    return () => {
      unsubscribe();
      this.#exitListeners.delete(listener);
    };
  }

  /** 진행 중인 세션을 폐기하고 실행 파일을 끝낸다. 시간 안에 끝나지 않으면 강제로 끝낸다. */
  async shutdown(): Promise<void> {
    this.#closing = true;
    await this.#starting?.promise;
    await this.#client.shutdown();
    await this.#detachAudio();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.#child.kill('SIGKILL');
        this.#child.stdin?.destroy();
        this.#child.stdout?.destroy();
        this.#child.stderr?.destroy();
        resolve();
      }, this.#timeoutMs);
      void this.#exited.then(() => { clearTimeout(timer); resolve(); });
    });
  }
}
