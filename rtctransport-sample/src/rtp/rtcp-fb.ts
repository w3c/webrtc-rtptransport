// RTCP Feedback Messages (RFC 4585)
// Implements NACK, PLI (Picture Loss Indication), and FIR (Full Intra Request)

import {RTCP_PT} from './rtcp-packet';

export interface NackItem {
  pid: number;
  blp: number;
}

export interface NackPacket {
  type: 'NACK';
  senderSsrc: number;
  mediaSsrc: number;
  nacks: NackItem[];
}

/**
 * Serialize a Generic NACK message (RFC 4585 §6.2.1).
 * @param senderSsrc SSRC of packet sender (us)
 * @param mediaSsrc SSRC of media source
 * @param nacks NACK items
 * @returns
 */
export function serializeNack(
    senderSsrc: number, mediaSsrc: number, nacks: NackItem[]): Uint8Array {
  const size = 12 + nacks.length * 4;
  const buffer = new Uint8Array(size);
  const view = new DataView(buffer.buffer);

  // Header: V=2, FMT=1 (Generic NACK), PT=205 (RTPFB)
  view.setUint8(0, (2 << 6) | 1);
  view.setUint8(1, RTCP_PT.RTPFB);
  view.setUint16(2, (size / 4) - 1);
  view.setUint32(4, senderSsrc >>> 0);
  view.setUint32(8, mediaSsrc >>> 0);

  let offset = 12;
  for (const nack of nacks) {
    view.setUint16(offset, nack.pid & 0xFFFF);
    view.setUint16(offset + 2, nack.blp & 0xFFFF);
    offset += 4;
  }

  return buffer;
}

/**
 * Parse a Generic NACK message.
 * @param view
 * @param packetLength
 * @returns
 */
export function parseNack(
    view: DataView, packetLength: number): NackPacket {
  const senderSsrc = view.getUint32(4);
  const mediaSsrc = view.getUint32(8);
  const nacks: NackItem[] = [];

  for (let offset = 12; offset + 4 <= packetLength; offset += 4) {
    nacks.push({
      pid: view.getUint16(offset),
      blp: view.getUint16(offset + 2),
    });
  }

  return {type: 'NACK', senderSsrc, mediaSsrc, nacks};
}

/**
 * Serialize a PLI (Picture Loss Indication) message (RFC 4585 §6.3.1).
 * @param senderSsrc SSRC of sender
 * @param mediaSsrc SSRC of media source
 * @returns
 */
export function serializePli(
    senderSsrc: number, mediaSsrc: number): Uint8Array {
  const buffer = new Uint8Array(12);
  const view = new DataView(buffer.buffer);

  // Header: V=2, FMT=1 (PLI), PT=206 (PSFB)
  view.setUint8(0, (2 << 6) | 1);
  view.setUint8(1, RTCP_PT.PSFB);
  view.setUint16(2, 2);
  view.setUint32(4, senderSsrc >>> 0);
  view.setUint32(8, mediaSsrc >>> 0);

  return buffer;
}

/**
 * Serialize a FIR (Full Intra Request) message (RFC 5104 §4.3.1).
 * @param senderSsrc SSRC of sender
 * @param mediaSsrc SSRC of media source whose decoder needs refresh
 * @param seqNum Command sequence number
 * @returns
 */
export function serializeFir(
    senderSsrc: number, mediaSsrc: number, seqNum: number): Uint8Array {
  const buffer = new Uint8Array(20);
  const view = new DataView(buffer.buffer);

  // Header: V=2, FMT=4 (FIR), PT=206 (PSFB)
  view.setUint8(0, (2 << 6) | 4);
  view.setUint8(1, RTCP_PT.PSFB);
  view.setUint16(2, 4);
  view.setUint32(4, senderSsrc >>> 0);
  view.setUint32(8, 0);
  // FCI
  view.setUint32(12, mediaSsrc >>> 0);
  view.setUint8(16, seqNum & 0xFF);
  // 3 bytes reserved

  return buffer;
}

/**
 * Convert a list of lost sequence numbers into NACK items with bitmasks.
 * @param lostSeqs Sorted list of lost sequence numbers
 * @returns
 */
export function buildNackItems(lostSeqs: number[]): NackItem[] {
  if (lostSeqs.length === 0) {
    return [];
  }

  const items: NackItem[] = [];
  let i = 0;

  while (i < lostSeqs.length) {
    const pid = lostSeqs[i];
    let blp = 0;
    i++;

    // Set bits for sequence numbers pid+1 through pid+16
    while (i < lostSeqs.length) {
      const diff = (lostSeqs[i] - pid) & 0xFFFF;
      if (diff > 16) {
        break;
      }
      blp |= 1 << (diff - 1);
      i++;
    }

    items.push({pid, blp});
  }

  return items;
}

/**
 * Expand NACK items back into a list of lost sequence numbers.
 * @param items
 * @returns
 */
export function expandNackItems(items: NackItem[]): number[] {
  const lost: number[] = [];
  for (const {pid, blp} of items) {
    lost.push(pid);
    for (let bit = 0; bit < 16; bit++) {
      if (blp & (1 << bit)) {
        lost.push((pid + bit + 1) & 0xFFFF);
      }
    }
  }
  return lost;
}
