// NACK Handler (RFC 4585 Section 6.2.1)
//
// Generic NACK feedback message format:
//  0                   1                   2                   3
//  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |V=2|P| FMT=1   |   PT=205      |          length               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                  SSRC of packet sender                        |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                  SSRC of media source                         |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |            PID                |             BLP               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//
// PID = Packet ID of the lost packet
// BLP = Bitmask of following lost packets (bit i = PID+i+1 is lost)

import { RTCP_PT } from '../rtp/rtcp-packet';

const RTPFB_FMT_NACK = 1;

export interface NackHandlerOptions {
  /** Our SSRC (sender of the NACK) */
  senderSsrc: number;
  /** Remote SSRC (media source we're requesting from) */
  mediaSsrc: number;
  /** Maximum number of NACKs per packet */
  maxNacksPerPacket?: number;
  /** Time (ms) to wait before re-sending a NACK for same seq */
  nackRetransmitIntervalMs?: number;
  /** Maximum retransmit attempts per sequence number */
  maxRetransmits?: number;
}

interface NackEntry {
  firstNackTime: number;
  lastNackTime: number;
  retransmitCount: number;
}

export interface NackStats {
  nacksSent: number;
  nacksReceived: number;
  retransmissionsSent: number;
  packetsRecovered: number;
}

/**
 * Tracks received sequence numbers, detects gaps, and generates NACK packets.
 * Also handles incoming NACKs for retransmission on the send side.
 *
 * Reference: WebRTC modules/rtp_rtcp/source/nack_requester.cc
 */
export class NackHandler {
  senderSsrc: number;
  mediaSsrc: number;
  maxNacksPerPacket: number;
  nackRetransmitIntervalMs: number;
  maxRetransmits: number;

  // Receive side: track gaps
  private _receivedSeqs: Set<number>;
  private _highestSeq: number;
  private _nackList: Map<number, NackEntry>;

  // Send side: packet buffer for retransmission
  private _sendBuffer: Map<number, Uint8Array>;
  private _sendBufferMaxSize: number;

  stats: NackStats;

  constructor(options: NackHandlerOptions) {
    this.senderSsrc = options.senderSsrc;
    this.mediaSsrc = options.mediaSsrc;
    this.maxNacksPerPacket = options.maxNacksPerPacket ?? 100;
    this.nackRetransmitIntervalMs = options.nackRetransmitIntervalMs ?? 50;
    this.maxRetransmits = options.maxRetransmits ?? 10;

    this._receivedSeqs = new Set();
    this._highestSeq = -1;
    this._nackList = new Map();

    this._sendBuffer = new Map();
    this._sendBufferMaxSize = 500;

    this.stats = {
      nacksSent: 0,
      nacksReceived: 0,
      retransmissionsSent: 0,
      packetsRecovered: 0,
    };
  }

  /**
   * Called when an RTP packet is received. Returns true if a NACK should
   * be sent (call generateNack() to get the packet).
   */
  onPacketReceived(seq: number): boolean {
    this._receivedSeqs.add(seq);

    // Remove from nack list if we were waiting for it
    if (this._nackList.has(seq)) {
      this._nackList.delete(seq);
      this.stats.packetsRecovered++;
    }

    // Limit received set size (sliding window of ~1000 packets)
    if (this._receivedSeqs.size > 1500) {
      this._pruneReceivedSet();
    }

    if (this._highestSeq === -1) {
      this._highestSeq = seq;
      return false;
    }

    const diff = this._seqDiff(seq, this._highestSeq);
    if (diff <= 0) {
      // Duplicate or late arrival — no new gap
      return false;
    }

    // Detect gap: seq numbers between highestSeq+1 and seq-1 are missing
    const oldHighest = this._highestSeq;
    this._highestSeq = seq;

    let hasNewNacks = false;
    const now = performance.now();

    for (let i = 1; i < diff; i++) {
      const missingSeq = (oldHighest + i) & 0xFFFF;
      if (!this._receivedSeqs.has(missingSeq) &&
          !this._nackList.has(missingSeq)) {
        this._nackList.set(missingSeq, {
          firstNackTime: now,
          lastNackTime: 0,
          retransmitCount: 0,
        });
        hasNewNacks = true;
      }
    }

    return hasNewNacks;
  }

  /**
   * Generate a NACK RTCP packet for all pending lost sequences.
   * Returns null if no NACKs are pending.
   */
  generateNack(): Uint8Array | null {
    const now = performance.now();
    const seqsToNack: number[] = [];

    for (const [seq, entry] of this._nackList) {
      if (entry.retransmitCount >= this.maxRetransmits) {
        this._nackList.delete(seq);
        continue;
      }
      if (entry.lastNackTime > 0 &&
          now - entry.lastNackTime < this.nackRetransmitIntervalMs) {
        continue;
      }
      entry.lastNackTime = now;
      entry.retransmitCount++;
      seqsToNack.push(seq);
    }

    if (seqsToNack.length === 0) return null;

    // Sort and limit
    seqsToNack.sort((a, b) => this._seqDiff(a, b));
    const limited = seqsToNack.slice(0, this.maxNacksPerPacket * 17);

    // Pack into PID+BLP pairs
    const nackItems = this._packNackItems(limited);
    this.stats.nacksSent += nackItems.length;

    return this._serializeNack(nackItems);
  }

  /**
   * Store a sent packet for potential retransmission.
   */
  bufferSentPacket(seq: number, packet: Uint8Array): void {
    this._sendBuffer.set(seq, packet);
    if (this._sendBuffer.size > this._sendBufferMaxSize) {
      // Remove oldest entries
      const iter = this._sendBuffer.keys();
      for (let i = 0; i < 50; i++) {
        const key = iter.next().value;
        if (key !== undefined) this._sendBuffer.delete(key);
      }
    }
  }

  /**
   * Parse incoming NACK and return packets to retransmit.
   */
  handleIncomingNack(data: Uint8Array): Uint8Array[] {
    const nackSeqs = parseNackPacket(data);
    if (!nackSeqs) return [];

    this.stats.nacksReceived++;
    const retransmits: Uint8Array[] = [];

    for (const seq of nackSeqs) {
      const packet = this._sendBuffer.get(seq);
      if (packet) {
        retransmits.push(packet);
        this.stats.retransmissionsSent++;
      }
    }

    return retransmits;
  }

  /**
   * Get pending NACK count.
   */
  getPendingNackCount(): number {
    return this._nackList.size;
  }

  private _packNackItems(seqs: number[]): Array<{pid: number; blp: number}> {
    const items: Array<{pid: number; blp: number}> = [];
    let i = 0;

    while (i < seqs.length) {
      const pid = seqs[i];
      let blp = 0;
      i++;

      // Pack up to 16 following seqs into the bitmask
      while (i < seqs.length) {
        const diff = this._seqDiff(seqs[i], pid);
        if (diff >= 1 && diff <= 16) {
          blp |= (1 << (diff - 1));
          i++;
        } else {
          break;
        }
      }

      items.push({pid, blp});
    }

    return items;
  }

  private _serializeNack(
      items: Array<{pid: number; blp: number}>): Uint8Array {
    // Header (4) + sender SSRC (4) + media SSRC (4) + items (4 each)
    const size = 12 + items.length * 4;
    const buffer = new Uint8Array(size);
    const view = new DataView(buffer.buffer);

    // RTCP header: V=2, P=0, FMT=1, PT=205 (RTPFB)
    view.setUint8(0, (2 << 6) | RTPFB_FMT_NACK);
    view.setUint8(1, RTCP_PT.RTPFB);
    view.setUint16(2, (size / 4) - 1);
    view.setUint32(4, this.senderSsrc >>> 0);
    view.setUint32(8, this.mediaSsrc >>> 0);

    let offset = 12;
    for (const item of items) {
      view.setUint16(offset, item.pid & 0xFFFF);
      view.setUint16(offset + 2, item.blp & 0xFFFF);
      offset += 4;
    }

    return buffer;
  }

  private _seqDiff(a: number, b: number): number {
    let diff = ((a & 0xFFFF) - (b & 0xFFFF)) & 0xFFFF;
    if (diff > 0x7FFF) diff -= 0x10000;
    return diff;
  }

  private _pruneReceivedSet(): void {
    // Keep only seqs near the highest
    const toRemove: number[] = [];
    for (const seq of this._receivedSeqs) {
      if (this._seqDiff(this._highestSeq, seq) > 1000) {
        toRemove.push(seq);
      }
    }
    for (const seq of toRemove) {
      this._receivedSeqs.delete(seq);
    }
  }
}

/**
 * Parse a NACK RTCP packet and return the lost sequence numbers.
 */
export function parseNackPacket(data: Uint8Array): number[] | null {
  if (data.length < 16) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const firstByte = view.getUint8(0);
  const fmt = firstByte & 0x1F;
  const pt = view.getUint8(1);

  if (pt !== RTCP_PT.RTPFB || fmt !== RTPFB_FMT_NACK) return null;

  const seqs: number[] = [];
  let offset = 12;

  while (offset + 4 <= data.length) {
    const pid = view.getUint16(offset);
    const blp = view.getUint16(offset + 2);
    seqs.push(pid);

    for (let i = 0; i < 16; i++) {
      if (blp & (1 << i)) {
        seqs.push((pid + i + 1) & 0xFFFF);
      }
    }
    offset += 4;
  }

  return seqs;
}
