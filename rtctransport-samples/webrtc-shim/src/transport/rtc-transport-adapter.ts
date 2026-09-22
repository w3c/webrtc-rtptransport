// RtcTransport API Adapter
// Wraps the browser's RtcTransport API with a clean interface for the RTP
// session.

import { isRtcpPacket } from '../rtp/rtcp-packet';

export interface RtcTransportAdapterOptions {
  config: RtcTransportConfig;
  onRtpReceived: (payload: Uint8Array, receiveTime: number) => void;
  onRtcpReceived: (payload: Uint8Array, receiveTime: number) => void;
  onIceCandidate: (candidate: RtcTransportIceCandidate) => void;
  onWritable?: () => void;
}

export interface LocalTransportParams {
  iceUfrag: string;
  icePassword: string;
  fingerprintAlgorithm: string;
  fingerprint: ArrayBuffer;
}

export type FingerprintParameters =
    Pick<LocalTransportParams, 'fingerprintAlgorithm'|'fingerprint'>;

/**
 * Adapter for the RtcTransport browser API.
 * Manages packet sending/receiving and ICE/DTLS setup.
 */
export class RtcTransportAdapter {
  onRtpReceived: (payload: Uint8Array, receiveTime: number) => void;
  onRtcpReceived: (payload: Uint8Array, receiveTime: number) => void;
  onIceCandidate: (candidate: RtcTransportIceCandidate) => void;
  onWritable?: () => void;
  transport: RtcTransport|null;
  pollTimer: ReturnType<typeof setInterval>|null;
  packetIdCounter: number;
  config: RtcTransportConfig;
  iceUfrag: string|null;
  icePassword: string|null;
  _iceCredentialsResolve: (() => void)|null;
  _iceCredentialsPromise: Promise<void>;

  constructor({
    config,
    onRtpReceived,
    onRtcpReceived,
    onIceCandidate,
    onWritable,
  }: RtcTransportAdapterOptions) {
    this.onRtpReceived = onRtpReceived;
    this.onRtcpReceived = onRtcpReceived;
    this.onIceCandidate = onIceCandidate;
    this.onWritable = onWritable;

    this.transport = null;
    this.pollTimer = null;
    this.packetIdCounter = 0;
    this.config = config;

    this.iceUfrag = null;
    this.icePassword = null;
    this._iceCredentialsResolve = null;
    this._iceCredentialsPromise = new Promise((resolve) => {
      this._iceCredentialsResolve = resolve;
    });
  }

  async initialize(): Promise<LocalTransportParams> {
    if (typeof RtcTransport === 'undefined') {
      throw new Error(
          'RtcTransport API not available. Enable the RTCRtpTransport feature flag in Chrome.');
    }

    this.transport = new RtcTransport(this.config);

    this.transport.onicecandidate = (event: RtcTransportIceCandidateEvent):
        void => {
          const candidate = event.candidate;
          if (!this.iceUfrag && candidate.usernameFragment) {
            this.iceUfrag = candidate.usernameFragment;
            this.icePassword = candidate.password;
            if (this._iceCredentialsResolve) {
              this._iceCredentialsResolve();
              this._iceCredentialsResolve = null;
            }
          }
          this.onIceCandidate(candidate);
        };

    this.transport.onwritablechange = (): void => {
      if (this.onWritable) {
        this.onWritable();
      }
    };

    this._startPolling();

    await this._iceCredentialsPromise;

    return {
      iceUfrag: this.iceUfrag!,
      icePassword: this.icePassword!,
      fingerprintAlgorithm: this.transport.fingerprintDigestAlgorithm,
      fingerprint: this.transport.fingerprint,
    };
  }

  getLocalParameters(): FingerprintParameters {
    if (!this.transport) {
      throw new Error('Transport not initialized');
    }
    return {
      fingerprintAlgorithm: this.transport.fingerprintDigestAlgorithm,
      fingerprint: this.transport.fingerprint,
    };
  }

  addRemoteCandidate(candidate: RtcTransportICECandidateInit): void {
    if (!this.transport) {
      throw new Error('Transport not initialized');
    }
    this.transport.addRemoteCandidate(candidate);
  }

  setRemoteDtlsParameters(params: RtcTransportDtlsParameters): void {
    if (!this.transport) {
      throw new Error('Transport not initialized');
    }
    this.transport.setRemoteDtlsParameters(params);
  }

  async waitForWritable(): Promise<boolean> {
    if (!this.transport) {
      throw new Error('Transport not initialized');
    }
    return this.transport.writable();
  }

  sendPackets(packets: Uint8Array[]): number[] {
    if (!this.transport) {
      throw new Error('Transport not initialized');
    }

    const sendParams: RtcSendPacketParameters[] =
        packets.map((data): RtcSendPacketParameters => ({
          id: this.packetIdCounter++,
          data,
        }));

    this.transport.sendPackets(sendParams);
    return sendParams.map((packet) => packet.id);
  }

  send(data: Uint8Array): number {
    return this.sendPackets([data])[0];
  }

  close(): void {
    this._stopPolling();
    this.transport = null;
  }

  private _startPolling(): void {
    this.pollTimer = setInterval(() => this._pollReceivedPackets(), 5);
  }

  private _stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private _pollReceivedPackets(): void {
    if (!this.transport) {
      return;
    }

    const packets = this.transport.getReceivedPackets();
    for (const packet of packets) {
      const buffer = new Uint8Array(packet.payloadByteLength);
      packet.copyPayloadTo(buffer);
      const receiveTime = packet.receiveTime;

      if (isRtcpPacket(buffer)) {
        this.onRtcpReceived(buffer, receiveTime);
      } else {
        this.onRtpReceived(buffer, receiveTime);
      }
    }
  }
}
