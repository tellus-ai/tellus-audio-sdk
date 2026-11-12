// 화면 캡처 제어 프로토콜의 값. 엔진(screen-core·screen-host)의 JSON 모양과 같다.

export type CaptureErrorCode =
  | 'permission_denied'
  /** 웹 선택 창이나 iOS 허용 창에서 사용자가 거부했다. */
  | 'consent_denied'
  | 'source_not_found'
  | 'source_ended'
  /** 사용자가 브라우저의 공유 중지로 끝냈다. */
  | 'stopped_by_user'
  /** OS가 캡처를 끝냈다(iOS). */
  | 'stopped_by_system'
  | 'capture_unavailable'
  | 'encoder_unavailable'
  | 'encoder_failed'
  | 'output_failed'
  | 'session_active'
  | 'invalid_state'
  | 'invalid_request'
  /** 클라이언트 전용: 대기 요청 64개를 넘었다. 이 요청은 보내지 않았으며 다른 요청이 끝난 뒤 다시 보낼 수 있다. */
  | 'request_queue_full'
  /** 클라이언트 전용: 엔진(실행 파일·Worker·네이티브 모듈)을 시작하지 못했거나 연결이 끊겼거나 응답이 늦었다. 다시 연결해야 한다. */
  | 'process_unavailable';

/** code로 분기하고 detail은 로그에만 쓴다. 사용자 문구는 앱이 code로 만든다. */
export interface CaptureError {
  code: CaptureErrorCode;
  detail: string;
  /** 실패 전 기록한 partial의 경로. 마지막 조각은 불완전할 수 있다. */
  recoveryFile?: string;
}

export type CaptureResult<T> = { ok: true; value: T } | { ok: false; error: CaptureError };

/** display: 디스플레이(데스크톱)·선택한 화면(웹)·기기 전체 화면(모바일), application: 앱 자신의 화면(모바일), window·tab: 웹에서 고른 창·탭. */
export type SourceKind = 'display' | 'application' | 'window' | 'tab';

export interface CaptureCapabilities {
  platform: 'windows' | 'macos' | 'ios' | 'android' | 'web';
  /** programmatic: 앱이 소스를 정한다. system_picker: 사용자가 브라우저 선택 창에서 고른다. */
  selection: 'programmatic' | 'system_picker';
  /** per_session: 세션마다 선택 창(웹)이나 허용 창(iOS, Android 기기 전체 화면)이 뜬다. 소스에 따라 다르면 가장 강한 방식이다. */
  consent: 'not_required' | 'system_permission' | 'per_session';
  sourceKinds: SourceKind[];
}

export interface EncoderSupport {
  kind: 'hardware' | 'software' | 'unavailable';
  qualityMode: boolean;
}

export interface PixelSize {
  width: number;
  height: number;
}

/**
 * display_at: 그 지점의 디스플레이(데스크톱). Windows는 물리 픽셀(`screen.dipToScreenPoint` 결과), macOS는 좌상단 원점의 전역 point다.
 * current_application: 앱 자신의 화면(모바일). system_picker: start 전에 사용자가 선택 창에서 고른 소스(웹).
 * device_screen: 기기 화면 전체(모바일). 다른 앱과 홈 화면도 찍히며 start에서 시스템 허용 창이 뜬다.
 */
export type SourceRequest =
  | { type: 'display_at'; point: { x: number; y: number } }
  | { type: 'current_application' }
  | { type: 'system_picker' }
  | { type: 'device_screen' };

/** file: 녹화 루트 아래 파일(데스크톱·모바일). label은 영문 소문자·숫자·`-` 1~32자. fragments: fMP4 조각을 차례로 받는다(웹). */
export type OutputTarget = { type: 'file'; label: string } | { type: 'fragments' };

export interface SessionConfig {
  /** 상담 conversation ID 같은 호출자 상관관계 ID(1~200자). 같은 ID로 다시 start하면 진행 중인 세션을 돌려준다. */
  captureId: string;
  source: SourceRequest;
  output: OutputTarget;
  captureCursor: boolean;
  /** 기본 false. desktop file 녹화에서 처리된 microphone/system mix를 AAC로 보관한다. */
  includeAudio?: boolean;
  /** 내부 native endpoint. 고수준 API에서는 audioCapture를 전달한다. */
  audioInput?: { port: number; token: string };
}

export type RateControl =
  /** Windows 녹화용 고정 QP(0~51). 비트레이트 상한 없음. */
  | { mode: 'constant_qp'; qp: number }
  /** 녹화용 품질 목표. 비트레이트 상한 없음. */
  | { mode: 'constant_quality'; quality: number }
  | { mode: 'quality'; quality: number; maxBitrateBps: number }
  | { mode: 'average_vbr'; bitrateBps: number };

export interface EncodingProfile {
  codec: 'h264';
  size: PixelSize;
  frameRate: number;
  rateControl: RateControl;
  keyframeIntervalMs: number;
}

export interface ResolvedSource {
  kind: SourceKind;
  nativeSize: PixelSize;
  scaleFactor: number;
  rotation: 'deg0' | 'deg90' | 'deg180' | 'deg270';
}

export interface CaptureStats {
  captured: number;
  /** 새 화면 부재·짧은 처리 지연을 마지막 인코딩 화면으로 채운 프레임 수. */
  repeated: number;
  dropped: number;
  encoded: number;
  bytesWritten: number;
}

/** 단조 시각은 ns 10진수 문자열이다. JavaScript 숫자는 2^53 ns를 넘으면 정밀도를 잃는다. */
export interface ClockAnchor {
  monotonic: string;
  unixMs: number;
}

export interface GateInterval {
  closedAt: string;
  openedAt: string;
}

export interface RecordingAudioMetadata {
  codec: 'aac_lc';
  sampleRate: 48000;
  channels: 1;
  samples: number;
  gaps: number;
  paddingSamples: number;
  queueHighWaterSamples: number;
}

export interface RecordingOutput {
  /**
   * 네이티브 녹화의 절대 경로. 기록한 프레임이 없으면 null이다. 웹 조각 출력은 항상 null이다.
   * 긴 Windows 경로는 Chromium file:// 재생에 실패할 수 있다. 앱에서 파일 스트림으로 제공해야 한다.
   * 후처리로 새 파일을 만들면 원본의 비공개 ACL이 복제되지 않는다. 쓰기 전에 비공개 출력을 준비한다.
   */
  file: string | null;
  mediaDurationUs: number;
  firstFrame: ClockAnchor | null;
  pauses: GateInterval[];
  stats: CaptureStats;
  /** 소스 소멸·공유 중지처럼 더 이어갈 수 없는 사건으로 끝났으면 그 원인이다. 녹화는 그 순간까지 게시한다. */
  interruption: CaptureError | null;
  audio?: RecordingAudioMetadata;
}

/** 녹화는 이어지지만 앱이 알아야 하는 일. */
export type CaptureIssue =
  /** 소스 모드가 바뀌거나 화면이 대체됐다. macOS는 내장 우선(없으면 주 화면), Windows는 주 화면으로 대체하며 출력 크기·비율을 유지한다. */
  | { type: 'source_changed'; source: ResolvedSource }
  /** Windows: UAC 창·잠금·모드 변경으로 끊긴 화면 복제를 다시 만들어 같은 디스플레이를 이어 녹화한다. */
  | { type: 'access_lost_recovered' };

export type SessionState =
  | { phase: 'arming' | 'armed' | 'recording' | 'paused' | 'sealed' }
  | { phase: 'finished'; output: RecordingOutput }
  | { phase: 'failed'; error: CaptureError };

export interface SessionSnapshot {
  sessionId: string;
  captureId: string;
  state: SessionState;
  source: ResolvedSource | null;
  profile: EncodingProfile | null;
}

/** 엔진이 요청과 관계없이 알리는 일. */
export type CaptureEvent =
  | { type: 'state'; snapshot: SessionSnapshot }
  | { type: 'stats'; sessionId: string; stats: CaptureStats }
  | { type: 'issue'; sessionId: string; issue: CaptureIssue };
