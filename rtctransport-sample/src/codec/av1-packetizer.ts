// AV1 RTP Packetizer/Depacketizer
// Based on: https://aomediacodec.github.io/av1-rtp-spec/
//
// AV1 aggregation header (1 byte):
//   0 1 2 3 4 5 6 7
//  +-+-+-+-+-+-+-+-+
//  |Z|Y| W |N|     |
//  +-+-+-+-+-+-+-+-+
// Z: MUST be 0 in first packet of temporal unit, 1 otherwise
// Y: MUST be 1 if last OBU element is fragment, 0 otherwise
// W: OBU count minus 1 for W < 3; W=3 means last OBU fills remainder
// N: New coded video sequence (keyframe indicator)

import { RtpSendStream } from '../rtp/rtp-session';
import type { RtpPacket } from '../rtp/rtp-packet';

export const AV1_PAYLOAD_TYPE = 35 as const;
export const AV1_CLOCK_RATE = 90000 as const;
const MAX_RTP_PAYLOAD_SIZE = 1200;

interface PendingAv1Packet {
  seq: number;
  data: Uint8Array;
}

interface PendingAv1Frame {
  packets: PendingAv1Packet[];
  timestamp: number;
  isKeyframe: boolean;
}

export interface Av1DepacketizedFrame {
  frame: Uint8Array;
  isKeyframe: boolean;
  timestamp: number;
}

export class Av1Packetizer {
  private readonly sendStream: RtpSendStream;
  private readonly maxPayloadSize: number;
  private firstFrame = true;

  constructor(
    sendStream: RtpSendStream,
    maxPayloadSize: number = MAX_RTP_PAYLOAD_SIZE,
  ) {
    this.sendStream = sendStream;
    this.maxPayloadSize = maxPayloadSize;
  }

  packetize(
    frame: Uint8Array,
    isKeyframe: boolean,
    timestampIncrement: number,
  ): Uint8Array[] {
    const packets: Uint8Array[] = [];
    const increment = this.firstFrame ? 0 : timestampIncrement;
    this.firstFrame = false;

    const obus = this._parseObus(frame);
    const totalObuSize = obus.reduce((sum, obu) => {
      return sum + obu.length;
    }, 0);

    if (1 + totalObuSize <= this.maxPayloadSize) {
      const payload = new Uint8Array(1 + totalObuSize);
      let aggHeader = 0x30;
      if (isKeyframe) {
        aggHeader |= 0x08;
      }
      payload[0] = aggHeader;

      let offset = 1;
      for (const obu of obus) {
        payload.set(obu, offset);
        offset += obu.length;
      }

      packets.push(this.sendStream.createPacket(payload, increment, true));
      return packets;
    }

    const allObus = new Uint8Array(totalObuSize);
    let aggregateOffset = 0;
    for (const obu of obus) {
      allObus.set(obu, aggregateOffset);
      aggregateOffset += obu.length;
    }

    const maxFragmentSize = this.maxPayloadSize - 1;
    const fragmentCount = Math.ceil(allObus.length / maxFragmentSize);

    for (let i = 0; i < fragmentCount; ++i) {
      const start = i * maxFragmentSize;
      const end = Math.min(start + maxFragmentSize, allObus.length);
      const fragment = allObus.slice(start, end);
      const isFirst = i === 0;
      const isLast = i === fragmentCount - 1;

      let aggHeader = 0x30;
      if (!isFirst) {
        aggHeader |= 0x80;
      }
      if (!isLast) {
        aggHeader |= 0x40;
      }
      if (isFirst && isKeyframe) {
        aggHeader |= 0x08;
      }

      const payload = new Uint8Array(1 + fragment.length);
      payload[0] = aggHeader;
      payload.set(fragment, 1);

      packets.push(
        this.sendStream.createPacket(payload, isFirst ? increment : 0, isLast),
      );
    }

    return packets;
  }

  private _parseObus(frame: Uint8Array): Uint8Array[] {
    return [frame];
  }
}

export class Av1Depacketizer {
  private readonly pendingFrames: Map<number, PendingAv1Frame>;

  constructor() {
    this.pendingFrames = new Map();
  }

  depacketize(rtpPacket: RtpPacket): Av1DepacketizedFrame|null {
    const {header, payload} = rtpPacket;
    if (payload.length < 2) {
      return null;
    }

    const aggHeader = payload[0];
    const isKeyframe = (aggHeader & 0x08) !== 0;
    const timestamp = header.timestamp;

    if (!this.pendingFrames.has(timestamp)) {
      this.pendingFrames.set(
        timestamp,
        {packets: [], timestamp, isKeyframe: false},
      );
    }
    const frame = this.pendingFrames.get(timestamp);
    if (!frame) {
      return null;
    }

    if (isKeyframe) {
      frame.isKeyframe = true;
    }

    frame.packets.push({
      seq: header.sequenceNumber,
      data: payload.slice(1),
    });

    if (!header.marker) {
      return null;
    }

    this.pendingFrames.delete(timestamp);
    frame.packets.sort((a, b) => {
      const diff = (a.seq - b.seq) & 0xffff;
      return diff > 0x7fff ? diff - 0x10000 : diff;
    });

    const totalSize = frame.packets.reduce((sum, packet) => {
      return sum + packet.data.length;
    }, 0);
    const assembled = new Uint8Array(totalSize);
    let offset = 0;
    for (const packet of frame.packets) {
      assembled.set(packet.data, offset);
      offset += packet.data.length;
    }

    return {frame: assembled, isKeyframe: frame.isKeyframe, timestamp};
  }

  pruneOldFrames(maxAge: number = 30): void {
    while (this.pendingFrames.size > maxAge) {
      const oldest = this.pendingFrames.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.pendingFrames.delete(oldest);
    }
  }
}
