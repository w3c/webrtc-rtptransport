// SDP Parser & Utilities
// Parses SDP from a remote WebRTC peer to extract ICE, DTLS, and codec parameters.
// Supports multi-section SDP with fmtp, rtcp-fb, and header extensions.

// ─── Basic Types (backward-compatible) ──────────────────────────────────────

export interface ParsedIceCandidate {
  foundation: string;
  component: number;
  transport: string;
  priority: number;
  address: string;
  port: number;
  type: string;
}

export interface ParsedCodec {
  payloadType: number;
  codec: string;
  clockRate: number;
  channels: number;
  fmtp?: string;
  rtcpFeedback?: string[];
}

export interface ParsedSdp {
  iceUfrag: string;
  icePwd: string;
  fingerprint: string;
  fingerprintAlgorithm: string;
  setup: string;
  ssrcs: number[];
  candidates: ParsedIceCandidate[];
  codecs: ParsedCodec[];
  mid: string;
  mediaType: string;
}

// ─── Full Multi-Section Parsed SDP ──────────────────────────────────────────

export interface ParsedMediaSection {
  type: 'audio' | 'video';
  mid: string;
  direction: string;
  ssrcs: number[];
  codecs: ParsedCodec[];
  headerExtensions: Array<{ id: number; uri: string }>;
  /** Non-standard shim FEC payload type (from `a=x-shim-fec:<pt>`), if present. */
  fecPayloadType?: number;
}

export interface FullParsedSdp {
  iceUfrag: string;
  icePwd: string;
  fingerprint: string;
  fingerprintAlgorithm: string;
  setup: string;
  bundleGroup: string[];
  candidates: ParsedIceCandidate[];
  mediaSections: ParsedMediaSection[];
}

/**
 * Parse a full SDP into structured multi-section format.
 */
export function parseFullSdp(sdp: string): FullParsedSdp {
  const lines = sdp.split(/\r?\n/);

  const result: FullParsedSdp = {
    iceUfrag: '',
    icePwd: '',
    fingerprint: '',
    fingerprintAlgorithm: '',
    setup: '',
    bundleGroup: [],
    candidates: [],
    mediaSections: [],
  };

  let currentSection: ParsedMediaSection | null = null;

  for (const line of lines) {
    // Session-level attributes (before first m= or shared)
    if (line.startsWith('a=group:BUNDLE ')) {
      result.bundleGroup = line.substring('a=group:BUNDLE '.length).split(' ');
      continue;
    }

    if (line.startsWith('m=')) {
      // Start new media section
      if (currentSection) result.mediaSections.push(currentSection);
      const parts = line.substring(2).split(' ');
      currentSection = {
        type: parts[0] as 'audio' | 'video',
        mid: '',
        direction: 'sendrecv',
        ssrcs: [],
        codecs: [],
        headerExtensions: [],
      };
      continue;
    }

    if (line.startsWith('a=ice-ufrag:') && !result.iceUfrag) {
      result.iceUfrag = line.substring('a=ice-ufrag:'.length);
    } else if (line.startsWith('a=ice-pwd:') && !result.icePwd) {
      result.icePwd = line.substring('a=ice-pwd:'.length);
    } else if (line.startsWith('a=fingerprint:') && !result.fingerprint) {
      const fpParts = line.substring('a=fingerprint:'.length).split(' ');
      result.fingerprintAlgorithm = fpParts[0];
      result.fingerprint = fpParts.slice(1).join(' ');
    } else if (line.startsWith('a=setup:') && !result.setup) {
      result.setup = line.substring('a=setup:'.length);
    } else if (line.startsWith('a=mid:') && currentSection) {
      currentSection.mid = line.substring('a=mid:'.length);
    } else if (line.startsWith('a=ssrc:') && currentSection) {
      const ssrcMatch = line.match(/^a=ssrc:(\d+)/);
      if (ssrcMatch) {
        const ssrc = parseInt(ssrcMatch[1], 10);
        if (!currentSection.ssrcs.includes(ssrc)) {
          currentSection.ssrcs.push(ssrc);
        }
      }
    } else if (line.startsWith('a=candidate:')) {
      const candidate = parseIceCandidate(line);
      if (candidate) result.candidates.push(candidate);
    } else if (line.startsWith('a=rtpmap:') && currentSection) {
      const codec = parseRtpmap(line);
      if (codec) currentSection.codecs.push(codec);
    } else if (line.startsWith('a=fmtp:') && currentSection) {
      const match = line.match(/^a=fmtp:(\d+)\s+(.+)/);
      if (match) {
        const pt = parseInt(match[1], 10);
        const codec = currentSection.codecs.find(c => c.payloadType === pt);
        if (codec) codec.fmtp = match[2];
      }
    } else if (line.startsWith('a=rtcp-fb:') && currentSection) {
      const match = line.match(/^a=rtcp-fb:(\d+)\s+(.+)/);
      if (match) {
        const pt = parseInt(match[1], 10);
        const codec = currentSection.codecs.find(c => c.payloadType === pt);
        if (codec) {
          if (!codec.rtcpFeedback) codec.rtcpFeedback = [];
          codec.rtcpFeedback.push(match[2]);
        }
      }
    } else if (line.startsWith('a=extmap:') && currentSection) {
      const match = line.match(/^a=extmap:(\d+)\s+(.+)/);
      if (match) {
        currentSection.headerExtensions.push({
          id: parseInt(match[1], 10),
          uri: match[2],
        });
      }
    } else if (line.startsWith('a=x-shim-fec:') && currentSection) {
      const pt = parseInt(line.substring('a=x-shim-fec:'.length), 10);
      if (!Number.isNaN(pt)) currentSection.fecPayloadType = pt;
    } else if (currentSection) {
      // Direction attributes
      if (line === 'a=sendrecv' || line === 'a=sendonly' ||
          line === 'a=recvonly' || line === 'a=inactive') {
        currentSection.direction = line.substring(2);
      }
    }
  }

  if (currentSection) result.mediaSections.push(currentSection);
  return result;
}

// ─── Legacy single-section parser (backward-compatible) ─────────────────────

export function parseSdp(sdp: string): ParsedSdp {
  const full = parseFullSdp(sdp);
  const firstSection = full.mediaSections[0];

  return {
    iceUfrag: full.iceUfrag,
    icePwd: full.icePwd,
    fingerprint: full.fingerprint,
    fingerprintAlgorithm: full.fingerprintAlgorithm,
    setup: full.setup,
    ssrcs: full.mediaSections.flatMap(s => s.ssrcs),
    candidates: full.candidates,
    codecs: full.mediaSections.flatMap(s => s.codecs),
    mid: firstSection?.mid ?? '',
    mediaType: firstSection?.type ?? '',
  };
}

// ─── Utility Functions ──────────────────────────────────────────────────────

function parseIceCandidate(line: string): ParsedIceCandidate | null {
  const str = line.startsWith('a=') ? line.substring(2) : line;
  const parts = str.split(' ');
  if (parts.length < 8) return null;

  return {
    foundation: parts[0].split(':')[1],
    component: parseInt(parts[1], 10),
    transport: parts[2],
    priority: parseInt(parts[3], 10),
    address: parts[4],
    port: parseInt(parts[5], 10),
    type: parts[7],
  };
}

function parseRtpmap(line: string): ParsedCodec | null {
  const match = line.match(/^a=rtpmap:(\d+)\s+(\w+)\/(\d+)(?:\/(\d+))?/);
  if (!match) return null;

  return {
    payloadType: parseInt(match[1], 10),
    codec: match[2],
    clockRate: parseInt(match[3], 10),
    channels: match[4] ? parseInt(match[4], 10) : 1,
  };
}

export function parseFingerprint(hex: string): Uint8Array {
  const bytes = hex.split(':').map(h => parseInt(h, 16));
  return new Uint8Array(bytes);
}

export function getLocalSetupRole(remoteSetup: string): string {
  switch (remoteSetup) {
    case 'actpass': return 'active';
    case 'active': return 'passive';
    case 'passive': return 'active';
    default: return 'active';
  }
}

export function formatFingerprint(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
    .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(':');
}
