// Opus Audio Packetizer/Depacketizer
// Opus in RTP: RFC 7587
// One Opus frame per RTP packet, payload type 111, 48kHz clock rate.

import type { RtpSendStream } from '../rtp/rtp-session';

// Standard Opus RTP parameters
export const OPUS_PAYLOAD_TYPE = 111 as const;
export const OPUS_CLOCK_RATE = 48000 as const;
export const OPUS_FRAME_DURATION_MS = 20 as const;
export const OPUS_SAMPLES_PER_FRAME = 960 as const;

/**
 * Opus Packetizer - wraps encoded Opus frames into RTP packets.
 */
export class OpusPacketizer {
  sendStream: RtpSendStream;
  firstPacket: boolean;

  constructor(sendStream: RtpSendStream) {
    this.sendStream = sendStream;
    this.firstPacket = true;
  }

  /**
   * Packetize an Opus encoded frame into an RTP packet.
   * @param opusFrame - Encoded Opus frame
   * @returns Serialized RTP packet
   */
  packetize(opusFrame: Uint8Array): Uint8Array {
    // Opus uses 48kHz clock. Each 20ms frame = 960 timestamp units.
    // First packet gets 0 increment (timestamp was initialized randomly).
    const increment = this.firstPacket ? 0 : OPUS_SAMPLES_PER_FRAME;
    this.firstPacket = false;

    // Marker bit is set on the first packet of a talkspurt (after silence).
    // For simplicity in Phase 1, we don't track VAD; marker is always false.
    return this.sendStream.createPacket(opusFrame, increment, false);
  }
}

/**
 * Opus Depacketizer - extracts Opus frames from RTP packets.
 */
export class OpusDepacketizer {
  /**
   * Extract the Opus frame from an RTP packet payload.
   * For Opus, the entire RTP payload is a single Opus packet.
   * @param rtpPayload - RTP payload bytes
   * @returns Opus encoded frame
   */
  depacketize(rtpPayload: Uint8Array): Uint8Array {
    // RFC 7587: The RTP payload contains exactly one Opus packet.
    return rtpPayload;
  }
}
