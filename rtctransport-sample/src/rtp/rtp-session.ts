// RTP Session Management
// Handles SSRC allocation, sequence numbers, timestamps, and RTCP reporting.

import {
  serializeRtpPacket,
  type RtpHeader,
  type RtpHeaderExtension,
  type RtpPacket,
} from './rtp-packet';
import {
  getNtpTimestamp,
  ntpToCompact,
  serializeReceiverReport,
  serializeSenderReport,
  type RtcpReportBlock,
} from './rtcp-packet';

export interface RtpSendStreamOptions {
  ssrc: number;
  payloadType: number;
  clockRate: number;
  initialSeq?: number;
  initialTimestamp?: number;
}

export interface RtpSessionSendStreamOptions {
  ssrc?: number;
  payloadType: number;
  clockRate: number;
  initialSeq?: number;
  initialTimestamp?: number;
}

/**
 * Generate a random 32-bit SSRC.
 * @returns
 */
export function generateSsrc(): number {
  return (Math.random() * 0xFFFFFFFF) >>> 0;
}

/**
 * RTP Send Stream - manages outbound RTP for one SSRC.
 */
export class RtpSendStream {
  ssrc: number;
  payloadType: number;
  clockRate: number;
  sequenceNumber: number;
  timestamp: number;
  packetCount: number;
  octetCount: number;

  constructor(
      {ssrc, payloadType, clockRate, initialSeq, initialTimestamp}:
          RtpSendStreamOptions) {
    this.ssrc = ssrc;
    this.payloadType = payloadType;
    this.clockRate = clockRate;
    this.sequenceNumber = initialSeq ?? Math.floor(Math.random() * 0xFFFF);
    this.timestamp =
        initialTimestamp ?? Math.floor(Math.random() * 0xFFFFFFFF);
    this.packetCount = 0;
    this.octetCount = 0;
  }

  /**
   * Create an RTP packet with the given payload.
   * @param payload Media payload
   * @param timestampIncrement Timestamp increment for this packet
   * @param marker Marker bit
   * @param extension Optional header extension
   * @returns Serialized RTP packet
   */
  createPacket(
      payload: Uint8Array, timestampIncrement: number, marker = false,
      extension: RtpHeaderExtension | null = null): Uint8Array {
    this.timestamp = (this.timestamp + timestampIncrement) >>> 0;
    const seqNum = this.sequenceNumber & 0xFFFF;
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;

    this.packetCount++;
    this.octetCount += payload.length;

    const packet: RtpPacket = {
      header: {
        version: 2,
        padding: false,
        extension: extension !== null,
        csrcCount: 0,
        marker,
        payloadType: this.payloadType,
        sequenceNumber: seqNum,
        timestamp: this.timestamp,
        ssrc: this.ssrc,
        csrc: [],
      },
      extension,
      payload,
    };

    return serializeRtpPacket(packet);
  }

  /**
   * Generate a Sender Report for this stream.
   * @param reportBlocks
   * @returns
   */
  createSenderReport(reportBlocks: RtcpReportBlock[] = []): Uint8Array {
    const ntp = getNtpTimestamp();
    return serializeSenderReport({
      type: 'SR',
      ssrc: this.ssrc,
      senderInfo: {
        ntpTimestampMsw: ntp.msw,
        ntpTimestampLsw: ntp.lsw,
        rtpTimestamp: this.timestamp,
        senderPacketCount: this.packetCount,
        senderOctetCount: this.octetCount,
      },
      reportBlocks,
    });
  }
}

/**
 * RTP Receive Stream - tracks statistics for one received SSRC.
 */
export class RtpReceiveStream {
  ssrc: number;
  clockRate: number;
  highestSeqNum: number;
  seqNumCycles: number;
  baseSeq: number;
  packetsReceived: number;
  expectedPrior: number;
  receivedPrior: number;
  lastTransit: number;
  jitter: number;
  lastSrNtpCompact: number;
  lastSrReceivedAt: number;
  lastArrivalTime: number;

  constructor(ssrc: number, clockRate: number) {
    this.ssrc = ssrc;
    this.clockRate = clockRate;

    // Sequence number tracking
    this.highestSeqNum = -1;
    this.seqNumCycles = 0;
    this.baseSeq = -1;
    this.packetsReceived = 0;

    // Loss tracking
    this.expectedPrior = 0;
    this.receivedPrior = 0;

    // Jitter calculation (RFC 3550 A.8)
    this.lastTransit = 0;
    this.jitter = 0;

    // Last SR tracking for DLSR
    this.lastSrNtpCompact = 0;
    this.lastSrReceivedAt = 0;

    // Timing
    this.lastArrivalTime = 0;
  }

  /**
   * Process a received RTP packet.
   * @param header
   * @param arrivalTimeMs Arrival time in milliseconds
   */
  processPacket(header: RtpHeader, arrivalTimeMs: number): void {
    const seq = header.sequenceNumber;

    if (this.baseSeq === -1) {
      this.baseSeq = seq;
      this.highestSeqNum = seq;
    }

    // Detect sequence number wraparound
    const diff = seq - (this.highestSeqNum & 0xFFFF);
    if (diff > 0 && diff < 0x8000) {
      // In order or small jump forward
      if (seq < (this.highestSeqNum & 0xFFFF)) {
        this.seqNumCycles += 0x10000;
      }
      this.highestSeqNum = this.seqNumCycles + seq;
    } else if (diff < -0x8000) {
      // Wraparound
      this.seqNumCycles += 0x10000;
      this.highestSeqNum = this.seqNumCycles + seq;
    }
    // else: duplicate or reordered, don't update highest

    this.packetsReceived++;

    // Jitter calculation (RFC 3550 A.8)
    const arrivalRtpUnits = (arrivalTimeMs / 1000) * this.clockRate;
    const transit = arrivalRtpUnits - header.timestamp;
    if (this.lastTransit !== 0) {
      const d = Math.abs(transit - this.lastTransit);
      this.jitter += (d - this.jitter) / 16;
    }
    this.lastTransit = transit;
    this.lastArrivalTime = arrivalTimeMs;
  }

  /**
   * Record reception of a Sender Report.
   * @param ntpMsw
   * @param ntpLsw
   */
  processSenderReport(ntpMsw: number, ntpLsw: number): void {
    this.lastSrNtpCompact = ntpToCompact(ntpMsw, ntpLsw);
    this.lastSrReceivedAt = performance.now();
  }

  /**
   * Generate a report block for this source.
   * @returns
   */
  createReportBlock(): RtcpReportBlock {
    const extended = this.highestSeqNum;
    const expected = extended - this.baseSeq + 1;
    const lost = expected - this.packetsReceived;

    // Fraction lost since last RR
    const expectedInterval = expected - this.expectedPrior;
    const receivedInterval = this.packetsReceived - this.receivedPrior;
    this.expectedPrior = expected;
    this.receivedPrior = this.packetsReceived;

    let fractionLost = 0;
    if (expectedInterval > 0) {
      const lostInterval = expectedInterval - receivedInterval;
      fractionLost =
          Math.max(0, Math.floor((lostInterval * 256) / expectedInterval));
    }

    // DLSR in 1/65536 seconds
    let dlsr = 0;
    if (this.lastSrReceivedAt > 0) {
      const delaySec = (performance.now() - this.lastSrReceivedAt) / 1000;
      dlsr = Math.floor(delaySec * 65536);
    }

    return {
      ssrc: this.ssrc,
      fractionLost: fractionLost & 0xFF,
      cumulativeLost: Math.max(0, lost) & 0xFFFFFF,
      highestSeqNum: extended >>> 0,
      jitter: Math.floor(this.jitter) >>> 0,
      lastSr: this.lastSrNtpCompact,
      delaySinceLastSr: dlsr >>> 0,
    };
  }
}

/**
 * RTP Session - manages send and receive streams.
 */
export class RtpSession {
  sendStreams: Map<number, RtpSendStream>;
  receiveStreams: Map<number, RtpReceiveStream>;
  localSsrc: number;

  constructor() {
    this.sendStreams = new Map();
    this.receiveStreams = new Map();
    this.localSsrc = generateSsrc();
  }

  /**
   * Create a send stream.
   * @param options
   * @returns
   */
  createSendStream(options: RtpSessionSendStreamOptions): RtpSendStream {
    const stream = new RtpSendStream({ssrc: this.localSsrc, ...options});
    this.sendStreams.set(stream.ssrc, stream);
    return stream;
  }

  /**
   * Get or create a receive stream for an SSRC.
   * @param ssrc
   * @param clockRate
   * @returns
   */
  getOrCreateReceiveStream(
      ssrc: number, clockRate: number): RtpReceiveStream {
    if (!this.receiveStreams.has(ssrc)) {
      this.receiveStreams.set(ssrc, new RtpReceiveStream(ssrc, clockRate));
    }
    return this.receiveStreams.get(ssrc)!;
  }

  /**
   * Generate a Receiver Report covering all receive streams.
   * @returns
   */
  createReceiverReport(): Uint8Array {
    const reportBlocks: RtcpReportBlock[] = [];
    for (const stream of this.receiveStreams.values()) {
      reportBlocks.push(stream.createReportBlock());
    }
    return serializeReceiverReport({
      type: 'RR',
      ssrc: this.localSsrc,
      reportBlocks,
    });
  }
}
