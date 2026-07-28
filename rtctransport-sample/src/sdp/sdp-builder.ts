// SDP Builder
// Creates minimal SDP offer/answer compatible with standard WebRTC peers.

import { OPUS_PAYLOAD_TYPE, OPUS_CLOCK_RATE } from '../codec/packetizer';

export interface AudioOfferParams {
  iceUfrag: string;
  icePwd: string;
  fingerprint: string;
  fingerprintAlgorithm: string;
  setup: string;
  ssrc: number;
  sessionId?: string;
}

export function buildAudioOffer(params: AudioOfferParams): string {
  const {
    iceUfrag,
    icePwd,
    fingerprint,
    fingerprintAlgorithm,
    setup,
    ssrc,
    sessionId = Math.floor(Date.now() / 1000).toString(),
  } = params;

  const lines: string[] = [
    'v=0',
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS local',
    `m=audio 9 UDP/TLS/RTP/SAVPF ${OPUS_PAYLOAD_TYPE}`,
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    `a=ice-ufrag:${iceUfrag}`,
    `a=ice-pwd:${icePwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:${fingerprintAlgorithm} ${fingerprint}`,
    `a=setup:${setup}`,
    'a=mid:0',
    'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
    'a=sendrecv',
    'a=rtcp-mux',
    `a=rtpmap:${OPUS_PAYLOAD_TYPE} opus/${OPUS_CLOCK_RATE}/2`,
    `a=fmtp:${OPUS_PAYLOAD_TYPE} minptime=10;useinbandfec=1`,
    `a=ssrc:${ssrc} cname:rtctransport`,
    `a=ssrc:${ssrc} msid:local audio0`,
  ];

  return lines.join('\r\n') + '\r\n';
}

export function buildAudioAnswer(params: AudioOfferParams): string {
  return buildAudioOffer(params);
}

export function formatFingerprint(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
    .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(':');
}
