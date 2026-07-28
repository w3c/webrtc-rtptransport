// AAC-LC RTP Packetizer/Depacketizer (RFC 3640)
// MPEG-4 Audio (AAC-LC) using mpeg4-generic RTP payload format.
// 48000 Hz sample rate, 1024 samples per frame, dynamic payload type.
//
// Each RTP packet contains a 4-byte AU header section:
//   2 bytes: AU-headers-length (in bits) = 16 (one 16-bit AU header)
//   2 bytes: AU-header = (AU-size << 3) | AU-Index
// followed by the raw AAC frame (Access Unit).

import { RtpSendStream } from '../rtp/rtp-session';

export const AAC_PAYLOAD_TYPE = 97;
export const AAC_CLOCK_RATE = 48000;
export const AAC_SAMPLES_PER_FRAME = 1024;

/**
 * AAC-LC Packetizer — wraps AAC frames into RTP packets with
 * RFC 3640 AU header section.
 */
export class AacPacketizer {
  private sendStream: RtpSendStream;
  private firstPacket: boolean = true;

  constructor(sendStream: RtpSendStream) {
    this.sendStream = sendStream;
  }

  /**
   * Packetize a single AAC Access Unit into an RTP packet.
   * @param aacFrame - Raw AAC-LC encoded frame
   */
  packetize(aacFrame: Uint8Array): Uint8Array {
    const increment = this.firstPacket ? 0 : AAC_SAMPLES_PER_FRAME;
    this.firstPacket = false;

    // Build AU header section (RFC 3640 §3.2.1)
    const auHeader = new Uint8Array(4);
    // AU-headers-length = 16 bits (one AU header of 16 bits)
    auHeader[0] = 0x00;
    auHeader[1] = 0x10; // 16 in decimal
    // AU-header: AU-size (13 bits) | AU-Index (3 bits)
    const auSize = aacFrame.length;
    auHeader[2] = (auSize >> 5) & 0xFF;
    auHeader[3] = ((auSize & 0x1F) << 3) & 0xFF; // AU-Index = 0

    // Payload = AU header section + AAC frame
    const payload = new Uint8Array(4 + aacFrame.length);
    payload.set(auHeader, 0);
    payload.set(aacFrame, 4);

    return this.sendStream.createPacket(payload, increment, false);
  }
}

/**
 * AAC-LC Depacketizer — extracts AAC frames from RTP packets
 * with RFC 3640 AU header section.
 */
export class AacDepacketizer {
  /**
   * Depacketize an RTP payload to extract the AAC Access Unit.
   * @param payload - RTP payload bytes
   * @returns The raw AAC frame
   */
  depacketize(payload: Uint8Array): Uint8Array {
    if (payload.length < 4) return new Uint8Array(0);

    // Read AU-headers-length (2 bytes, in bits)
    const auHeadersLengthBits = (payload[0] << 8) | payload[1];
    const auHeadersLengthBytes = Math.ceil(auHeadersLengthBits / 8);

    // Skip 2-byte length field + AU headers
    const dataOffset = 2 + auHeadersLengthBytes;
    if (dataOffset > payload.length) return new Uint8Array(0);

    return payload.slice(dataOffset);
  }
}
