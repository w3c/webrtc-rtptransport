// Transport-Wide Congestion Control (RFC 8888 / draft-holmer-rmcat-transport-wide-cc)
// Generates and parses transport-wide CC feedback messages.

import {RTCP_PT} from './rtcp-packet';

// Transport-wide CC feedback format (FMT=15, PT=205)
const TRANSPORT_CC_FMT = 15;

export interface PacketStatus {
  sequenceNumber: number;
  receiveTimeMs: number | null;
}

export interface TransportCcFeedback {
  senderSsrc: number;
  mediaSsrc: number;
  baseSequenceNumber: number;
  referenceTimeMs: number;
  feedbackPacketCount: number;
  packetStatuses: PacketStatus[];
}

export interface TransportCcResult {
  seq: number;
  sendTime: number;
  receiveTime: number;
  owdDelta: number;
}

type ReceivedPacketStatus = PacketStatus&{receiveTimeMs: number};

/**
 * Transport-wide CC receiver - tracks received packet times.
 */
export class TransportCcReceiver {
  senderSsrc: number;
  mediaSsrc: number;
  receivedPackets: Map<number, number>;
  feedbackCount: number;
  baseSeq: number;
  highestSeq: number;

  constructor(senderSsrc: number, mediaSsrc: number) {
    this.senderSsrc = senderSsrc;
    this.mediaSsrc = mediaSsrc;
    this.receivedPackets = new Map();
    this.feedbackCount = 0;
    this.baseSeq = -1;
    this.highestSeq = -1;
  }

  /**
   * Record reception of a packet with its transport-wide sequence number.
   * @param transportSeq Transport-wide sequence number
   * @param receiveTimeMs Local receive time
   */
  onPacketReceived(transportSeq: number, receiveTimeMs: number): void {
    this.receivedPackets.set(transportSeq, receiveTimeMs);

    if (this.baseSeq === -1 || transportSeq < this.baseSeq) {
      this.baseSeq = transportSeq;
    }
    if (transportSeq > this.highestSeq) {
      this.highestSeq = transportSeq;
    }
  }

  /**
   * Generate a transport-CC feedback packet.
   * @returns Serialized feedback or null if nothing to report
   */
  generateFeedback(): Uint8Array | null {
    if (this.receivedPackets.size === 0) {
      return null;
    }

    const baseSeq = this.baseSeq;
    const count = this.highestSeq - baseSeq + 1;
    if (count <= 0) {
      return null;
    }

    // Build packet status list
    const statuses: PacketStatus[] = [];
    let referenceTime: number | null = null;

    for (let i = 0; i < count; i++) {
      const seq = baseSeq + i;
      const receiveTime = this.receivedPackets.get(seq);
      if (receiveTime !== undefined) {
        if (referenceTime === null) {
          referenceTime = receiveTime;
        }
        statuses.push({sequenceNumber: seq, receiveTimeMs: receiveTime});
      } else {
        statuses.push({sequenceNumber: seq, receiveTimeMs: null});
      }
    }

    // Serialize simplified feedback
    const feedback = this._serialize(baseSeq, count, statuses, referenceTime || 0);

    // Clear processed packets
    this.receivedPackets.clear();
    this.baseSeq = -1;
    this.highestSeq = -1;
    this.feedbackCount++;

    return feedback;
  }

  /** @private */
  _serialize(
      baseSeq: number, packetCount: number, statuses: PacketStatus[],
      referenceTimeMs: number): Uint8Array {
    // Simplified serialization: header + status chunks + receive deltas
    // Full RFC 8888 format is complex; this is a functional approximation.

    // Calculate received count for delta array
    const received = statuses.filter(
        (s): s is ReceivedPacketStatus => s.receiveTimeMs !== null);

    // Header: 8 bytes fixed + 2 bytes base seq + 2 bytes packet status count
    // + status chunks + receive deltas
    const statusChunkCount = Math.ceil(packetCount / 14);
    const deltaSize = received.length * 2;
    const size = 12 + 4 + statusChunkCount * 2 + deltaSize;
    const paddedSize = Math.ceil(size / 4) * 4;

    const buffer = new Uint8Array(paddedSize);
    const view = new DataView(buffer.buffer);

    // RTCP header
    view.setUint8(0, (2 << 6) | TRANSPORT_CC_FMT);
    view.setUint8(1, RTCP_PT.RTPFB);
    view.setUint16(2, (paddedSize / 4) - 1);
    view.setUint32(4, this.senderSsrc >>> 0);
    view.setUint32(8, this.mediaSsrc >>> 0);

    // Transport-CC specific fields
    view.setUint16(12, baseSeq & 0xFFFF);
    view.setUint16(14, packetCount & 0xFFFF);

    // Reference time (24-bit, in 64ms units)
    const refTime64ms = Math.floor(referenceTimeMs / 64) & 0xFFFFFF;
    view.setUint8(16, (refTime64ms >> 16) & 0xFF);
    view.setUint8(17, (refTime64ms >> 8) & 0xFF);
    view.setUint8(18, refTime64ms & 0xFF);
    view.setUint8(19, this.feedbackCount & 0xFF);

    // Status chunks (simplified: one-bit status vector)
    let offset = 20;
    for (let chunk = 0; chunk < statusChunkCount; chunk++) {
      let statusBits = 0x4000;
      for (let bit = 0; bit < 14; bit++) {
        const idx = chunk * 14 + bit;
        if (idx < statuses.length && statuses[idx].receiveTimeMs !== null) {
          statusBits |= 1 << (13 - bit);
        }
      }
      view.setUint16(offset, statusBits);
      offset += 2;
    }

    // Receive deltas (small delta = 250µs units, 16-bit)
    let lastTime = referenceTimeMs;
    for (const status of received) {
      const deltaMs = status.receiveTimeMs - lastTime;
      const delta250us = Math.round(deltaMs * 4);
      view.setInt16(offset, Math.max(-32768, Math.min(32767, delta250us)));
      offset += 2;
      lastTime = status.receiveTimeMs;
    }

    return buffer;
  }
}

/**
 * Transport-wide CC sender - parses feedback and computes delays.
 */
export class TransportCcSender {
  sentPackets: Map<number, number>;
  nextSeq: number;

  constructor() {
    this.sentPackets = new Map();
    this.nextSeq = 0;
  }

  /**
   * Register a sent packet.
   * @param sendTimeMs
   * @returns Assigned transport-wide sequence number
   */
  onPacketSent(sendTimeMs: number): number {
    const seq = this.nextSeq++;
    this.sentPackets.set(seq, sendTimeMs);
    return seq;
  }

  /**
   * Process received feedback to compute one-way delay variations.
   * @param feedback
   * @returns
   */
  processFeedback(feedback: TransportCcFeedback): TransportCcResult[] {
    const results: TransportCcResult[] = [];
    let prevSendTime: number | null = null;
    let prevReceiveTime: number | null = null;

    for (const status of feedback.packetStatuses) {
      if (status.receiveTimeMs === null) {
        continue;
      }

      const sendTime = this.sentPackets.get(status.sequenceNumber);
      if (sendTime === undefined) {
        continue;
      }

      let owdDelta = 0;
      if (prevSendTime !== null && prevReceiveTime !== null) {
        const sendDelta = sendTime - prevSendTime;
        const recvDelta = status.receiveTimeMs - prevReceiveTime;
        owdDelta = recvDelta - sendDelta;
      }

      results.push({
        seq: status.sequenceNumber,
        sendTime,
        receiveTime: status.receiveTimeMs,
        owdDelta,
      });

      prevSendTime = sendTime;
      prevReceiveTime = status.receiveTimeMs;

      // Clean up old entries
      this.sentPackets.delete(status.sequenceNumber);
    }

    return results;
  }
}
