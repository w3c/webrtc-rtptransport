// Proxy Backend
//
// Produces RtcPeerConnectionShim instances backed by the RtcTransport RTP/RTCP
// engine. Media capture still uses the standard getUserMedia (the proxy only
// replaces the peer connection / transport path, not camera/mic acquisition).

import type { BackendKind, CallPreferences, MediaBackend, RTCPeerConnectionLike } from './types';
import { RtcPeerConnectionShim } from './rtc-peer-connection-shim';

export class ProxyBackend implements MediaBackend {
  readonly kind: BackendKind = 'proxy';
  readonly label = 'WebRTC Proxy over RtcTransport';

  isAvailable(): boolean {
    // Media capture is required; the RtcTransport API is required for the
    // engine transport (checked lazily when a call actually starts).
    return typeof navigator !== 'undefined' &&
        !!navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function';
  }

  unavailableReason(): string | null {
    if (this.isAvailable()) return null;
    return 'navigator.mediaDevices.getUserMedia is not available in this browser.';
  }

  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  createPeerConnection(config?: RTCConfiguration, prefs?: CallPreferences): RTCPeerConnectionLike {
    return new RtcPeerConnectionShim(config, prefs);
  }
}
