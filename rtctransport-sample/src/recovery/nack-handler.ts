// NACK Handler - Detects packet loss and sends NACK requests
// Implements the receiver-side logic for requesting retransmissions.

import { buildNackItems, serializeNack } from '../rtp/rtcp-fb';

export interface NackHandlerOptions {
  localSsrc: number;
  remoteSsrc: number;
  onNack: (packet: Uint8Array) => void;
  maxNackListSize?: number;
  maxRetries?: number;
  rttMs?: number;
}

interface MissingPacketInfo {
  attempts: number;
  lastNackMs: number;
}

export interface NackHandlerStats {
  pendingNacks: number;
}

/**
 * Tracks received sequence numbers and requests retransmissions for gaps.
 */
export class NackHandler {
  localSsrc: number;
  remoteSsrc: number;
  onNack: (packet: Uint8Array) => void;
  maxNackListSize: number;
  maxRetries: number;
  rttMs: number;
  highestSeq: number;
  missingPackets: Map<number, MissingPacketInfo>;
  nackTimerId: ReturnType<typeof setInterval>|null;

  constructor({
    localSsrc,
    remoteSsrc,
    onNack,
    maxNackListSize = 250,
    maxRetries = 3,
    rttMs = 100,
  }: NackHandlerOptions) {
    this.localSsrc = localSsrc;
    this.remoteSsrc = remoteSsrc;
    this.onNack = onNack;
    this.maxNackListSize = maxNackListSize;
    this.maxRetries = maxRetries;
    this.rttMs = rttMs;

    this.highestSeq = -1;
    this.missingPackets = new Map();

    this.nackTimerId = null;
  }

  start(): void {
    this.nackTimerId = setInterval(() => this._sendPendingNacks(), this.rttMs);
  }

  stop(): void {
    if (this.nackTimerId !== null) {
      clearInterval(this.nackTimerId);
      this.nackTimerId = null;
    }
  }

  onPacketReceived(seq: number): void {
    this.missingPackets.delete(seq);

    if (this.highestSeq === -1) {
      this.highestSeq = seq;
      return;
    }

    const diff = this._seqDiff(seq, this.highestSeq);

    if (diff > 1) {
      for (let i = 1; i < diff && this.missingPackets.size < this.maxNackListSize;
           i++) {
        const missingSeq = (this.highestSeq + i) & 0xFFFF;
        if (!this.missingPackets.has(missingSeq)) {
          this.missingPackets.set(missingSeq, { attempts: 0, lastNackMs: 0 });
        }
      }
    }

    if (diff > 0) {
      this.highestSeq = seq;
    }
  }

  setRtt(rttMs: number): void {
    this.rttMs = rttMs;
  }

  getStats(): NackHandlerStats {
    return {
      pendingNacks: this.missingPackets.size,
    };
  }

  private _sendPendingNacks(): void {
    const now = performance.now();
    const toNack: number[] = [];
    const toRemove: number[] = [];

    for (const [seq, info] of this.missingPackets) {
      if (info.attempts >= this.maxRetries) {
        toRemove.push(seq);
        continue;
      }

      if (now - info.lastNackMs < this.rttMs) {
        continue;
      }

      toNack.push(seq);
      info.attempts++;
      info.lastNackMs = now;
    }

    for (const seq of toRemove) {
      this.missingPackets.delete(seq);
    }

    if (toNack.length > 0) {
      toNack.sort((a, b) => a - b);
      const nackItems = buildNackItems(toNack);
      const nackPacket =
          serializeNack(this.localSsrc, this.remoteSsrc, nackItems);
      this.onNack(nackPacket);
    }
  }

  private _seqDiff(a: number, b: number): number {
    let diff = (a - b) & 0xFFFF;
    if (diff > 0x7FFF) {
      diff -= 0x10000;
    }
    return diff;
  }
}
