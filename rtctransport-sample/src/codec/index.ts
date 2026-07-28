// Codec Registry
// Unified interface for all supported audio and video codecs.

import { VP8_PAYLOAD_TYPE, VP8_CLOCK_RATE, Vp8Packetizer, Vp8Depacketizer } from './vp8-packetizer';
import { VP9_PAYLOAD_TYPE, VP9_CLOCK_RATE, Vp9Packetizer, Vp9Depacketizer } from './vp9-packetizer';
import { H264_PAYLOAD_TYPE, H264_CLOCK_RATE, H264Packetizer, H264Depacketizer } from './h264-packetizer';
import { HEVC_PAYLOAD_TYPE, HEVC_CLOCK_RATE, HevcPacketizer, HevcDepacketizer } from './hevc-packetizer';
import { AV1_PAYLOAD_TYPE, AV1_CLOCK_RATE, Av1Packetizer, Av1Depacketizer } from './av1-packetizer';
import { OPUS_PAYLOAD_TYPE, OPUS_CLOCK_RATE, OpusPacketizer, OpusDepacketizer } from './packetizer';
import { PCMU_PAYLOAD_TYPE, PCMA_PAYLOAD_TYPE, G711_CLOCK_RATE, G711Packetizer, G711Depacketizer } from './g711-packetizer';
import { AAC_PAYLOAD_TYPE, AAC_CLOCK_RATE, AacPacketizer, AacDepacketizer } from './aac-packetizer';

export type VideoCodecName = 'vp8' | 'vp9' | 'h264' | 'hevc' | 'av1';
export type AudioCodecName = 'opus' | 'pcmu' | 'pcma' | 'aac';
export type CodecName = VideoCodecName | AudioCodecName;

export interface CodecInfo {
  name: CodecName;
  payloadType: number;
  clockRate: number;
  kind: 'video' | 'audio';
  mimeType: string;
  /** WebCodecs codec string for use with VideoEncoder/VideoDecoder */
  webCodecsId?: string;
}

export const VIDEO_CODECS: Record<VideoCodecName, CodecInfo> = {
  vp8: {
    name: 'vp8',
    payloadType: VP8_PAYLOAD_TYPE,
    clockRate: VP8_CLOCK_RATE,
    kind: 'video',
    mimeType: 'video/VP8',
    webCodecsId: 'vp8',
  },
  vp9: {
    name: 'vp9',
    payloadType: VP9_PAYLOAD_TYPE,
    clockRate: VP9_CLOCK_RATE,
    kind: 'video',
    mimeType: 'video/VP9',
    webCodecsId: 'vp09.00.10.08',
  },
  h264: {
    name: 'h264',
    payloadType: H264_PAYLOAD_TYPE,
    clockRate: H264_CLOCK_RATE,
    kind: 'video',
    mimeType: 'video/H264',
    webCodecsId: 'avc1.42E01F', // Baseline profile, level 3.1
  },
  hevc: {
    name: 'hevc',
    payloadType: HEVC_PAYLOAD_TYPE,
    clockRate: HEVC_CLOCK_RATE,
    kind: 'video',
    mimeType: 'video/H265',
    webCodecsId: 'hev1.1.6.L93.B0',
  },
  av1: {
    name: 'av1',
    payloadType: AV1_PAYLOAD_TYPE,
    clockRate: AV1_CLOCK_RATE,
    kind: 'video',
    mimeType: 'video/AV1',
    webCodecsId: 'av01.0.04M.08',
  },
};

export const AUDIO_CODECS: Record<AudioCodecName, CodecInfo> = {
  opus: {
    name: 'opus',
    payloadType: OPUS_PAYLOAD_TYPE,
    clockRate: OPUS_CLOCK_RATE,
    kind: 'audio',
    mimeType: 'audio/opus',
    webCodecsId: 'opus',
  },
  pcmu: {
    name: 'pcmu',
    payloadType: PCMU_PAYLOAD_TYPE,
    clockRate: G711_CLOCK_RATE,
    kind: 'audio',
    mimeType: 'audio/PCMU',
  },
  pcma: {
    name: 'pcma',
    payloadType: PCMA_PAYLOAD_TYPE,
    clockRate: G711_CLOCK_RATE,
    kind: 'audio',
    mimeType: 'audio/PCMA',
  },
  aac: {
    name: 'aac',
    payloadType: AAC_PAYLOAD_TYPE,
    clockRate: AAC_CLOCK_RATE,
    kind: 'audio',
    mimeType: 'audio/mp4a-latm',
    webCodecsId: 'mp4a.40.2', // AAC-LC
  },
};

export const ALL_CODECS: Record<CodecName, CodecInfo> = {
  ...VIDEO_CODECS,
  ...AUDIO_CODECS,
};

/**
 * Get codec info by RTP payload type number.
 */
export function getCodecByPayloadType(pt: number): CodecInfo | undefined {
  for (const codec of Object.values(ALL_CODECS)) {
    if (codec.payloadType === pt) return codec;
  }
  return undefined;
}

/**
 * Get the SDP rtpmap line for a codec.
 * e.g., "96 VP8/90000" or "111 opus/48000/2"
 */
export function getSdpRtpmap(codec: CodecInfo): string {
  if (codec.name === 'opus') {
    return `${codec.payloadType} opus/${codec.clockRate}/2`;
  }
  if (codec.name === 'aac') {
    return `${codec.payloadType} mpeg4-generic/${codec.clockRate}/2`;
  }
  return `${codec.payloadType} ${codec.mimeType.split('/')[1]}/${codec.clockRate}`;
}

// Re-export all codec classes
export {
  Vp8Packetizer, Vp8Depacketizer,
  Vp9Packetizer, Vp9Depacketizer,
  H264Packetizer, H264Depacketizer,
  HevcPacketizer, HevcDepacketizer,
  Av1Packetizer, Av1Depacketizer,
  OpusPacketizer, OpusDepacketizer,
  G711Packetizer, G711Depacketizer,
  AacPacketizer, AacDepacketizer,
};
