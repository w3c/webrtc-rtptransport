// SDP Parser & Utilities
// Parses SDP from a remote WebRTC peer to extract ICE, DTLS, and codec parameters.

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

export function parseSdp(sdp: string): ParsedSdp {
  const lines = sdp.split(/\r?\n/);

  const result: ParsedSdp = {
    iceUfrag: '',
    icePwd: '',
    fingerprint: '',
    fingerprintAlgorithm: '',
    setup: '',
    ssrcs: [],
    candidates: [],
    codecs: [],
    mid: '',
    mediaType: '',
  };

  let inMediaSection = false;

  for (const line of lines) {
    if (line.startsWith('m=')) {
      inMediaSection = true;
      const parts = line.substring(2).split(' ');
      result.mediaType = parts[0];
    }

    if (line.startsWith('a=ice-ufrag:')) {
      result.iceUfrag = line.substring('a=ice-ufrag:'.length);
    } else if (line.startsWith('a=ice-pwd:')) {
      result.icePwd = line.substring('a=ice-pwd:'.length);
    } else if (line.startsWith('a=fingerprint:')) {
      const fpParts = line.substring('a=fingerprint:'.length).split(' ');
      result.fingerprintAlgorithm = fpParts[0];
      result.fingerprint = fpParts.slice(1).join(' ');
    } else if (line.startsWith('a=setup:')) {
      result.setup = line.substring('a=setup:'.length);
    } else if (line.startsWith('a=mid:')) {
      result.mid = line.substring('a=mid:'.length);
    } else if (line.startsWith('a=ssrc:')) {
      const ssrcMatch = line.match(/^a=ssrc:(\d+)/);
      if (ssrcMatch) {
        const ssrc = parseInt(ssrcMatch[1], 10);
        if (!result.ssrcs.includes(ssrc)) {
          result.ssrcs.push(ssrc);
        }
      }
    } else if (line.startsWith('a=candidate:')) {
      const candidate = parseIceCandidate(line);
      if (candidate) {
        result.candidates.push(candidate);
      }
    } else if (line.startsWith('a=rtpmap:')) {
      const codec = parseRtpmap(line);
      if (codec) {
        result.codecs.push(codec);
      }
    }
  }

  return result;
}

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
