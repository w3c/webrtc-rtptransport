// Full RtcTransport W3C API Type Declarations
// Based on: https://w3c.github.io/webrtc-rtptransport/
// and https://github.com/w3c/webrtc-rtptransport/blob/main/api-outline.md
//
// This file declares the FULL spec API surface. The current Chromium
// implementation supports a subset — unsupported members are marked with
// @experimental tags. The app uses these types via the adapter layer.

// ─── Wire Format ────────────────────────────────────────────────────────────

/** Supported wire protocol formats for encryption. */
type RtcTransportFormat = 'DTLS/V0' | 'dtls' | 'dtls-srtp';

/** ICE controller strategy. */
type RtcNetworkRouteControllerType = 'automaticIceController' | 'manualIceController';

// ─── Configuration ──────────────────────────────────────────────────────────

interface RtcTransportConfig {
  /** Human-readable name for debugging/devtools. */
  name?: string;
  /** ICE servers for STUN/TURN. */
  iceServers?: RTCIceServer[];
  /** Whether this peer controls ICE nomination (offerer = true). */
  iceControlling?: boolean;
  /** Wire protocol: 'dtls-srtp' (RTP/RTCP aware) or 'dtls' (raw). */
  wireProtocol?: RtcTransportFormat;
  /** @experimental Network route controller type. */
  transportControllerType?: RtcNetworkRouteControllerType;
  /** @experimental Certificates for DTLS. If omitted, auto-generated. */
  certificates?: RTCCertificate[];
}

// ─── ICE ────────────────────────────────────────────────────────────────────

type IceCandidateType = 'host' | 'srflx' | 'prflx' | 'relay';

interface RtcTransportIceCandidate {
  address: string;
  port: number;
  type: IceCandidateType | string;
  usernameFragment: string;
  password: string;
  /** @experimental Network cost hint (0 = cheapest). */
  networkCost?: number;
}

interface RtcTransportICECandidateInit {
  address: string;
  port: number;
  type: IceCandidateType | string;
  usernameFragment: string;
  password: string;
}

interface RtcTransportIceCandidateEvent {
  candidate: RtcTransportIceCandidate;
}

// ─── DTLS / Encryption ──────────────────────────────────────────────────────

type RtcTransportSslRole = 'client' | 'server';

interface RtcTransportDtlsParameters {
  sslRole: RtcTransportSslRole | string;
  fingerprintDigestAlgorithm: string;
  fingerprint: ArrayBuffer;
}

// ─── Packet Send ────────────────────────────────────────────────────────────

interface RtcSendPacketParameters {
  /** Monotonically increasing ID for correlating with sent info. */
  id: number;
  /** Payload data (RTP/RTCP in dtls-srtp mode, raw in dtls mode). */
  data: Uint8Array;
  /**
   * @experimental Scheduled send time (DOMHighResTimeStamp).
   * The browser sends the packet at this time for precise pacing.
   * If omitted, the packet is sent immediately.
   */
  sendTime?: DOMHighResTimeStamp;
}

// ─── Packet Receive ─────────────────────────────────────────────────────────

interface RtcReceivedPacket {
  /** Size of the received payload in bytes. */
  payloadByteLength: number;
  /** Receive timestamp (DOMHighResTimeStamp). */
  receiveTime: number;
  /** Copy the payload into the provided buffer. */
  copyPayloadTo(buffer: Uint8Array): void;
  /** @experimental ECN marking of the received packet. */
  ecnMarking?: 'not-ect' | 'ect0' | 'ect1' | 'ce';
  /**
   * @experimental The network route this packet was received on.
   * Useful for multihoming scenarios.
   */
  networkRoute?: RtcNetworkRoute;
}

// ─── Send Outcome / Feedback ────────────────────────────────────────────────

interface RtcPacketSentInfo {
  /** Correlates to RtcSendPacketParameters.id */
  id: number;
  /** Actual send time on the network (DOMHighResTimeStamp). */
  sendTime: DOMHighResTimeStamp;
  /** Actual bytes sent on the wire (including SRTP overhead). */
  bytesSent: number;
  /** Whether the send was successful. */
  success: boolean;
}

// ─── Network Route (experimental) ──────────────────────────────────────────

/** @experimental A selected ICE candidate pair. */
interface RtcNetworkRoute {
  localCandidate: RtcTransportIceCandidate;
  remoteCandidate: RtcTransportIceCandidate;
}

// ─── Transport Status ───────────────────────────────────────────────────────

/** @experimental Transport status for circuit-breaker events. */
interface RtcTransportStatusEvent {
  /** Whether the transport is enabled (false = circuit breaker triggered). */
  enabled: boolean;
}

// ─── Main Transport Class ───────────────────────────────────────────────────

/**
 * RtcTransport — Low-level peer-to-peer packet transport with ICE + DTLS.
 *
 * Provides encrypted, consent-verified, congestion-aware packet delivery
 * without imposing RTP semantics. The application controls packetization,
 * codec selection, FEC, rate control, and all other media logic.
 *
 * @see https://w3c.github.io/webrtc-rtptransport/
 */
declare class RtcTransport {
  constructor(config: RtcTransportConfig);

  // ─── Local identity ─────────────────────────────────────────────────────

  /** Digest algorithm used for the local DTLS certificate fingerprint. */
  readonly fingerprintDigestAlgorithm: string;

  /** Raw bytes of the local DTLS certificate fingerprint. */
  readonly fingerprint: ArrayBuffer;

  // ─── ICE ────────────────────────────────────────────────────────────────

  /** Add a remote ICE candidate for connectivity checks. */
  addRemoteCandidate(candidate: RtcTransportICECandidateInit): void;

  /** Fires when a local ICE candidate is gathered. */
  onicecandidate: ((event: RtcTransportIceCandidateEvent) => void) | null;

  // ─── DTLS ───────────────────────────────────────────────────────────────

  /** Set the remote peer's DTLS parameters (fingerprint + role). */
  setRemoteDtlsParameters(params: RtcTransportDtlsParameters): void;

  // ─── Connectivity ───────────────────────────────────────────────────────

  /**
   * Resolves true when the transport is writable (ICE connected + DTLS/SRTP active).
   * Resolves false if the connection fails.
   */
  writable(): Promise<boolean>;

  /** Fires when writable state changes. */
  onwritablechange: (() => void) | null;

  // ─── Sending ────────────────────────────────────────────────────────────

  /**
   * Send one or more packets. In dtls-srtp mode, RTP/RTCP packets are
   * automatically SRTP-encrypted. Non-RTP packets are DTLS-encrypted.
   */
  sendPackets(params: RtcSendPacketParameters[]): void;

  /**
   * Fires when send outcome information is available.
   * Call getPacketSentInfo() to retrieve it.
   */
  onpendingpacketssentinfo: (() => void) | null;

  /** Retrieve send outcomes (timestamps, success status). Drains the buffer. */
  getPacketSentInfo(): RtcPacketSentInfo[];

  // ─── Receiving ──────────────────────────────────────────────────────────

  /**
   * Fires when received packets are available.
   * Call getReceivedPackets() to retrieve them.
   */
  onpendingpacketsreceived: (() => void) | null;

  /** Retrieve received packets. Drains the buffer. */
  getReceivedPackets(): RtcReceivedPacket[];

  // ─── Experimental / Future Spec ─────────────────────────────────────────

  /**
   * @experimental Set the wire format. May only be called once.
   * In current Chromium, format is set via config.wireProtocol instead.
   */
  setFormat?(format: RtcTransportFormat): void;

  /**
   * @experimental Supported wire formats on this platform.
   */
  static readonly supportedFormats?: readonly RtcTransportFormat[];

  /**
   * @experimental The network route controller instance.
   */
  readonly networkRouteController?: unknown;

  /**
   * @experimental Circuit-breaker status event.
   */
  ontransportstatus?: ((event: RtcTransportStatusEvent) => void) | null;

  /**
   * @experimental Error event (buffer overflow, feedback overflow).
   */
  onerror?: ((event: Event) => void) | null;

  /**
   * @experimental Fires when protocol-level feedback is auto-sent.
   */
  onfeedbacksent?: ((event: Event) => void) | null;
}

// ─── MediaStreamTrackProcessor (Insertable Streams) ─────────────────────────

declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack });
  readable: ReadableStream<VideoFrame | AudioData>;
}

// ─── MediaStreamTrackGenerator (Insertable Streams) ─────────────────────────
// Unflagged in this build (Exposed=Window). Accepts VideoFrame or AudioData
// written to `writable`; the instance itself is a MediaStreamTrack.

declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: string });
  readonly writable: WritableStream<VideoFrame | AudioData>;
}

// ─── WebCodecs extensions not in standard lib ───────────────────────────────

interface AudioEncoderConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate?: number;
  opus?: { frameDuration?: number };
}

interface AudioDecoderConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
}
