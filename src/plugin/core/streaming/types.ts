export interface SignedThinking {
  text: string;
  signature: string;
}

export interface SignatureStore {
  get(sessionKey: string): SignedThinking | undefined;
  set(sessionKey: string, value: SignedThinking): void;
  has(sessionKey: string): boolean;
  delete(sessionKey: string): void;
}

export interface StreamingCallbacks {
  onCacheSignature?: (sessionKey: string, text: string, signature: string) => void;
  onInjectDebug?: (response: unknown, debugText: string) => unknown;
  onInjectSyntheticThinking?: (response: unknown) => unknown;
  transformThinkingParts?: (parts: unknown) => unknown;
}

export interface StreamingOptions {
  signatureSessionKey?: string;
  debugText?: string;
  cacheSignatures?: boolean;
  displayedThinkingHashes?: Set<string>;
  /** When true, injects synthetic thinking placeholder for keep_thinking multi-turn support */
  injectSyntheticThinking?: boolean;
}

export interface ThoughtBuffer {
  get(index: number): string | undefined;
  set(index: number, text: string): void;
  clear(): void;
}
