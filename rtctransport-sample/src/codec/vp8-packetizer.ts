// VP8 RTP Packetizer (RFC 7741)
// Fragments VP8 encoded frames into RTP packets with VP8 payload descriptor.
//
// VP8 Payload Descriptor (minimal):
//  0 1 2 3 4 5 6 7
// +-+-+-+-+-+-+-+-+
// |X|R|N|S|R| PID |  (Required)
// +-+-+-+-+-+-+-+-+
// X: Extension bit, R: Reserved, N: Non-reference frame
// S: Start of VP8 partition, PID: Partition index

import type { RtpPacket } from '../rtp/rtp-packet';
import type { RtpSendStream } from '../rtp/rtp-session';

export const VP8_PAYLOAD_TYPE = 96 as const;
export const VP8_CLOCK_RATE = 90000 as const;
const MAX_RTP_PAYLOAD_SIZE = 1200; // MTU-safe

interface PendingVp8Packet {
  seq: number;
  data: Uint8Array;
  isStart: boolean;
}

interface PendingVp8Frame {
  packets: PendingVp8Packet[];
  timestamp: number;
}

export interface Vp8DepacketizedFrame {
  frame: Uint8Array;
  isKeyframe: boolean;
  timestamp: number;
}

/**
 * VP8 Packetizer - fragments VP8 frames into RTP packets.
 */
export class Vp8Packetizer {
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

  /**
   * Packetize a VP8 encoded frame into one or more RTP packets.
   * @param frame - VP8 encoded frame
   * @param isKeyframe - Whether this is a keyframe
   * @param timestampIncrement - RTP timestamp increment (e.g., 3000 for 30fps)
   * @returns Array of serialized RTP packets
   */
  packetize(
    frame: Uint8Array,
    isKeyframe: boolean,
    timestampIncrement: number,
  ): Uint8Array[] {
    const packets: Uint8Array[] = [];
    const increment = this.firstFrame ? 0 : timestampIncrement;
    this.firstFrame = false;

    // VP8 payload descriptor size (minimal = 1 byte)
    const descriptorSize = 1;
    const maxFragmentSize = this.maxPayloadSize - descriptorSize;
    const fragmentCount = Math.ceil(frame.length / maxFragmentSize);

    for (let i = 0; i < fragmentCount; i++) {
      const start = i * maxFragmentSize;
      const end = Math.min(start + maxFragmentSize, frame.length);
      const fragment = frame.slice(start, end);
      const isFirst = i === 0;
      const isLast = i === fragmentCount - 1;

      // Build VP8 payload descriptor
      const descriptor = this._buildDescriptor(isFirst, isKeyframe);

      // Combine descriptor + fragment
      const payload = new Uint8Array(descriptor.length + fragment.length);
      payload.set(descriptor, 0);
      payload.set(fragment, descriptor.length);

      // Only first fragment gets 0 increment; rest use same timestamp (0 increment)
      const tsInc = isFirst ? increment : 0;
      const marker = isLast; // Marker bit set on last packet of frame

      const rtpPacket = this.sendStream.createPacket(payload, tsInc, marker);
      packets.push(rtpPacket);
    }

    return packets;
  }

  private _buildDescriptor(
    isStartOfPartition: boolean,
    isKeyframe: boolean,
  ): Uint8Array {
    // Minimal VP8 payload descriptor (1 byte)
    let byte0 = 0;
    // X=0 (no extension), R=0, N=0 (reference frame by default)
    if (isStartOfPartition) {
      byte0 |= 0x10; // S=1
    }
    // PID=0 (partition 0)
    // N bit: set for non-reference frames
    if (!isKeyframe) {
      byte0 |= 0x20; // N=1
    }

    return new Uint8Array([byte0]);
  }
}

/**
 * VP8 Depacketizer - reassembles VP8 frames from RTP packets.
 */
export class Vp8Depacketizer {
  pendingFrames: Map<number, PendingVp8Frame>;

  constructor() {
    this.pendingFrames = new Map();
  }

  /**
   * Process an RTP packet and return a complete frame if available.
   * @param rtpPacket
   * @returns
   */
  depacketize(rtpPacket: RtpPacket): Vp8DepacketizedFrame | null {
    const { header, payload } = rtpPacket;
    if (payload.length < 1) {
      return null;
    }

    // Parse VP8 payload descriptor (RFC 7741 §4.2)
    let offset = 0;
    const byte0 = payload[offset++];
    const hasExtension = (byte0 & 0x80) !== 0; // X bit
    const isStart = (byte0 & 0x10) !== 0; // S bit

    if (hasExtension && offset < payload.length) {
      const extByte = payload[offset++];
      const hasI = (extByte & 0x80) !== 0; // I: PictureID present
      const hasL = (extByte & 0x40) !== 0; // L: TL0PICIDX present
      const hasT = (extByte & 0x20) !== 0; // T/K: TID/KEYIDX present

      if (hasI && offset < payload.length) {
        // PictureID: 1 byte if M=0, 2 bytes if M=1
        if (payload[offset] & 0x80) {
          offset += 2; // 15-bit PictureID
        } else {
          offset += 1; // 7-bit PictureID
        }
      }
      if (hasL && offset < payload.length) {
        offset += 1; // TL0PICIDX
      }
      if (hasT && offset < payload.length) {
        offset += 1; // TID/Y/KEYIDX
      }
    }

    if (offset >= payload.length) {
      return null;
    }
    const frameData = payload.slice(offset);

    const timestamp = header.timestamp;

    if (!this.pendingFrames.has(timestamp)) {
      this.pendingFrames.set(timestamp, { packets: [], timestamp });
    }
    const frame = this.pendingFrames.get(timestamp);
    if (!frame) {
      return null;
    }
    frame.packets.push({ seq: header.sequenceNumber, data: frameData, isStart });

    // Check if frame is complete (marker bit set = last packet)
    if (header.marker) {
      this.pendingFrames.delete(timestamp);

      // Sort by sequence number and concatenate
      frame.packets.sort((a, b) => {
        const diff = (a.seq - b.seq) & 0xffff;
        return diff > 0x7fff ? diff - 0x10000 : diff;
      });

      const totalSize = frame.packets.reduce((sum, packet) => {
        return sum + packet.data.length;
      }, 0);
      const assembled = new Uint8Array(totalSize);
      let offset2 = 0;
      for (const packet of frame.packets) {
        assembled.set(packet.data, offset2);
        offset2 += packet.data.length;
      }

      // Detect keyframe from VP8 bitstream:
      // First byte of VP8 payload: bit 0 = 0 means keyframe (inverse_is_interframe)
      const isKeyframe = assembled.length >= 3 && (assembled[0] & 0x01) === 0;

      return { frame: assembled, isKeyframe, timestamp };
    }

    return null;
  }

  /**
   * Clear incomplete frames older than a threshold.
   * @param maxAgePackets - Max frames to keep pending
   */
  pruneOldFrames(maxAgePackets: number = 30): void {
    while (this.pendingFrames.size > maxAgePackets) {
      const oldest = this.pendingFrames.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.pendingFrames.delete(oldest);
    }
  }
}
