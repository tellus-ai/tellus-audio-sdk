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

/** Native authorization is the final authority; the transport never verifies a permit itself. */
export interface AuthorizableAudioCapture {
  createAuthorizationRequest(conversationId: string): EngineAuthorizationRequest;
  applyAuthorization(token: string): EngineAuthorizationStatus;
  getAuthorizationStatus(): EngineAuthorizationStatus;
  invalidateAuthorization(): void;
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
  getAccessToken: () => string | Promise<string>;
  /** A response must arrive within this timeout; default 10 seconds. */
  requestTimeoutMs?: number;
  onError?: (error: Error) => void;
}

export interface EngineAuthorizationController {
  /** Resolves after the native instance has accepted the initial server permit. */
  ready: Promise<void>;
  /** Stops renewal, invalidates native permission, and stops capture. The caller owns the socket. */
  dispose(): void;
}
