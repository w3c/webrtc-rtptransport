// SDP Builder
// Generates SDP offer/answer for RtcTransport ↔ WebRTC interop.
// Supports multi-codec, RTCP feedback, fmtp, BUNDLE, and trickle ICE.

import { type CodecInfo, getSdpRtpmap } from '../codec/index';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SdpSessionParams {
  /** Local ICE username fragment. */
  iceUfrag: string;
  /** Local ICE password. */
  icePwd: string;
  /** DTLS certificate fingerprint hex string (XX:XX:...). */
  fingerprint: string;
  /** Fingerprint digest algorithm (e.g., 'sha-256'). */
  fingerprintAlgorithm: string;
  /** DTLS setup role: 'actpass' (offer), 'active' (answer), 'passive'. */
  setup: string;
  /** Session ID (numeric string, typically timestamp). */
  sessionId?: string;
  /** Session version (default: 2). */
  sessionVersion?: number;
}

export interface SdpMediaSection {
  /** Media type: 'audio' or 'video'. */
  type: 'audio' | 'video';
  /** Media ID for BUNDLE grouping. */
  mid: string;
  /** Send/receive direction. */
  direction: 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';
  /** Primary SSRC. */
  ssrc: number;
  /** CNAME for RTCP. */
  cname?: string;
  /** MSID stream and track labels. */
  msid?: { stream: string; track: string };
  /** Codecs to include (first = preferred). */
  codecs: CodecInfo[];
  /** RTCP feedback messages to declare per video codec. */
  rtcpFeedback?: string[];
  /** RTP header extensions. */
  headerExtensions?: Array<{ id: number; uri: string }>;
}

export interface SdpBuildOptions {
  session: SdpSessionParams;
  media: SdpMediaSection[];
  /** ICE candidates to include inline (optional — use trickle for the rest). */
  candidates?: string[];
}

// ─── Builder ────────────────────────────────────────────────────────────────

/**
 * Build a complete SDP string from structured parameters.
 */
export function buildSdp(options: SdpBuildOptions): string {
  const {session, media, candidates} = options;
  const sessionId = session.sessionId ?? Math.floor(Date.now() / 1000).toString();
  const sessionVersion = session.sessionVersion ?? 2;

  const lines: string[] = [];

  // Session-level lines
  lines.push('v=0');
  lines.push(`o=- ${sessionId} ${sessionVersion} IN IP4 127.0.0.1`);
  lines.push('s=-');
  lines.push('t=0 0');

  // BUNDLE group
  const mids = media.map(m => m.mid).join(' ');
  lines.push(`a=group:BUNDLE ${mids}`);
  lines.push('a=msid-semantic: WMS local');

  // Media sections
  for (const section of media) {
    buildMediaSection(lines, section, session, candidates);
  }

  return lines.join('\r\n') + '\r\n';
}

function buildMediaSection(
    lines: string[],
    section: SdpMediaSection,
    session: SdpSessionParams,
    candidates?: string[]): void {
  const payloadTypes = section.codecs.map(c => c.payloadType).join(' ');

  // m= line
  lines.push(`m=${section.type} 9 UDP/TLS/RTP/SAVPF ${payloadTypes}`);
  lines.push('c=IN IP4 0.0.0.0');
  lines.push('a=rtcp:9 IN IP4 0.0.0.0');

  // ICE
  lines.push(`a=ice-ufrag:${session.iceUfrag}`);
  lines.push(`a=ice-pwd:${session.icePwd}`);
  lines.push('a=ice-options:trickle');

  // DTLS
  lines.push(`a=fingerprint:${session.fingerprintAlgorithm} ${session.fingerprint}`);
  lines.push(`a=setup:${session.setup}`);

  // MID
  lines.push(`a=mid:${section.mid}`);

  // Header extensions
  if (section.headerExtensions) {
    for (const ext of section.headerExtensions) {
      lines.push(`a=extmap:${ext.id} ${ext.uri}`);
    }
  }

  // Direction
  lines.push(`a=${section.direction}`);
  lines.push('a=rtcp-mux');

  if (section.type === 'video') {
    lines.push('a=rtcp-rsize');
  }

  // Codecs
  for (const codec of section.codecs) {
    lines.push(`a=rtpmap:${getSdpRtpmap(codec)}`);

    // fmtp
    const fmtp = buildFmtp(codec);
    if (fmtp) lines.push(fmtp);

    // RTCP feedback (video codecs)
    if (section.type === 'video' && section.rtcpFeedback) {
      for (const fb of section.rtcpFeedback) {
        lines.push(`a=rtcp-fb:${codec.payloadType} ${fb}`);
      }
    }
  }

  // SSRC
  const cname = section.cname ?? 'rtctransport';
  const msidStream = section.msid?.stream ?? 'local';
  const msidTrack = section.msid?.track ?? `${section.type}0`;
  lines.push(`a=ssrc:${section.ssrc} cname:${cname}`);
  lines.push(`a=ssrc:${section.ssrc} msid:${msidStream} ${msidTrack}`);

  // Inline candidates
  if (candidates) {
    for (const c of candidates) {
      lines.push(`a=${c}`);
    }
  }
}

function buildFmtp(codec: CodecInfo): string | null {
  const pt = codec.payloadType;
  switch (codec.name) {
    case 'opus':
      return `a=fmtp:${pt} minptime=10;useinbandfec=1`;
    case 'h264':
      return `a=fmtp:${pt} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42E01F`;
    case 'hevc':
      return `a=fmtp:${pt} profile-id=1;tier-flag=0;level-id=93`;
    case 'vp9':
      return `a=fmtp:${pt} profile-id=0`;
    case 'aac':
      return `a=fmtp:${pt} streamtype=5;profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=1190`;
    default:
      return null;
  }
}

// ─── Standard RTCP Feedback Sets ────────────────────────────────────────────

/** Default RTCP feedback for video codecs (NACK, PLI, FIR). */
export const VIDEO_RTCP_FEEDBACK = [
  'nack',
  'nack pli',
  'ccm fir',
  'transport-cc',
];

/** Default header extensions for audio. */
export const AUDIO_HEADER_EXTENSIONS = [
  {id: 1, uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level'},
];

/** Default header extensions for video. */
export const VIDEO_HEADER_EXTENSIONS = [
  {id: 2, uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time'},
  {id: 3, uri: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'},
];
