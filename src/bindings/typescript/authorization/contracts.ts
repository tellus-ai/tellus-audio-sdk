/** Return shape shared by synchronous desktop and asynchronous native/web calls. */
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
  /** Unpadded base64url form of the 80-byte HPKE wrapped key. */
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
  /** Timeout for the request and for applying authorization to native. Defaults to 10 seconds. */
  requestTimeoutMs?: number;
  onError?: (error: Error) => void;
}

export interface EngineAuthorizationController {
  /** Completes after native has applied the first permit and every requested model key. */
  ready: Promise<void>;
  /** Stops renewal, invalidates native permission, and stops capture. The caller owns the socket. */
  dispose(): void;
}
