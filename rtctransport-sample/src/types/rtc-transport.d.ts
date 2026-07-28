/**
 * W3C RtcTransport API Type Definitions
 * https://w3c.github.io/webrtc-rtptransport/
 *
 * This file contains complete TypeScript declarations for the RtcTransport
 * specification as defined by the W3C WebRTC RTP Transport draft.
 */

// =============================================================================
// §4 — RtcTransport Interface
// =============================================================================

/**
 * Wire format for the transport.
 * Currently only "ICE-DTLS/V0" is specified.
 */
type RtcTransportFormat = 'ICE-DTLS/V0';

/**
 * Type of network route controller to instantiate.
 */
type RtcNetworkRouteControllerType =
  | 'automaticIceController'
  | 'manualIceController';

/**
 * Configuration for RtcTransport constructor.
 */
interface RtcTransportConfig {
  transportControllerType: RtcNetworkRouteControllerType;
}

/**
 * A packet scheduled for sending.
 */
interface RtcPacketToSend {
  /** Monotonically increasing packet identifier. */
  id: number;
  /** Scheduled send time (DOMHighResTimeStamp). */
  sendTime: DOMHighResTimeStamp;
  /** The packet data to send. */
  data: ArrayBuffer | ArrayBufferView;
}

/**
 * Information about a sent packet, returned by getPacketSentInfo().
 */
interface RtcPacketSentInfo {
  /** The packet ID matching the RtcPacketToSend.id. */
  id: number;
  /** Actual send time (DOMHighResTimeStamp). */
  sendTime: DOMHighResTimeStamp;
  /** Size of the sent packet in bytes. */
  size: number;
}

/**
 * A received packet, returned by getReceivedPacket().
 */
interface RtcPacketReceived {
  /** The packet data received. */
  data: ArrayBuffer;
  /** Time the packet was received (DOMHighResTimeStamp). */
  receiveTime: DOMHighResTimeStamp;
}

/**
 * Union type for the network route controller.
 */
type RtcNetworkRouteController =
  | RtcAutomaticIceController
  | RtcManualIceController;

/**
 * Network route — an IceCandidatePair that is writable.
 */
type RtcNetworkRoute = IceCandidatePair;

/**
 * The main RtcTransport interface.
 * Provides low-level packet send/receive over a secure peer-to-peer transport.
 */
interface RtcTransport extends EventTarget {
  /**
   * Sets the wire format for the transport. Can only be called once.
   * @throws InvalidStateError if format is already set.
   */
  setFormat(format: RtcTransportFormat): void;

  /**
   * Schedules packets for sending over the specified network route.
   * Packets must have monotonically increasing IDs and sendTimes.
   * @throws InvalidAccessError if networkRoute doesn't belong to this transport.
   * @throws InvalidStateError if encryption is not established.
   * @throws RangeError if packet ordering or timing constraints are violated.
   */
  sendPackets(packets: RtcPacketToSend[], networkRoute: RtcNetworkRoute): void;

  /**
   * Sets the remote peer's certificate fingerprints. Can only be called once.
   * @throws InvalidStateError if fingerprints are already set.
   */
  setRemoteFingerprints(fingerprints: ArrayBuffer[]): void;

  /**
   * Initiates or continues the encryption handshake over the given route.
   * Resolves to true on success, false if the route is not writable or
   * handshake fails.
   */
  establishEncryption(networkRoute: RtcNetworkRoute): Promise<boolean>;

  /**
   * Retrieves and drains the queue of sent packet information.
   */
  getPacketSentInfo(): RtcPacketSentInfo[];

  /**
   * Retrieves and drains the queue of received packets.
   */
  getReceivedPacket(): RtcPacketReceived[];

  /** Supported transport formats. */
  readonly supportedFormats: readonly RtcTransportFormat[];

  /** The network route controller associated with this transport. */
  readonly networkRouteController: RtcNetworkRouteController;

  /** Fired when the circuit-breaker disables or re-enables the transport. */
  ontransportstatus: ((this: RtcTransport, ev: Event) => any) | null;

  /** Fired when there is new packet sent info to retrieve. */
  onpendingpacketssentinfo: ((this: RtcTransport, ev: Event) => any) | null;

  /** Fired when there are new received packets to retrieve. */
  onpendingpacketsreceived: ((this: RtcTransport, ev: Event) => any) | null;

  /** Fired on buffer overflows (sent info, feedback, or receive buffers). */
  onerror: ((this: RtcTransport, ev: Event) => any) | null;

  /** Fired when the transport sends protocol-level feedback. */
  onfeedbacksent: ((this: RtcTransport, ev: Event) => any) | null;
}

declare var RtcTransport: {
  prototype: RtcTransport;
  new (config: RtcTransportConfig): RtcTransport;
  readonly supportedFormats: readonly RtcTransportFormat[];
};

// =============================================================================
// §5.1 — RtcManualIceController
// =============================================================================

/** STUN/TURN server configuration. */
interface IceServerInit {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** ICE candidate types. */
type IceCandidateType = 'host' | 'srflx' | 'prflx' | 'relay';

/**
 * A locally gathered ICE candidate.
 */
interface LocalIceCandidate {
  /** The candidate type. */
  readonly type: IceCandidateType;
  /** The candidate's IP address. */
  readonly address: string;
  /** The candidate's port number. */
  readonly port: number;
  /** The transport protocol. */
  readonly protocol: 'udp' | 'tcp';
  /** Relay allocation lifetime in seconds (relay candidates only). */
  readonly relayAllocationLifetime?: number;
}

/** Remote ICE candidate initialization dictionary. */
interface RemoteIceCandidateInit {
  address: string;
  port: number;
  protocol?: 'udp' | 'tcp';
  usernameFragment: string;
  password: string;
  type?: IceCandidateType;
}

/** Result of probing a candidate pair. */
interface IceProbeResult {
  /** Whether the probe succeeded. */
  success: boolean;
  /** Round-trip time in milliseconds if successful. */
  rttMs?: number;
}

/**
 * An ICE candidate pair (local + remote) associated with a controller.
 */
interface IceCandidatePair {
  /** The local candidate. */
  readonly localCandidate: LocalIceCandidate;
  /** The remote candidate. */
  readonly remoteCandidate: RemoteIceCandidateInit;
}

/**
 * Manual ICE controller — gives application full control over
 * candidate gathering, pairing, and connectivity checking.
 */
interface RtcManualIceController extends EventTarget {
  /** Starts gathering host candidates on all network interfaces. */
  gatherHostCandidates(): void;

  /** Gathers server-reflexive candidates via STUN. */
  gatherSrflxCandidates(iceServer: IceServerInit): Promise<void>;

  /** Refreshes a server-reflexive candidate binding. */
  refreshSrflxCandidate(localCandidate: LocalIceCandidate): Promise<boolean>;

  /** Gathers relay candidates via TURN. */
  gatherRelayCandidates(
    server: IceServerInit,
    requestedLifetimeInSeconds: number,
  ): Promise<void>;

  /** Refreshes a relay candidate allocation. */
  refreshRelayCandidate(
    relayCandidate: LocalIceCandidate,
    requestedLifetimeInSeconds: number,
  ): Promise<number>;

  /** Creates a candidate pair from a local and remote candidate. */
  createCandidatePair(
    local: LocalIceCandidate,
    remote: RemoteIceCandidateInit,
  ): IceCandidatePair;

  /** Probes a candidate pair for connectivity. */
  probeCandidatePair(candidatePair: IceCandidatePair): Promise<IceProbeResult>;

  /** Fired when a new local candidate is gathered. */
  oncandidategathered:
    | ((this: RtcManualIceController, ev: Event) => any)
    | null;

  /** Fired when a local candidate is removed (e.g. network interface down). */
  oncandidateremoved:
    | ((this: RtcManualIceController, ev: Event) => any)
    | null;

  /** Fired when the maximum payload size changes for a route. */
  onmaxpayloadsizeupdate:
    | ((this: RtcManualIceController, ev: Event) => any)
    | null;

  /** Fired on errors. */
  onerror: ((this: RtcManualIceController, ev: Event) => any) | null;
}

// =============================================================================
// §5.2 — RtcAutomaticIceController
// =============================================================================

/** ICE candidate event detail for automatic controller. */
interface RtcTransportIceCandidateInit {
  address: string;
  port: number;
  type: IceCandidateType;
  usernameFragment: string;
  protocol?: 'udp' | 'tcp';
}

/**
 * Automatic ICE controller — handles candidate gathering and
 * connectivity checking automatically. The application only provides
 * remote candidates and receives events.
 */
interface RtcAutomaticIceController extends EventTarget {
  /** The local ICE username fragment. */
  readonly iceUsernameFragment: string;

  /** The local ICE password. */
  readonly icePassword: string;

  /** Adds a remote ICE candidate to the controller. */
  addRemoteCandidate(candidate: RtcTransportIceCandidateInit): void;

  /** Signals that all remote candidates have been received. */
  addRemoteCandidateEnd(): void;

  /** Fired when a new local ICE candidate is gathered. */
  onicecandidate:
    | ((this: RtcAutomaticIceController, ev: RtcIceCandidateEvent) => any)
    | null;

  /** Fired when a writable network route becomes available. */
  onnetworkroute:
    | ((this: RtcAutomaticIceController, ev: RtcNetworkRouteEvent) => any)
    | null;

  /** Fired when the controller encounters an error. */
  onerror: ((this: RtcAutomaticIceController, ev: Event) => any) | null;
}

// =============================================================================
// §6 — Events
// =============================================================================

/** Event fired when a local ICE candidate is gathered. */
interface RtcIceCandidateEvent extends Event {
  readonly candidate: RtcTransportIceCandidateInit;
}

/** Event fired when a writable network route is available. */
interface RtcNetworkRouteEvent extends Event {
  readonly networkRoute: RtcNetworkRoute;
}

/** Event fired when transport status changes (circuit breaker). */
interface RtcTransportStatusEvent extends Event {
  readonly enabled: boolean;
}
