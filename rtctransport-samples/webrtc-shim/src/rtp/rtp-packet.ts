// RTP Packet Parser/Serializer (RFC 3550)
//
// RTP Header Format:
//  0                   1                   2                   3
//  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |V=2|P|X|  CC   |M|     PT      |       sequence number         |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                           timestamp                           |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |           synchronization source (SSRC) identifier            |
// +=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+
// |            contributing source (CSRC) identifiers             |
// |                             ....                              |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

export const RTP_VERSION = 2;
export const RTP_HEADER_MIN_SIZE = 12;

export interface RtpHeader {
  version: number;
  padding: boolean;
  extension: boolean;
  csrcCount: number;
  marker: boolean;
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  csrc: number[];
}

export interface RtpHeaderExtension {
  profile: number;
  data: Uint8Array;
}

export interface RtpPacket {
  header: RtpHeader;
  extension: RtpHeaderExtension | null;
  payload: Uint8Array;
}

/**
 * Parse an RTP packet from a buffer.
 * @param buffer Raw RTP packet bytes
 * @returns Parsed RTP packet
 */
export function parseRtpPacket(buffer: Uint8Array): RtpPacket {
  if (buffer.length < RTP_HEADER_MIN_SIZE) {
    throw new Error(`RTP packet too short: ${buffer.length} bytes`);
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const firstByte = view.getUint8(0);
  const version = (firstByte >> 6) & 0x03;
  if (version !== RTP_VERSION) {
    throw new Error(`Invalid RTP version: ${version}`);
  }

  const padding = ((firstByte >> 5) & 0x01) === 1;
  const extensionFlag = ((firstByte >> 4) & 0x01) === 1;
  const csrcCount = firstByte & 0x0F;

  const secondByte = view.getUint8(1);
  const marker = ((secondByte >> 7) & 0x01) === 1;
  const payloadType = secondByte & 0x7F;

  const sequenceNumber = view.getUint16(2);
  const timestamp = view.getUint32(4);
  const ssrc = view.getUint32(8);

  let offset = RTP_HEADER_MIN_SIZE;

  // Parse CSRC list
  const csrc: number[] = [];
  for (let i = 0; i < csrcCount; i++) {
    if (offset + 4 > buffer.length) {
      throw new Error('RTP packet truncated in CSRC list');
    }
    csrc.push(view.getUint32(offset));
    offset += 4;
  }

  // Parse header extension
  let extension: RtpHeaderExtension | null = null;
  if (extensionFlag) {
    if (offset + 4 > buffer.length) {
      throw new Error('RTP packet truncated in extension header');
    }
    const profile = view.getUint16(offset);
    const extLength = view.getUint16(offset + 2) * 4;
    offset += 4;

    if (offset + extLength > buffer.length) {
      throw new Error('RTP packet truncated in extension data');
    }
    extension = {
      profile,
      data: buffer.slice(offset, offset + extLength),
    };
    offset += extLength;
  }

  // Calculate payload (handle padding)
  let payloadEnd = buffer.length;
  if (padding && buffer.length > offset) {
    const paddingLength = buffer[buffer.length - 1];
    payloadEnd -= paddingLength;
  }

  const payload = buffer.slice(offset, payloadEnd);

  return {
    header: {
      version,
      padding,
      extension: extensionFlag,
      csrcCount,
      marker,
      payloadType,
      sequenceNumber,
      timestamp,
      ssrc,
      csrc,
    },
    extension,
    payload,
  };
}

/**
 * Serialize an RTP packet to a buffer.
 * @param packet RTP packet to serialize
 * @returns Serialized RTP packet
 */
export function serializeRtpPacket(packet: RtpPacket): Uint8Array {
  const { header, extension, payload } = packet;
  const csrcCount = header.csrc ? header.csrc.length : 0;
  const hasExtension = extension !== null && extension !== undefined;

  let size = RTP_HEADER_MIN_SIZE + csrcCount * 4;
  if (hasExtension) {
    size += 4 + extension.data.length;
  }
  size += payload.length;

  const buffer = new Uint8Array(size);
  const view = new DataView(buffer.buffer);

  // First byte: V=2, P, X, CC
  let firstByte = RTP_VERSION << 6;
  if (header.padding) {
    firstByte |= 1 << 5;
  }
  if (hasExtension) {
    firstByte |= 1 << 4;
  }
  firstByte |= csrcCount & 0x0F;
  view.setUint8(0, firstByte);

  // Second byte: M, PT
  let secondByte = header.payloadType & 0x7F;
  if (header.marker) {
    secondByte |= 1 << 7;
  }
  view.setUint8(1, secondByte);

  // Sequence number, timestamp, SSRC
  view.setUint16(2, header.sequenceNumber & 0xFFFF);
  view.setUint32(4, header.timestamp >>> 0);
  view.setUint32(8, header.ssrc >>> 0);

  let offset = RTP_HEADER_MIN_SIZE;

  // CSRC list
  for (let i = 0; i < csrcCount; i++) {
    view.setUint32(offset, header.csrc[i] >>> 0);
    offset += 4;
  }

  // Header extension
  if (hasExtension) {
    view.setUint16(offset, extension.profile);
    view.setUint16(offset + 2, extension.data.length / 4);
    offset += 4;
    buffer.set(extension.data, offset);
    offset += extension.data.length;
  }

  // Payload
  buffer.set(payload, offset);

  return buffer;
}

/**
 * Check if a buffer looks like an RTP packet (vs RTCP or STUN).
 * @param buffer
 * @returns
 */
export function isRtpPacket(buffer: Uint8Array): boolean {
  if (buffer.length < RTP_HEADER_MIN_SIZE) {
    return false;
  }
  const version = (buffer[0] >> 6) & 0x03;
  if (version !== RTP_VERSION) {
    return false;
  }
  const pt = buffer[1] & 0x7F;
  // RTCP uses PT 200-204; RTP uses anything else
  return pt < 64 || pt > 95;
}
