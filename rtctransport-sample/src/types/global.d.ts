// Global type declarations for browser APIs not in standard TypeScript libs

// RtcTransport API (experimental, behind flag — current Chromium implementation)
interface RtcTransportConfig {
  name?: string;
  iceServers?: RTCIceServer[];
  iceControlling?: boolean;
  wireProtocol?: string;
}

interface RtcTransportIceCandidate {
  address: string;
  port: number;
  type: string;
  usernameFragment: string;
  password: string;
}

interface RtcTransportICECandidateInit {
  address: string;
  port: number;
  type: string;
  usernameFragment: string;
  password: string;
}

interface RtcTransportDtlsParameters {
  sslRole: string;
  fingerprintDigestAlgorithm: string;
  fingerprint: ArrayBuffer;
}

interface RtcReceivedPacket {
  payloadByteLength: number;
  receiveTime: number;
  copyPayloadTo(buffer: Uint8Array): void;
}

interface RtcSendPacketParameters {
  id: number;
  data: Uint8Array;
}

interface RtcTransportIceCandidateEvent {
  candidate: RtcTransportIceCandidate;
}

declare class RtcTransport {
  constructor(config: RtcTransportConfig);
  fingerprintDigestAlgorithm: string;
  fingerprint: ArrayBuffer;
  onicecandidate: ((event: RtcTransportIceCandidateEvent) => void) | null;
  onwritablechange: (() => void) | null;
  writable(): Promise<boolean>;
  sendPackets(params: RtcSendPacketParameters[]): void;
  getReceivedPackets(): RtcReceivedPacket[];
  addRemoteCandidate(candidate: RtcTransportICECandidateInit): void;
  setRemoteDtlsParameters(params: RtcTransportDtlsParameters): void;
}

// MediaStreamTrackProcessor (Insertable Streams)
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack });
  readable: ReadableStream<VideoFrame | AudioData>;
}

// WebCodecs extensions not in standard lib
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
