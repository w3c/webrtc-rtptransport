// Backend Factory
//
// Single switch point for selecting the media backend. The unified app calls
// `createBackend(resolveBackendKind())` and codes only against MediaBackend /
// RTCPeerConnectionLike thereafter.

import type { BackendKind, MediaBackend } from './types';
import { NativeBackend } from './native-backend';
import { ProxyBackend } from './proxy-backend';

export type { BackendKind, MediaBackend, RTCPeerConnectionLike } from './types';
export { NativeBackend } from './native-backend';
export { ProxyBackend } from './proxy-backend';
export { RtcPeerConnectionShim } from './rtc-peer-connection-shim';

/** Instantiate the backend for the given kind. */
export function createBackend(kind: BackendKind): MediaBackend {
  switch (kind) {
    case 'native':
      return new NativeBackend();
    case 'proxy':
      return new ProxyBackend();
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown backend kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Resolve the backend kind from the URL query string (`?backend=native|proxy`).
 * Defaults to 'proxy' (WebRTC Proxy over RtcTransport).
 */
export function resolveBackendKind(
    search: string = typeof location !== 'undefined' ? location.search : ''): BackendKind {
  const params = new URLSearchParams(search);
  const value = (params.get('backend') || '').toLowerCase();
  return value === 'native' ? 'native' : 'proxy';
}
