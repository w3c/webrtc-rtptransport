// H.265/HEVC RTP Packetizer/Depacketizer (RFC 7798)
// HEVC uses a 2-byte NAL unit header:
//   +---------------+---------------+
//   |0|1|2|3|4|5|6|7|0|1|2|3|4|5|6|7|
//   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//   |F|   Type    |  LayerId  | TID |
//   +---------------+---------------+
// Packet types: AP (48), FU (49)
// FU header: S|E|FuType (6 bits)

import { RtpSendStream } from '../rtp/rtp-session';
import type { RtpPacket } from '../rtp/rtp-packet';

export const HEVC_PAYLOAD_TYPE = 104 as const;
export const HEVC_CLOCK_RATE = 90000 as const;
const MAX_RTP_PAYLOAD_SIZE = 1200;

// HEVC NAL unit types
const HEVC_NAL_BLA_W_LP = 16;
const HEVC_NAL_CRA_NUT = 21;
const HEVC_NAL_VPS = 32;
const HEVC_NAL_SPS = 33;
const HEVC_NAL_PPS = 34;
const HEVC_NAL_AP = 48;
const HEVC_NAL_FU = 49;

interface PendingHevcPacket {
  seq: number;
  data: Uint8Array;
}

interface PendingHevcFrame {
  packets: PendingHevcPacket[];
  timestamp: number;
  fuBuffer: Uint8Array[] | null;
}

export interface HevcDepacketizedFrame {
  frame: Uint8Array;
  isKeyframe: boolean;
  timestamp: number;
}

export class HevcPacketizer {
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
    void isKeyframe;

    const packets: Uint8Array[] = [];
    const increment = this.firstFrame ? 0 : timestampIncrement;
    this.firstFrame = false;

    const nalUnits = this._splitNalUnits(frame);

    for (let i = 0; i < nalUnits.length; ++i) {
      const nalu = nalUnits[i];
      const isLast = i === nalUnits.length - 1;

      if (nalu.length <= this.maxPayloadSize) {
        const tsInc = i === 0 ? increment : 0;
        packets.push(this.sendStream.createPacket(nalu, tsInc, isLast));
        continue;
      }

      packets.push(...this._fragmentFu(nalu, i === 0 ? increment : 0, isLast));
    }

    return packets;
  }

  private _fragmentFu(
    nalu: Uint8Array,
    firstTsIncrement: number,
    isLastNalu: boolean,
  ): Uint8Array[] {
    const packets: Uint8Array[] = [];
    const nalHeader0 = nalu[0];
    const nalHeader1 = nalu[1];
    const nalType = (nalHeader0 >> 1) & 0x3f;

    const fuPayloadHdr0 = (nalHeader0 & 0x81) | (HEVC_NAL_FU << 1);
    const fuPayloadHdr1 = nalHeader1;

    const maxFragmentSize = this.maxPayloadSize - 3;
    const bodyData = nalu.slice(2);
    const fragmentCount = Math.ceil(bodyData.length / maxFragmentSize);

    for (let i = 0; i < fragmentCount; ++i) {
      const start = i * maxFragmentSize;
      const end = Math.min(start + maxFragmentSize, bodyData.length);
      const fragment = bodyData.slice(start, end);
      const isFirst = i === 0;
      const isLast = i === fragmentCount - 1;

      let fuHeader = nalType & 0x3f;
      if (isFirst) {
        fuHeader |= 0x80;
      }
      if (isLast) {
        fuHeader |= 0x40;
      }

      const payload = new Uint8Array(3 + fragment.length);
      payload[0] = fuPayloadHdr0;
      payload[1] = fuPayloadHdr1;
      payload[2] = fuHeader;
      payload.set(fragment, 3);

      const tsInc = isFirst ? firstTsIncrement : 0;
      packets.push(
        this.sendStream.createPacket(payload, tsInc, isLast && isLastNalu),
      );
    }

    return packets;
  }

  private _splitNalUnits(frame: Uint8Array): Uint8Array[] {
    const nalUnits: Uint8Array[] = [];
    let offset = 0;

    while (offset < frame.length) {
      const startCodeLength = this._getStartCodeLength(frame, offset);
      if (startCodeLength === 0) {
        if (nalUnits.length === 0) {
          nalUnits.push(frame);
        }
        break;
      }

      offset += startCodeLength;
      const naluStart = offset;

      while (offset < frame.length &&
             this._getStartCodeLength(frame, offset) === 0) {
        ++offset;
      }

      if (offset > naluStart) {
        nalUnits.push(frame.slice(naluStart, offset));
      }
    }

    if (nalUnits.length === 0) {
      nalUnits.push(frame);
    }

    return nalUnits;
  }

  private _getStartCodeLength(data: Uint8Array, offset: number): number {
    if (offset + 3 <= data.length &&
        data[offset] === 0 &&
        data[offset + 1] === 0) {
      if (data[offset + 2] === 1) {
        return 3;
      }
      if (offset + 4 <= data.length &&
          data[offset + 2] === 0 &&
          data[offset + 3] === 1) {
        return 4;
      }
    }
    return 0;
  }

  static isKeyframeNalType(nalType: number): boolean {
    return (nalType >= HEVC_NAL_BLA_W_LP && nalType <= HEVC_NAL_CRA_NUT) ||
        nalType === HEVC_NAL_VPS || nalType === HEVC_NAL_SPS ||
        nalType === HEVC_NAL_PPS;
  }
}

export class HevcDepacketizer {
  private readonly pendingFrames: Map<number, PendingHevcFrame>;

  constructor() {
    this.pendingFrames = new Map();
  }

  depacketize(rtpPacket: RtpPacket): HevcDepacketizedFrame|null {
    const {header, payload} = rtpPacket;
    if (payload.length < 2) {
      return null;
    }

    const nalType = (payload[0] >> 1) & 0x3f;
    const timestamp = header.timestamp;

    if (!this.pendingFrames.has(timestamp)) {
      this.pendingFrames.set(
        timestamp,
        {packets: [], timestamp, fuBuffer: null},
      );
    }
    const frame = this.pendingFrames.get(timestamp);
    if (!frame) {
      return null;
    }

    if (nalType < HEVC_NAL_AP) {
      frame.packets.push({seq: header.sequenceNumber, data: payload});
    } else if (nalType === HEVC_NAL_AP) {
      let offset = 2;
      while (offset + 2 <= payload.length) {
        const naluSize = (payload[offset] << 8) | payload[offset + 1];
        offset += 2;
        if (offset + naluSize > payload.length) {
          break;
        }
        frame.packets.push({
          seq: header.sequenceNumber,
          data: payload.slice(offset, offset + naluSize),
        });
        offset += naluSize;
      }
    } else if (nalType === HEVC_NAL_FU) {
      if (payload.length < 3) {
        return null;
      }

      const fuHeader = payload[2];
      const isStart = (fuHeader & 0x80) !== 0;
      const isEnd = (fuHeader & 0x40) !== 0;
      const fuType = fuHeader & 0x3f;

      if (isStart) {
        const nalHeader0 = (payload[0] & 0x81) | (fuType << 1);
        const nalHeader1 = payload[1];
        frame.fuBuffer = [
          new Uint8Array([nalHeader0, nalHeader1]),
          payload.slice(3),
        ];
      } else if (frame.fuBuffer) {
        frame.fuBuffer.push(payload.slice(3));
      }

      if (isEnd && frame.fuBuffer) {
        const totalSize = frame.fuBuffer.reduce((sum, part) => {
          return sum + part.length;
        }, 0);
        const assembled = new Uint8Array(totalSize);
        let offset = 0;
        for (const part of frame.fuBuffer) {
          assembled.set(part, offset);
          offset += part.length;
        }
        frame.packets.push({seq: header.sequenceNumber, data: assembled});
        frame.fuBuffer = null;
      }
    }

    if (!header.marker) {
      return null;
    }

    this.pendingFrames.delete(timestamp);
    frame.packets.sort((a, b) => {
      const diff = (a.seq - b.seq) & 0xffff;
      return diff > 0x7fff ? diff - 0x10000 : diff;
    });

    let totalSize = 0;
    for (const packet of frame.packets) {
      totalSize += 4 + packet.data.length;
    }

    const assembled = new Uint8Array(totalSize);
    let offset = 0;
    let isKeyframe = false;
    for (const packet of frame.packets) {
      const packetNalType = (packet.data[0] >> 1) & 0x3f;
      if (HevcPacketizer.isKeyframeNalType(packetNalType)) {
        isKeyframe = true;
      }

      assembled[offset] = 0;
      assembled[offset + 1] = 0;
      assembled[offset + 2] = 0;
      assembled[offset + 3] = 1;
      offset += 4;

      assembled.set(packet.data, offset);
      offset += packet.data.length;
    }

    return {frame: assembled, isKeyframe, timestamp: frame.timestamp};
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
