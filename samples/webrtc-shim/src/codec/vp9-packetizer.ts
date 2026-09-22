// VP9 RTP Packetizer/Depacketizer (draft-ietf-payload-vp9)
//
// VP9 Payload Descriptor:
//       0 1 2 3 4 5 6 7
//      +-+-+-+-+-+-+-+-+
//      |I|P|L|F|B|E|V|Z| (required)
//      +-+-+-+-+-+-+-+-+
// I: PictureID present, P: Inter-picture predicted, L: Layer indices present
// F: Flexible mode, B: Start of frame, E: End of frame
// V: Scalability structure present, Z: Not a reference frame for upper layers

import type { RtpPacket } from '../rtp/rtp-packet';
import type { RtpSendStream } from '../rtp/rtp-session';

export const VP9_PAYLOAD_TYPE = 98 as const;
export const VP9_CLOCK_RATE = 90000 as const;
const MAX_RTP_PAYLOAD_SIZE = 1200;

interface PendingVp9Packet {
  seq: number;
  data: Uint8Array;
}

interface PendingVp9Frame {
  packets: PendingVp9Packet[];
  timestamp: number;
  isInterPredicted: boolean;
  spatialLayerId?: number;
  temporalLayerId?: number;
}

export interface Vp9DepacketizedFrame {
  frame: Uint8Array;
  isKeyframe: boolean;
  timestamp: number;
  spatialLayerId?: number;
  temporalLayerId?: number;
}

export class Vp9Packetizer {
  sendStream: RtpSendStream;
  maxPayloadSize: number;
  firstFrame: boolean;
  pictureId: number;

  constructor(
    sendStream: RtpSendStream,
    maxPayloadSize: number = MAX_RTP_PAYLOAD_SIZE,
  ) {
    this.sendStream = sendStream;
    this.maxPayloadSize = maxPayloadSize;
    this.firstFrame = true;
    this.pictureId = 0;
  }

  packetize(
    frame: Uint8Array,
    isKeyframe: boolean,
    timestampIncrement: number,
  ): Uint8Array[] {
    const packets: Uint8Array[] = [];
    const increment = this.firstFrame ? 0 : timestampIncrement;
    this.firstFrame = false;

    const descriptorSize = 3;
    const maxFragmentSize = this.maxPayloadSize - descriptorSize;
    const fragmentCount = Math.max(1, Math.ceil(frame.length / maxFragmentSize));

    for (let i = 0; i < fragmentCount; i++) {
      const start = i * maxFragmentSize;
      const end = Math.min(start + maxFragmentSize, frame.length);
      const fragment = frame.slice(start, end);
      const isFirst = i === 0;
      const isLast = i === fragmentCount - 1;

      const descriptor = this._buildDescriptor(isFirst, isLast, isKeyframe);
      const payload = new Uint8Array(descriptor.length + fragment.length);
      payload.set(descriptor, 0);
      payload.set(fragment, descriptor.length);

      const tsIncrement = isFirst ? increment : 0;
      const rtpPacket = this.sendStream.createPacket(payload, tsIncrement, isLast);
      packets.push(rtpPacket);
    }

    this.pictureId = (this.pictureId + 1) & 0x7fff;
    return packets;
  }

  private _buildDescriptor(
    isStart: boolean,
    isEnd: boolean,
    isKeyframe: boolean,
  ): Uint8Array {
    let byte0 = 0x80;
    if (!isKeyframe) {
      byte0 |= 0x40;
    }
    if (isStart) {
      byte0 |= 0x08;
    }
    if (isEnd) {
      byte0 |= 0x04;
    }

    const pidHigh = 0x80 | ((this.pictureId >> 8) & 0x7f);
    const pidLow = this.pictureId & 0xff;
    return new Uint8Array([byte0, pidHigh, pidLow]);
  }
}

export class Vp9Depacketizer {
  pendingFrames: Map<number, PendingVp9Frame>;

  constructor() {
    this.pendingFrames = new Map();
  }

  depacketize(rtpPacket: RtpPacket): Vp9DepacketizedFrame | null {
    const {header, payload} = rtpPacket;
    if (payload.length < 1) {
      return null;
    }

    let offset = 0;
    const byte0 = payload[offset++];
    const hasPictureId = (byte0 & 0x80) !== 0;
    const isInterPredicted = (byte0 & 0x40) !== 0;
    const hasLayerIndices = (byte0 & 0x20) !== 0;
    const isFlexibleMode = (byte0 & 0x10) !== 0;
    const hasScalabilityStructure = (byte0 & 0x02) !== 0;

    let temporalLayerId: number|undefined;
    let spatialLayerId: number|undefined;

    if (hasPictureId) {
      if (offset >= payload.length) {
        return null;
      }
      offset += (payload[offset] & 0x80) !== 0 ? 2 : 1;
      if (offset > payload.length) {
        return null;
      }
    }

    if (hasLayerIndices) {
      if (offset >= payload.length) {
        return null;
      }
      const layerByte = payload[offset++];
      temporalLayerId = (layerByte >> 5) & 0x07;
      spatialLayerId = (layerByte >> 1) & 0x07;
      if (!isFlexibleMode) {
        if (offset >= payload.length) {
          return null;
        }
        offset++;
      }
    }

    if (isFlexibleMode && isInterPredicted) {
      while (offset < payload.length) {
        const refByte = payload[offset++];
        if ((refByte & 0x01) === 0) {
          break;
        }
      }
    }

    if (hasScalabilityStructure) {
      if (offset >= payload.length) {
        return null;
      }
      const ssHeader = payload[offset++];
      const numSpatialLayers = ((ssHeader >> 5) & 0x07) + 1;
      const hasResolutionData = (ssHeader & 0x10) !== 0;
      const hasGroupDescription = (ssHeader & 0x08) !== 0;

      if (hasResolutionData) {
        const resolutionBytes = numSpatialLayers * 4;
        if (offset + resolutionBytes > payload.length) {
          return null;
        }
        offset += resolutionBytes;
      }

      if (hasGroupDescription) {
        if (offset >= payload.length) {
          return null;
        }
        const numFramesInGroup = payload[offset++];
        for (let i = 0; i < numFramesInGroup; i++) {
          if (offset >= payload.length) {
            return null;
          }
          const gofByte = payload[offset++];
          const numReferences = gofByte & 0x03;
          if (offset + numReferences > payload.length) {
            return null;
          }
          offset += numReferences;
        }
      }
    }

    if (offset >= payload.length) {
      return null;
    }

    const timestamp = header.timestamp;
    let frame = this.pendingFrames.get(timestamp);
    if (!frame) {
      frame = {
        packets: [],
        timestamp,
        isInterPredicted,
        spatialLayerId,
        temporalLayerId,
      };
      this.pendingFrames.set(timestamp, frame);
    } else {
      frame.isInterPredicted = isInterPredicted;
      frame.spatialLayerId ??= spatialLayerId;
      frame.temporalLayerId ??= temporalLayerId;
    }

    frame.packets.push({
      seq: header.sequenceNumber,
      data: payload.slice(offset),
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
    let assembledOffset = 0;
    for (const packet of frame.packets) {
      assembled.set(packet.data, assembledOffset);
      assembledOffset += packet.data.length;
    }

    return {
      frame: assembled,
      isKeyframe: !frame.isInterPredicted,
      timestamp: frame.timestamp,
      spatialLayerId: frame.spatialLayerId,
      temporalLayerId: frame.temporalLayerId,
    };
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
