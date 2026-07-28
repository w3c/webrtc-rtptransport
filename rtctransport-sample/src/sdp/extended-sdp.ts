// Extended SDP Builder (Phase 2)
// Supports video codecs, RTX, and RTP header extensions in SDP.

import { OPUS_PAYLOAD_TYPE, OPUS_CLOCK_RATE } from '../codec/packetizer';
import { VP8_PAYLOAD_TYPE, VP8_CLOCK_RATE } from '../codec/vp8-packetizer';

const OPUS_RTX_PT = 112;
const VP8_RTX_PT = 97;

export interface FullOfferParams {
  iceUfrag: string;
  icePwd: string;
  fingerprint: string;
  fingerprintAlgorithm: string;
  setup: string;
  audioSsrc: number;
  audioRtxSsrc: number;
  videoSsrc: number;
  videoRtxSsrc: number;
  includeVideo?: boolean;
  sessionId?: string;
}

export interface ExtendedSdpInfo {
  audio: { ssrc: number; rtxSsrc: number; payloadTypes: number[] };
  video: { ssrc: number; rtxSsrc: number; payloadTypes: number[]; feedbacks: string[] };
  extensions: Array<{ id: number; uri: string }>;
}

export function buildFullOffer(params: FullOfferParams): string {
  const {
    iceUfrag,
    icePwd,
    fingerprint,
    fingerprintAlgorithm,
    setup,
    audioSsrc,
    audioRtxSsrc,
    videoSsrc,
    videoRtxSsrc,
    includeVideo = true,
    sessionId = Math.floor(Date.now() / 1000).toString(),
  } = params;

  const bundleIds = includeVideo ? '0 1' : '0';
  const lines: string[] = [
    'v=0',
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${bundleIds}`,
    'a=msid-semantic: WMS local',
    `m=audio 9 UDP/TLS/RTP/SAVPF ${OPUS_PAYLOAD_TYPE} ${OPUS_RTX_PT}`,
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    `a=ice-ufrag:${iceUfrag}`,
    `a=ice-pwd:${icePwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:${fingerprintAlgorithm} ${fingerprint}`,
    `a=setup:${setup}`,
    'a=mid:0',
    'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
    'a=extmap:4 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
    'a=sendrecv',
    'a=rtcp-mux',
    'a=rtcp-rsize',
    `a=rtpmap:${OPUS_PAYLOAD_TYPE} opus/${OPUS_CLOCK_RATE}/2`,
    `a=fmtp:${OPUS_PAYLOAD_TYPE} minptime=10;useinbandfec=1`,
    `a=rtpmap:${OPUS_RTX_PT} rtx/${OPUS_CLOCK_RATE}`,
    `a=fmtp:${OPUS_RTX_PT} apt=${OPUS_PAYLOAD_TYPE}`,
    `a=ssrc-group:FID ${audioSsrc} ${audioRtxSsrc}`,
    `a=ssrc:${audioSsrc} cname:rtctransport`,
    `a=ssrc:${audioSsrc} msid:local audio0`,
    `a=ssrc:${audioRtxSsrc} cname:rtctransport`,
    `a=ssrc:${audioRtxSsrc} msid:local audio0`,
  ];

  if (includeVideo) {
    lines.push(
      `m=video 9 UDP/TLS/RTP/SAVPF ${VP8_PAYLOAD_TYPE} ${VP8_RTX_PT}`,
      'c=IN IP4 0.0.0.0',
      'a=rtcp:9 IN IP4 0.0.0.0',
      `a=ice-ufrag:${iceUfrag}`,
      `a=ice-pwd:${icePwd}`,
      'a=ice-options:trickle',
      `a=fingerprint:${fingerprintAlgorithm} ${fingerprint}`,
      `a=setup:${setup}`,
      'a=mid:1',
      'a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
      'a=extmap:4 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
      'a=extmap:6 urn:3gpp:video-orientation',
      'a=sendrecv',
      'a=rtcp-mux',
      'a=rtcp-rsize',
      'a=rtcp-fb:96 nack',
      'a=rtcp-fb:96 nack pli',
      'a=rtcp-fb:96 ccm fir',
      'a=rtcp-fb:96 transport-cc',
      `a=rtpmap:${VP8_PAYLOAD_TYPE} VP8/${VP8_CLOCK_RATE}`,
      `a=rtpmap:${VP8_RTX_PT} rtx/${VP8_CLOCK_RATE}`,
      `a=fmtp:${VP8_RTX_PT} apt=${VP8_PAYLOAD_TYPE}`,
      `a=ssrc-group:FID ${videoSsrc} ${videoRtxSsrc}`,
      `a=ssrc:${videoSsrc} cname:rtctransport`,
      `a=ssrc:${videoSsrc} msid:local video0`,
      `a=ssrc:${videoRtxSsrc} cname:rtctransport`,
      `a=ssrc:${videoRtxSsrc} msid:local video0`,
    );
  }

  return lines.join('\r\n') + '\r\n';
}

export function parseExtendedSdp(sdp: string): ExtendedSdpInfo {
  const lines = sdp.split(/\r?\n/);
  const result: ExtendedSdpInfo = {
    audio: { ssrc: 0, rtxSsrc: 0, payloadTypes: [] },
    video: { ssrc: 0, rtxSsrc: 0, payloadTypes: [], feedbacks: [] },
    extensions: [],
  };

  let currentMedia: 'audio' | 'video' | null = null;

  for (const line of lines) {
    if (line.startsWith('m=audio')) {
      currentMedia = 'audio';
    } else if (line.startsWith('m=video')) {
      currentMedia = 'video';
    }

    if (line.startsWith('a=ssrc-group:FID ')) {
      const parts = line.substring('a=ssrc-group:FID '.length).split(' ');
      if (parts.length >= 2 && currentMedia) {
        result[currentMedia].ssrc = parseInt(parts[0], 10);
        result[currentMedia].rtxSsrc = parseInt(parts[1], 10);
      }
    }

    if (line.startsWith('a=rtcp-fb:') && currentMedia === 'video') {
      result.video.feedbacks.push(line.substring('a=rtcp-fb:'.length));
    }

    if (line.startsWith('a=extmap:')) {
      const match = line.match(/^a=extmap:(\d+)\s+(.+)/);
      if (match) {
        result.extensions.push({ id: parseInt(match[1], 10), uri: match[2] });
      }
    }
  }

  return result;
}
