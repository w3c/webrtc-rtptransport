// G.711 RTP Packetizer/Depacketizer (RFC 3551)
// G.711 µ-law (PCMU, PT=0) and A-law (PCMA, PT=8)
// One sample per byte, 8000 Hz sample rate, 20ms frames = 160 samples.
//
// G.711 is the most widely deployed audio codec in telephony/VoIP.
// No compression header - raw encoded samples go directly into RTP payload.

import { RtpSendStream } from '../rtp/rtp-session';

// Standard RTP payload types (RFC 3551)
export const PCMU_PAYLOAD_TYPE = 0;   // G.711 µ-law
export const PCMA_PAYLOAD_TYPE = 8;   // G.711 A-law
export const G711_CLOCK_RATE = 8000;
export const G711_FRAME_DURATION_MS = 20;
export const G711_SAMPLES_PER_FRAME = G711_CLOCK_RATE * G711_FRAME_DURATION_MS / 1000; // 160

export type G711Law = 'ulaw' | 'alaw';

/**
 * G.711 Packetizer - wraps PCM samples into RTP packets.
 * G.711 has no codec header; the entire RTP payload is encoded audio samples.
 */
export class G711Packetizer {
  private sendStream: RtpSendStream;
  private firstPacket: boolean = true;

  constructor(sendStream: RtpSendStream) {
    this.sendStream = sendStream;
  }

  /**
   * Packetize G.711 encoded samples into an RTP packet.
   * @param samples - G.711 encoded samples (1 byte per sample)
   */
  packetize(samples: Uint8Array): Uint8Array {
    const increment = this.firstPacket ? 0 : samples.length;
    this.firstPacket = false;
    // G.711: one sample = one timestamp unit, so increment = sample count
    return this.sendStream.createPacket(samples, increment, false);
  }
}

/**
 * G.711 Depacketizer - extracts samples from RTP payload.
 * Trivial: the entire payload IS the audio samples.
 */
export class G711Depacketizer {
  depacketize(rtpPayload: Uint8Array): Uint8Array {
    return rtpPayload;
  }
}

// ─── µ-law / A-law encoding/decoding tables ────────────────────────────────

// Bias for µ-law encoding
const ULAW_BIAS = 0x84;
const ULAW_CLIP = 32635;

/**
 * Encode a 16-bit linear PCM sample to 8-bit µ-law (G.711 PCMU).
 */
export function linearToUlaw(sample: number): number {
  // Get sign
  const sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > ULAW_CLIP) sample = ULAW_CLIP;
  sample += ULAW_BIAS;

  // Find segment
  const exponent = ULAW_SEGMENT_TABLE[((sample >> 7) & 0xFF)];
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return ulawByte;
}

/**
 * Decode 8-bit µ-law to 16-bit linear PCM.
 */
export function ulawToLinear(ulawByte: number): number {
  ulawByte = ~ulawByte & 0xFF;
  const sign = ulawByte & 0x80;
  const exponent = (ulawByte >> 4) & 0x07;
  const mantissa = ulawByte & 0x0F;
  let sample = ((mantissa << 3) + ULAW_BIAS) << exponent;
  sample -= ULAW_BIAS;
  return sign ? -sample : sample;
}

/**
 * Encode a 16-bit linear PCM sample to 8-bit A-law (G.711 PCMA).
 */
export function linearToAlaw(sample: number): number {
  let sign = 0;
  if (sample < 0) {
    sign = 0x55;
    sample = -sample - 1;
  } else {
    sign = 0xD5;
  }

  if (sample > 0x7FFF) sample = 0x7FFF;

  let exponent: number;
  let mantissa: number;

  if (sample >= 256) {
    exponent = ALAW_SEGMENT_TABLE[((sample >> 8) & 0x7F)];
    mantissa = (sample >> (exponent + 3)) & 0x0F;
  } else {
    exponent = 0;
    mantissa = (sample >> 4) & 0x0F;
  }

  return ((exponent << 4) | mantissa) ^ sign;
}

/**
 * Decode 8-bit A-law to 16-bit linear PCM.
 */
export function alawToLinear(alawByte: number): number {
  alawByte ^= 0x55;
  const sign = alawByte & 0x80;
  const exponent = (alawByte >> 4) & 0x07;
  const mantissa = alawByte & 0x0F;

  let sample: number;
  if (exponent > 0) {
    sample = ((mantissa << 4) + 0x108) << (exponent - 1);
  } else {
    sample = (mantissa << 4) + 8;
  }

  return sign ? sample : -sample;
}

/**
 * Convert a buffer of 16-bit PCM samples to µ-law encoded bytes.
 */
export function encodePcmToUlaw(pcm16: Int16Array): Uint8Array {
  const encoded = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    encoded[i] = linearToUlaw(pcm16[i]);
  }
  return encoded;
}

/**
 * Decode µ-law encoded bytes to 16-bit PCM samples.
 */
export function decodeUlawToPcm(ulaw: Uint8Array): Int16Array {
  const pcm = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) {
    pcm[i] = ulawToLinear(ulaw[i]);
  }
  return pcm;
}

/**
 * Convert a buffer of 16-bit PCM samples to A-law encoded bytes.
 */
export function encodePcmToAlaw(pcm16: Int16Array): Uint8Array {
  const encoded = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    encoded[i] = linearToAlaw(pcm16[i]);
  }
  return encoded;
}

/**
 * Decode A-law encoded bytes to 16-bit PCM samples.
 */
export function decodeAlawToPcm(alaw: Uint8Array): Int16Array {
  const pcm = new Int16Array(alaw.length);
  for (let i = 0; i < alaw.length; i++) {
    pcm[i] = alawToLinear(alaw[i]);
  }
  return pcm;
}

// Segment lookup table for µ-law encoding
const ULAW_SEGMENT_TABLE: number[] = (() => {
  const table = new Array(256);
  for (let i = 0; i < 256; i++) {
    let val = i;
    let seg = 0;
    while (val > 1 && seg < 7) {
      val >>= 1;
      seg++;
    }
    table[i] = seg;
  }
  return table;
})();

// Segment lookup table for A-law encoding
const ALAW_SEGMENT_TABLE: number[] = (() => {
  const table = new Array(128);
  for (let i = 0; i < 128; i++) {
    let val = i;
    let seg = 1;
    while (val > 1 && seg < 7) {
      val >>= 1;
      seg++;
    }
    table[i] = seg;
  }
  return table;
})();
