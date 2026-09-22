// H.264 RTP Packetizer/Depacketizer (RFC 6184)
// Supports Single NAL Unit Mode, STAP-A, and FU-A fragmentation.
//
// NAL Unit Header:
//   +---------------+
//   |0|1|2|3|4|5|6|7|
//   +-+-+-+-+-+-+-+-+
//   |F|NRI|  Type   |
//   +---------------+
// FU-A:
//   +---------------+---------------+
//   |  FU indicator |   FU header   |
//   +---------------+---------------+
//   FU indicator: F|NRI|Type=28
//   FU header: S|E|R|Type (original NAL type)

import type { RtpPacket } from '../rtp/rtp-packet';
import type { RtpSendStream } from '../rtp/rtp-session';

export const H264_PAYLOAD_TYPE = 102 as const;
export const H264_CLOCK_RATE = 90000 as const;
const MAX_RTP_PAYLOAD_SIZE = 1200;

const NAL_TYPE_IDR = 5;
const NAL_TYPE_SPS = 7;
const NAL_TYPE_STAP_A = 24;
const NAL_TYPE_FU_A = 28;

const NAL_START_CODE_4 = new Uint8Array([0, 0, 0, 1]);

interface PendingH264Packet {
  seq: number;
  data: Uint8Array;
}

interface PendingFuA {
  startSeq: number;
  parts: Uint8Array[];
}

interface PendingH264Frame {
  packets: PendingH264Packet[];
  timestamp: number;
  fuBuffer: PendingFuA|null;
}

export interface H264DepacketizedFrame {
  frame: Uint8Array;
  isKeyframe: boolean;
  timestamp: number;
}

export class H264Packetizer {
  sendStream: RtpSendStream;
  maxPayloadSize: number;
  firstFrame: boolean;

  constructor(
    sendStream: RtpSendStream,
    maxPayloadSize: number = MAX_RTP_PAYLOAD_SIZE,
  ) {
    this.sendStream = sendStream;
    this.maxPayloadSize = maxPayloadSize;
    this.firstFrame = true;
  }

  packetize(
    frame: Uint8Array,
    isKeyframe: boolean,
    timestampIncrement: number,
  ): Uint8Array[] {
    const packets: Uint8Array[] = [];
    const increment = this.firstFrame ? 0 : timestampIncrement;
    this.firstFrame = false;

    const nalUnits = this._splitNalUnits(frame);
    if (nalUnits.length === 0) {
      return packets;
    }

    for (let i = 0; i < nalUnits.length; ) {
      const tsIncrement = i === 0 ? increment : 0;
      const nalu = nalUnits[i];

      if (nalu.length > this.maxPayloadSize) {
        const isLastNalu = i === nalUnits.length - 1;
        packets.push(
          ...this._fragmentFuA(nalu, tsIncrement, isLastNalu),
        );
        i++;
        continue;
      }

      const stapUnits = [nalu];
      let stapSize = 1 + 2 + nalu.length;
      let nextIndex = i + 1;
      while (nextIndex < nalUnits.length &&
             nalUnits[nextIndex].length <= this.maxPayloadSize) {
        const candidateSize = stapSize + 2 + nalUnits[nextIndex].length;
        if (candidateSize > this.maxPayloadSize) {
          break;
        }
        stapUnits.push(nalUnits[nextIndex]);
        stapSize = candidateSize;
        nextIndex++;
      }

      if (stapUnits.length > 1) {
        const payload = this._buildStapA(stapUnits);
        const marker = nextIndex === nalUnits.length;
        packets.push(this.sendStream.createPacket(payload, tsIncrement, marker));
        i = nextIndex;
        continue;
      }

      const marker = i === nalUnits.length - 1;
      packets.push(this.sendStream.createPacket(nalu, tsIncrement, marker));
      i++;
    }

    if (isKeyframe && packets.length === 0) {
      return [];
    }

    return packets;
  }

  private _buildStapA(nalUnits: Uint8Array[]): Uint8Array {
    let totalSize = 1;
    for (const nalu of nalUnits) {
      totalSize += 2 + nalu.length;
    }

    let nri = 0;
    let forbiddenZeroBit = 0;
    for (const nalu of nalUnits) {
      forbiddenZeroBit |= nalu[0] & 0x80;
      nri = Math.max(nri, nalu[0] & 0x60);
    }

    const payload = new Uint8Array(totalSize);
    payload[0] = forbiddenZeroBit | nri | NAL_TYPE_STAP_A;

    let offset = 1;
    for (const nalu of nalUnits) {
      payload[offset] = (nalu.length >> 8) & 0xff;
      payload[offset + 1] = nalu.length & 0xff;
      offset += 2;
      payload.set(nalu, offset);
      offset += nalu.length;
    }

    return payload;
  }

  private _fragmentFuA(
    nalu: Uint8Array,
    firstTimestampIncrement: number,
    isLastNalu: boolean,
  ): Uint8Array[] {
    const packets: Uint8Array[] = [];
    const nalHeader = nalu[0];
    const nalType = nalHeader & 0x1f;
    const fuIndicator = (nalHeader & 0xe0) | NAL_TYPE_FU_A;

    const maxFragmentSize = this.maxPayloadSize - 2;
    const body = nalu.slice(1);
    const fragmentCount = Math.max(1, Math.ceil(body.length / maxFragmentSize));

    for (let i = 0; i < fragmentCount; i++) {
      const start = i * maxFragmentSize;
      const end = Math.min(start + maxFragmentSize, body.length);
      const fragment = body.slice(start, end);
      const isFirstFragment = i === 0;
      const isLastFragment = i === fragmentCount - 1;

      let fuHeader = nalType;
      if (isFirstFragment) {
        fuHeader |= 0x80;
      }
      if (isLastFragment) {
        fuHeader |= 0x40;
      }

      const payload = new Uint8Array(2 + fragment.length);
      payload[0] = fuIndicator;
      payload[1] = fuHeader;
      payload.set(fragment, 2);

      const tsIncrement = isFirstFragment ? firstTimestampIncrement : 0;
      const marker = isLastFragment && isLastNalu;
      packets.push(this.sendStream.createPacket(payload, tsIncrement, marker));
    }

    return packets;
  }

  private _splitNalUnits(frame: Uint8Array): Uint8Array[] {
    const nalUnits: Uint8Array[] = [];
    let offset = 0;
    let sawStartCode = false;

    while (offset < frame.length) {
      const startCodeLength = this._getStartCodeLength(frame, offset);
      if (startCodeLength === 0) {
        if (!sawStartCode) {
          nalUnits.push(frame);
        }
        break;
      }

      sawStartCode = true;
      offset += startCodeLength;
      const naluStart = offset;
      while (offset < frame.length &&
             this._getStartCodeLength(frame, offset) === 0) {
        offset++;
      }

      if (offset > naluStart) {
        nalUnits.push(frame.slice(naluStart, offset));
      }
    }

    return nalUnits.filter((nalu) => nalu.length > 0);
  }

  private _getStartCodeLength(frame: Uint8Array, offset: number): number {
    if (offset + 3 <= frame.length &&
        frame[offset] === 0 &&
        frame[offset + 1] === 0 &&
        frame[offset + 2] === 1) {
      return 3;
    }

    if (offset + 4 <= frame.length &&
        frame[offset] === 0 &&
        frame[offset + 1] === 0 &&
        frame[offset + 2] === 0 &&
        frame[offset + 3] === 1) {
      return 4;
    }

    return 0;
  }
}

export class H264Depacketizer {
  pendingFrames: Map<number, PendingH264Frame>;

  constructor() {
    this.pendingFrames = new Map();
  }

  depacketize(rtpPacket: RtpPacket): H264DepacketizedFrame | null {
    const {header, payload} = rtpPacket;
    if (payload.length < 1) {
      return null;
    }

    const nalType = payload[0] & 0x1f;
    const timestamp = header.timestamp;
    let frame = this.pendingFrames.get(timestamp);
    if (!frame) {
      frame = {
        packets: [],
        timestamp,
        fuBuffer: null,
      };
      this.pendingFrames.set(timestamp, frame);
    }

    if (nalType >= 1 && nalType <= 23) {
      frame.packets.push({seq: header.sequenceNumber, data: payload});
    } else if (nalType === NAL_TYPE_STAP_A) {
      let offset = 1;
      while (offset + 2 <= payload.length) {
        const naluSize = (payload[offset] << 8) | payload[offset + 1];
        offset += 2;
        if (offset + naluSize > payload.length) {
          return null;
        }
        frame.packets.push({
          seq: header.sequenceNumber,
          data: payload.slice(offset, offset + naluSize),
        });
        offset += naluSize;
      }
    } else if (nalType === NAL_TYPE_FU_A) {
      if (payload.length < 2) {
        return null;
      }

      const fuHeader = payload[1];
      const isStart = (fuHeader & 0x80) !== 0;
      const isEnd = (fuHeader & 0x40) !== 0;
      const originalNalType = fuHeader & 0x1f;

      if (isStart) {
        const nalHeader = (payload[0] & 0xe0) | originalNalType;
        frame.fuBuffer = {
          startSeq: header.sequenceNumber,
          parts: [new Uint8Array([nalHeader]), payload.slice(2)],
        };
      } else if (frame.fuBuffer) {
        frame.fuBuffer.parts.push(payload.slice(2));
      }

      if (isEnd && frame.fuBuffer) {
        const totalSize = frame.fuBuffer.parts.reduce((sum, part) => {
          return sum + part.length;
        }, 0);
        const assembled = new Uint8Array(totalSize);
        let offset = 0;
        for (const part of frame.fuBuffer.parts) {
          assembled.set(part, offset);
          offset += part.length;
        }
        frame.packets.push({seq: frame.fuBuffer.startSeq, data: assembled});
        frame.fuBuffer = null;
      }
    }

    if (!header.marker) {
      return null;
    }

    this.pendingFrames.delete(timestamp);
    if (frame.packets.length === 0) {
      return null;
    }

    frame.packets.sort((a, b) => {
      const diff = (a.seq - b.seq) & 0xffff;
      return diff > 0x7fff ? diff - 0x10000 : diff;
    });

    let totalSize = 0;
    for (const packet of frame.packets) {
      totalSize += NAL_START_CODE_4.length + packet.data.length;
    }

    const assembled = new Uint8Array(totalSize);
    let offset = 0;
    let isKeyframe = false;
    for (const packet of frame.packets) {
      const packetNalType = packet.data[0] & 0x1f;
      if (packetNalType === NAL_TYPE_IDR || packetNalType === NAL_TYPE_SPS) {
        isKeyframe = true;
      }
      assembled.set(NAL_START_CODE_4, offset);
      offset += NAL_START_CODE_4.length;
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
