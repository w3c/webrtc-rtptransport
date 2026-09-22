// RTCP Packet Parser/Serializer (RFC 3550 Section 6)
//
// RTCP Header Format:
//  0                   1                   2                   3
//  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |V=2|P|    RC   |   PT=SR=200   |             length            |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                         SSRC of sender                        |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

// RTCP Packet Types
export const RTCP_PT = {
  SR: 200,
  RR: 201,
  SDES: 202,
  BYE: 203,
  APP: 204,
  RTPFB: 205,
  PSFB: 206,
  XR: 207,
} as const;

export interface NtpTimestamp {
  msw: number;
  lsw: number;
}

export interface RtcpSenderInfo {
  ntpTimestampMsw: number;
  ntpTimestampLsw: number;
  rtpTimestamp: number;
  senderPacketCount: number;
  senderOctetCount: number;
}

export interface RtcpReportBlock {
  ssrc: number;
  fractionLost: number;
  cumulativeLost: number;
  highestSeqNum: number;
  jitter: number;
  lastSr: number;
  delaySinceLastSr: number;
}

export interface RtcpSenderReport {
  type: 'SR';
  ssrc: number;
  senderInfo: RtcpSenderInfo;
  reportBlocks: RtcpReportBlock[];
}

export interface RtcpReceiverReport {
  type: 'RR';
  ssrc: number;
  reportBlocks: RtcpReportBlock[];
}

export interface RtcpBye {
  type: 'BYE';
  ssrcList: number[];
  reason?: string;
}

export interface UnknownRtcpPacket {
  type: 'UNKNOWN';
  pt: number;
  data: Uint8Array;
}

export type RtcpPacket =
  | RtcpSenderReport
  | RtcpReceiverReport
  | RtcpBye
  | UnknownRtcpPacket;

/**
 * Parse RTCP compound packet (may contain multiple RTCP packets).
 * @param buffer
 * @returns
 */
export function parseRtcpCompound(buffer: Uint8Array): RtcpPacket[] {
  const packets: RtcpPacket[] = [];
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const view = new DataView(
        buffer.buffer, buffer.byteOffset + offset, buffer.byteLength - offset);

    const firstByte = view.getUint8(0);
    const version = (firstByte >> 6) & 0x03;
    if (version !== 2) {
      break;
    }

    const padding = ((firstByte >> 5) & 0x01) === 1;
    const rc = firstByte & 0x1F;
    const pt = view.getUint8(1);
    const lengthWords = view.getUint16(2);
    const packetLength = (lengthWords + 1) * 4;

    if (offset + packetLength > buffer.length) {
      break;
    }

    const packetData = buffer.slice(offset, offset + packetLength);
    const packetView = new DataView(
        packetData.buffer, packetData.byteOffset, packetData.byteLength);

    switch (pt) {
      case RTCP_PT.SR:
        packets.push(parseSenderReport(packetView, rc));
        break;
      case RTCP_PT.RR:
        packets.push(parseReceiverReport(packetView, rc));
        break;
      case RTCP_PT.BYE:
        packets.push(parseBye(packetView, rc, packetLength));
        break;
      default:
        packets.push({type: 'UNKNOWN', pt, data: packetData});
        break;
    }

    offset += packetLength;
  }

  return packets;
}

function parseReportBlock(view: DataView, offset: number): RtcpReportBlock {
  return {
    ssrc: view.getUint32(offset),
    fractionLost: view.getUint8(offset + 4),
    cumulativeLost: (view.getUint8(offset + 5) << 16) |
        (view.getUint8(offset + 6) << 8) |
        view.getUint8(offset + 7),
    highestSeqNum: view.getUint32(offset + 8),
    jitter: view.getUint32(offset + 12),
    lastSr: view.getUint32(offset + 16),
    delaySinceLastSr: view.getUint32(offset + 20),
  };
}

function parseSenderReport(view: DataView, rc: number): RtcpSenderReport {
  const ssrc = view.getUint32(4);
  const senderInfo: RtcpSenderInfo = {
    ntpTimestampMsw: view.getUint32(8),
    ntpTimestampLsw: view.getUint32(12),
    rtpTimestamp: view.getUint32(16),
    senderPacketCount: view.getUint32(20),
    senderOctetCount: view.getUint32(24),
  };

  const reportBlocks: RtcpReportBlock[] = [];
  let offset = 28;
  for (let i = 0; i < rc; i++) {
    reportBlocks.push(parseReportBlock(view, offset));
    offset += 24;
  }

  return {type: 'SR', ssrc, senderInfo, reportBlocks};
}

function parseReceiverReport(view: DataView, rc: number): RtcpReceiverReport {
  const ssrc = view.getUint32(4);
  const reportBlocks: RtcpReportBlock[] = [];
  let offset = 8;
  for (let i = 0; i < rc; i++) {
    reportBlocks.push(parseReportBlock(view, offset));
    offset += 24;
  }

  return {type: 'RR', ssrc, reportBlocks};
}

function parseBye(
    view: DataView, rc: number, packetLength: number): RtcpBye {
  const ssrcList: number[] = [];
  let offset = 4;
  for (let i = 0; i < rc; i++) {
    ssrcList.push(view.getUint32(offset));
    offset += 4;
  }

  let reason: string|undefined;
  if (offset < packetLength) {
    const reasonLen = view.getUint8(offset);
    offset += 1;
    if (offset + reasonLen <= packetLength) {
      const decoder = new TextDecoder();
      reason = decoder.decode(
          new Uint8Array(view.buffer, view.byteOffset + offset, reasonLen));
    }
  }

  return {type: 'BYE', ssrcList, reason};
}

/**
 * Serialize a Sender Report.
 * @param sr
 * @returns
 */
export function serializeSenderReport(sr: RtcpSenderReport): Uint8Array {
  const rc = sr.reportBlocks.length;
  const size = 28 + rc * 24;
  const buffer = new Uint8Array(size);
  const view = new DataView(buffer.buffer);

  // Header
  view.setUint8(0, (2 << 6) | (rc & 0x1F));
  view.setUint8(1, RTCP_PT.SR);
  view.setUint16(2, (size / 4) - 1);

  // SSRC
  view.setUint32(4, sr.ssrc >>> 0);

  // Sender Info
  view.setUint32(8, sr.senderInfo.ntpTimestampMsw >>> 0);
  view.setUint32(12, sr.senderInfo.ntpTimestampLsw >>> 0);
  view.setUint32(16, sr.senderInfo.rtpTimestamp >>> 0);
  view.setUint32(20, sr.senderInfo.senderPacketCount >>> 0);
  view.setUint32(24, sr.senderInfo.senderOctetCount >>> 0);

  // Report blocks
  let offset = 28;
  for (const block of sr.reportBlocks) {
    serializeReportBlock(view, offset, block);
    offset += 24;
  }

  return buffer;
}

/**
 * Serialize a Receiver Report.
 * @param rr
 * @returns
 */
export function serializeReceiverReport(rr: RtcpReceiverReport): Uint8Array {
  const rc = rr.reportBlocks.length;
  const size = 8 + rc * 24;
  const buffer = new Uint8Array(size);
  const view = new DataView(buffer.buffer);

  // Header
  view.setUint8(0, (2 << 6) | (rc & 0x1F));
  view.setUint8(1, RTCP_PT.RR);
  view.setUint16(2, (size / 4) - 1);

  // SSRC
  view.setUint32(4, rr.ssrc >>> 0);

  // Report blocks
  let offset = 8;
  for (const block of rr.reportBlocks) {
    serializeReportBlock(view, offset, block);
    offset += 24;
  }

  return buffer;
}

function serializeReportBlock(
    view: DataView, offset: number, block: RtcpReportBlock): void {
  view.setUint32(offset, block.ssrc >>> 0);
  view.setUint8(offset + 4, block.fractionLost & 0xFF);
  // Cumulative lost (24-bit signed)
  const cumLost = block.cumulativeLost & 0xFFFFFF;
  view.setUint8(offset + 5, (cumLost >> 16) & 0xFF);
  view.setUint8(offset + 6, (cumLost >> 8) & 0xFF);
  view.setUint8(offset + 7, cumLost & 0xFF);
  view.setUint32(offset + 8, block.highestSeqNum >>> 0);
  view.setUint32(offset + 12, block.jitter >>> 0);
  view.setUint32(offset + 16, block.lastSr >>> 0);
  view.setUint32(offset + 20, block.delaySinceLastSr >>> 0);
}

/**
 * Serialize a BYE packet.
 * @param bye
 * @returns
 */
export function serializeBye(bye: RtcpBye): Uint8Array {
  const rc = bye.ssrcList.length;
  let reasonBytes: Uint8Array|null = null;
  let reasonPadded = 0;

  if (bye.reason) {
    const encoder = new TextEncoder();
    reasonBytes = encoder.encode(bye.reason);
    // 1 byte length + reason + padding to 32-bit boundary
    reasonPadded = Math.ceil((1 + reasonBytes.length) / 4) * 4;
  }

  const size = 4 + rc * 4 + reasonPadded;
  const buffer = new Uint8Array(size);
  const view = new DataView(buffer.buffer);

  view.setUint8(0, (2 << 6) | (rc & 0x1F));
  view.setUint8(1, RTCP_PT.BYE);
  view.setUint16(2, (size / 4) - 1);

  let offset = 4;
  for (const ssrc of bye.ssrcList) {
    view.setUint32(offset, ssrc >>> 0);
    offset += 4;
  }

  if (reasonBytes) {
    view.setUint8(offset, reasonBytes.length);
    buffer.set(reasonBytes, offset + 1);
  }

  return buffer;
}

/**
 * Check if a buffer looks like an RTCP packet.
 * @param buffer
 * @returns
 */
export function isRtcpPacket(buffer: Uint8Array): boolean {
  if (buffer.length < 4) {
    return false;
  }
  const version = (buffer[0] >> 6) & 0x03;
  if (version !== 2) {
    return false;
  }
  const pt = buffer[1];
  return pt >= 200 && pt <= 207;
}

/**
 * Get current NTP timestamp as {msw, lsw}.
 * NTP epoch: January 1, 1900. Unix epoch offset: 2208988800 seconds.
 */
export function getNtpTimestamp(): NtpTimestamp {
  const NTP_EPOCH_OFFSET = 2208988800;
  const now = Date.now() / 1000;
  const ntpSeconds = now + NTP_EPOCH_OFFSET;
  const msw = Math.floor(ntpSeconds) >>> 0;
  const lsw = ((ntpSeconds - Math.floor(ntpSeconds)) * 0x100000000) >>> 0;
  return {msw, lsw};
}

/**
 * Convert NTP timestamp to compact form (middle 32 bits) for lastSr.
 */
export function ntpToCompact(msw: number, lsw: number): number {
  return ((msw & 0xFFFF) << 16) | ((lsw >>> 16) & 0xFFFF);
}
