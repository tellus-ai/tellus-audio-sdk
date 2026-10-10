/** 동기 desktop과 비동기 native/web 호출이 공유하는 반환 형식이다. */
export type MaybePromise<T> = T | Promise<T>;

/** A fresh challenge generated inside a native capture instance. */
export interface EngineAuthorizationRequest {
  nativeInstanceId: string;
  nonce: string;
  sequence: number;
}

export interface EngineAuthorizationStatus {
  state: 'unapproved' | 'authorized' | 'expired';
  remainingMs: number;
  expiresAtMs?: number | null;
  conversationId?: string | null;
  connectionId?: string | null;
}

export interface EngineModelKeyRequest {
  modelId: string;
  keyId: string;
  publicKey: string;
}

export interface EngineModelKey {
  modelId: string;
  keyId: string;
  /** 80바이트 HPKE wrapped key의 padding 없는 base64url 표현이다. */
  wrappedKey: string;
}

/** Native authorization is the final authority; the transport never verifies a permit itself. */
export interface AuthorizableAudioCapture {
  createAuthorizationRequest(conversationId: string): MaybePromise<EngineAuthorizationRequest>;
  applyAuthorization(token: string): MaybePromise<EngineAuthorizationStatus>;
  getAuthorizationStatus(): MaybePromise<EngineAuthorizationStatus>;
  invalidateAuthorization(): MaybePromise<void>;
  createModelKeyRequests?(): MaybePromise<EngineModelKeyRequest[]>;
  applyModelKeys?(keys: EngineModelKey[]): MaybePromise<void>;
}

export interface EngineAuthorizationSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

export interface EngineAuthorizationOptions {
  conversationId: string;
  /** Obtain current login credentials again for each renewal. Keep partner secrets on your backend. */
  getAccessToken: () => MaybePromise<string>;
  /** 요청과 native 승인 적용의 제한 시간이다. 기본값은 10초다. */
  requestTimeoutMs?: number;
  onError?: (error: Error) => void;
}

export interface EngineAuthorizationController {
  /** 최초 permit과 요청한 모든 모델 키를 native가 적용한 뒤 완료한다. */
  ready: Promise<void>;
  /** Stops renewal, invalidates native permission, and stops capture. The caller owns the socket. */
  dispose(): void;
}
