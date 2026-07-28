// RTX Handler (RFC 4588) - Retransmission on a separate SSRC
// Handles both sending RTX packets and receiving/depacketizing them.

import {
  parseRtpPacket,
  type RtpPacket,
  serializeRtpPacket,
} from '../rtp/rtp-packet';

export interface RtxSenderOptions {
  rtxSsrc: number;
  rtxPayloadType: number;
  historySize?: number;
}

export interface RtxReceiverOptions {
  originalSsrc: number;
  originalPayloadType: number;
}

/**
 * RTX sender - retransmits packets on a separate SSRC.
 */
export class RtxSender {
  rtxSsrc: number;
  rtxPayloadType: number;
  historySize: number;
  sequenceNumber: number;
  packetHistory: Map<number, Uint8Array>;
  historyOrder: number[];

  constructor({
    rtxSsrc,
    rtxPayloadType,
    historySize = 500,
  }: RtxSenderOptions) {
    this.rtxSsrc = rtxSsrc;
    this.rtxPayloadType = rtxPayloadType;
    this.historySize = historySize;

    this.sequenceNumber = Math.floor(Math.random() * 0xFFFF);
    this.packetHistory = new Map();
    this.historyOrder = [];
  }

  storePacket(sequenceNumber: number, packet: Uint8Array): void {
    if (this.packetHistory.size >= this.historySize) {
      const oldest = this.historyOrder.shift();
      if (oldest !== undefined) {
        this.packetHistory.delete(oldest);
      }
    }
    this.packetHistory.set(sequenceNumber, packet);
    this.historyOrder.push(sequenceNumber);
  }

  createRtxPacket(originalSeq: number): Uint8Array|null {
    const originalPacket = this.packetHistory.get(originalSeq);
    if (!originalPacket) {
      return null;
    }

    const original = parseRtpPacket(originalPacket);

    const rtxPayload = new Uint8Array(2 + original.payload.length);
    const view = new DataView(rtxPayload.buffer);
    view.setUint16(0, originalSeq & 0xFFFF);
    rtxPayload.set(original.payload, 2);

    const rtxSeq = this.sequenceNumber & 0xFFFF;
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;

    const rtxPacket: RtpPacket = {
      header: {
        version: 2,
        padding: false,
        extension: false,
        csrcCount: 0,
        marker: original.header.marker,
        payloadType: this.rtxPayloadType,
        sequenceNumber: rtxSeq,
        timestamp: original.header.timestamp,
        ssrc: this.rtxSsrc,
        csrc: [],
      },
      extension: null,
      payload: rtxPayload,
    };

    return serializeRtpPacket(rtxPacket);
  }
}

/**
 * RTX receiver - depacketizes RTX packets to recover original packets.
 */
export class RtxReceiver {
  originalSsrc: number;
  originalPayloadType: number;

  constructor({ originalSsrc, originalPayloadType }: RtxReceiverOptions) {
    this.originalSsrc = originalSsrc;
    this.originalPayloadType = originalPayloadType;
  }

  recover(rtxPacket: RtpPacket): Uint8Array {
    const payload = rtxPacket.payload;
    if (payload.length < 2) {
      throw new Error('RTX payload too short');
    }

    const originalSeq = (payload[0] << 8) | payload[1];
    const originalPayload = payload.slice(2);

    const recovered: RtpPacket = {
      header: {
        version: 2,
        padding: false,
        extension: rtxPacket.header.extension,
        csrcCount: 0,
        marker: rtxPacket.header.marker,
        payloadType: this.originalPayloadType,
        sequenceNumber: originalSeq,
        timestamp: rtxPacket.header.timestamp,
        ssrc: this.originalSsrc,
        csrc: [],
      },
      extension: rtxPacket.extension,
      payload: originalPayload,
    };

    return serializeRtpPacket(recovered);
  }
}
