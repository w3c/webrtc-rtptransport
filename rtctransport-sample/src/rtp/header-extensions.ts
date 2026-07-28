// RTP Header Extensions (RFC 5285)
// Supports one-byte and two-byte header extension formats.

export interface HeaderExtension {
  id: number;
  data: Uint8Array;
}

export interface AudioLevelInfo {
  vad: boolean;
  level: number;
}

// Well-known extension URIs and their typical IDs
export const EXTENSION_URIS = {
  ABS_SEND_TIME: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
  TRANSPORT_CC:
      'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  AUDIO_LEVEL: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level',
  VIDEO_ORIENTATION: 'urn:3gpp:video-orientation',
  PLAYOUT_DELAY: 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay',
} as const;

// One-byte header extension profile
const ONE_BYTE_PROFILE = 0xBEDE;
// Two-byte header extension profile
const TWO_BYTE_PROFILE = 0x1000;

/**
 * Parse RTP header extensions from extension data.
 * @param profile Extension profile from RTP header
 * @param data Extension data bytes
 * @returns
 */
export function parseHeaderExtensions(
    profile: number, data: Uint8Array): HeaderExtension[] {
  if (profile === ONE_BYTE_PROFILE) {
    return parseOneByte(data);
  } else if ((profile & 0xFFF0) === TWO_BYTE_PROFILE) {
    return parseTwoByte(data);
  }
  return [];
}

/**
 * Serialize header extensions in one-byte format.
 * @param extensions
 * @returns
 */
export function serializeHeaderExtensions(
    extensions: HeaderExtension[]): {profile: number, data: Uint8Array} {
  // Calculate total size
  let totalSize = 0;
  for (const ext of extensions) {
    totalSize += 1 + ext.data.length;
  }
  // Pad to 4-byte boundary
  const paddedSize = Math.ceil(totalSize / 4) * 4;

  const data = new Uint8Array(paddedSize);
  let offset = 0;

  for (const ext of extensions) {
    // One-byte format: 4 bits ID, 4 bits (length - 1)
    const header = ((ext.id & 0x0F) << 4) | ((ext.data.length - 1) & 0x0F);
    data[offset] = header;
    offset++;
    data.set(ext.data, offset);
    offset += ext.data.length;
  }

  return {profile: ONE_BYTE_PROFILE, data};
}

/** @private */
function parseOneByte(data: Uint8Array): HeaderExtension[] {
  const extensions: HeaderExtension[] = [];
  let offset = 0;

  while (offset < data.length) {
    const byte = data[offset];
    if (byte === 0) {
      // Padding
      offset++;
      continue;
    }

    const id = (byte >> 4) & 0x0F;
    if (id === 15) {
      break;
    }

    const len = (byte & 0x0F) + 1;
    offset++;

    if (offset + len > data.length) {
      break;
    }

    extensions.push({
      id,
      data: data.slice(offset, offset + len),
    });
    offset += len;
  }

  return extensions;
}

/** @private */
function parseTwoByte(data: Uint8Array): HeaderExtension[] {
  const extensions: HeaderExtension[] = [];
  let offset = 0;

  while (offset + 2 <= data.length) {
    const id = data[offset];
    if (id === 0) {
      offset++;
      continue;
    }
    const len = data[offset + 1];
    offset += 2;

    if (offset + len > data.length) {
      break;
    }

    extensions.push({
      id,
      data: data.slice(offset, offset + len),
    });
    offset += len;
  }

  return extensions;
}

/**
 * Create abs-send-time extension value (3 bytes, 6.18 fixed point seconds).
 * @param sendTimeMs Send time in milliseconds
 * @returns 3-byte abs-send-time value
 */
export function createAbsSendTime(sendTimeMs: number): Uint8Array {
  // abs-send-time: 6-bit seconds, 18-bit fractions (in NTP-like format)
  const sendTimeSec = sendTimeMs / 1000;
  const value = Math.floor(sendTimeSec * (1 << 18)) & 0xFFFFFF;
  return new Uint8Array([
    (value >> 16) & 0xFF,
    (value >> 8) & 0xFF,
    value & 0xFF,
  ]);
}

/**
 * Parse abs-send-time extension value.
 * @param data 3-byte abs-send-time
 * @returns Send time in milliseconds (relative)
 */
export function parseAbsSendTime(data: Uint8Array): number {
  const value = (data[0] << 16) | (data[1] << 8) | data[2];
  return (value / (1 << 18)) * 1000;
}

/**
 * Create transport-CC sequence number extension (2 bytes).
 * @param seq Transport-wide sequence number
 * @returns
 */
export function createTransportCcSeq(seq: number): Uint8Array {
  const data = new Uint8Array(2);
  const view = new DataView(data.buffer);
  view.setUint16(0, seq & 0xFFFF);
  return data;
}

/**
 * Parse transport-CC sequence number.
 * @param data
 * @returns
 */
export function parseTransportCcSeq(data: Uint8Array): number {
  return (data[0] << 8) | data[1];
}

/**
 * Create audio level extension (1 byte: V flag + 7-bit level in -dBov).
 * @param vad Voice activity flag
 * @param level Audio level in -dBov (0-127, 0 = loudest)
 * @returns
 */
export function createAudioLevel(vad: boolean, level: number): Uint8Array {
  let byte = level & 0x7F;
  if (vad) {
    byte |= 0x80;
  }
  return new Uint8Array([byte]);
}

/**
 * Parse audio level extension.
 * @param data
 * @returns
 */
export function parseAudioLevel(data: Uint8Array): AudioLevelInfo {
  return {
    vad: (data[0] & 0x80) !== 0,
    level: data[0] & 0x7F,
  };
}
