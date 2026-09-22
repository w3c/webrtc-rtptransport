// Backend Seam Types
//
// Defines the minimal, W3C-standard-shaped surface that the unified app codes
// against. Two backends implement it interchangeably:
//   - NativeBackend  → real window.RTCPeerConnection + navigator.mediaDevices
//   - ProxyBackend   → RtcPeerConnectionShim over the RtcTransport RTP/RTCP engine
//
// The app must ONLY use standard types across this seam (MediaStreamTrack,
// RTCSessionDescriptionInit, RTCIceCandidateInit, RTCStatsReport). Engine types
// (RtpSession, Pacer, packetizers, ...) must never leak through here.

export type BackendKind = 'native' | 'proxy';

/**
 * User-selected media preferences applied to a call. Passed to
 * `createPeerConnection`. These are plain primitives (not engine types), so they
 * do not violate the seam. Backends honor what they can:
 *   - native → codec preference via standard setCodecPreferences (applied by the
 *     app); CC is browser-managed.
 *   - proxy  → codec preference orders the shim's supported lists; ccAlgorithm
 *     selects the rate controller driving the video encoder.
 * Resolution is applied by the app via getUserMedia constraints on both.
 */
export interface CallPreferences {
  /** Preferred video codec name: 'vp8' | 'vp9' | 'h264' | 'hevc' | 'av1'. */
  videoCodec: string;
  /** Preferred audio codec name: 'opus' | 'pcmu' | 'pcma'. */
  audioCodec: string;
  /** Congestion control algorithm (proxy backend): 'aimd' | 'gcc'. */
  ccAlgorithm: 'aimd' | 'gcc';
}

/**
 * The subset of the W3C `RTCPeerConnection` interface the unified app relies on.
 *
 * A real `RTCPeerConnection` structurally satisfies this interface, so the
 * native backend needs no wrapper. The proxy backend provides a class that
 * implements it (`RtcPeerConnectionShim`).
 */
export interface RTCPeerConnectionLike extends EventTarget {
  // --- Media ---
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender;
  getSenders(): RTCRtpSender[];
  getReceivers(): RTCRtpReceiver[];

  // --- Signaling / negotiation (JSEP) ---
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void>;

  // --- Stats & lifecycle ---
  getStats(selector?: MediaStreamTrack | null): Promise<RTCStatsReport>;
  close(): void;

  // --- Optional: standard codec preferences (native backend only) ---
  // A real RTCPeerConnection exposes getTransceivers(); the proxy shim orders
  // codecs internally from CallPreferences and omits this.
  getTransceivers?(): RTCRtpTransceiver[];

  // --- State ---
  readonly localDescription: RTCSessionDescription | null;
  readonly remoteDescription: RTCSessionDescription | null;
  readonly signalingState: RTCSignalingState;
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;

  // --- Events (handler properties) ---
  onicecandidate: ((this: RTCPeerConnectionLike, ev: RTCPeerConnectionIceEvent) => void) | null;
  ontrack: ((this: RTCPeerConnectionLike, ev: RTCTrackEvent) => void) | null;
  onconnectionstatechange: ((this: RTCPeerConnectionLike, ev: Event) => void) | null;
  oniceconnectionstatechange: ((this: RTCPeerConnectionLike, ev: Event) => void) | null;
  onnegotiationneeded: ((this: RTCPeerConnectionLike, ev: Event) => void) | null;
}

/**
 * A media backend produces peer connections and media streams that share the
 * same standard surface, regardless of the underlying transport.
 */
export interface MediaBackend {
  /** Stable machine-readable identifier. */
  readonly kind: BackendKind;
  /** Human-readable label for UI. */
  readonly label: string;

  /** Whether this backend can run in the current browser/environment. */
  isAvailable(): boolean;
  /** Reason string when `isAvailable()` is false (for UX), else null. */
  unavailableReason(): string | null;

  /** Acquire local media (camera/mic). */
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** Create a peer connection bound to this backend. */
  createPeerConnection(config?: RTCConfiguration, prefs?: CallPreferences): RTCPeerConnectionLike;
}
