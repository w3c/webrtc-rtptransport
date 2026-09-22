// Native Backend
//
// Delegates directly to the browser's built-in WebRTC + Media Capture APIs.
// A real `RTCPeerConnection` structurally satisfies `RTCPeerConnectionLike`,
// so no wrapping is required — this backend is the conformance oracle that the
// proxy backend is measured against.

import type { BackendKind, CallPreferences, MediaBackend, RTCPeerConnectionLike } from './types';

export class NativeBackend implements MediaBackend {
  readonly kind: BackendKind = 'native';
  readonly label = 'Native WebRTC';

  isAvailable(): boolean {
    return typeof RTCPeerConnection !== 'undefined' &&
        typeof navigator !== 'undefined' &&
        !!navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function';
  }

  unavailableReason(): string | null {
    if (this.isAvailable()) return null;
    return 'RTCPeerConnection or navigator.mediaDevices.getUserMedia is not available in this browser.';
  }

  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  createPeerConnection(config?: RTCConfiguration, _prefs?: CallPreferences): RTCPeerConnectionLike {
    // A real RTCPeerConnection implements the full standard surface, which is a
    // superset of RTCPeerConnectionLike. Codec preferences are applied by the
    // app via the standard setCodecPreferences after tracks are added; CC is
    // browser-managed, so `_prefs` is unused here.
    return new RTCPeerConnection(config) as unknown as RTCPeerConnectionLike;
  }
}
