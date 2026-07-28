// PLI/FIR Handler - Keyframe request management
// Sends PLI (Picture Loss Indication) or FIR (Full Intra Request) when needed.

import { serializeFir, serializePli } from '../rtp/rtcp-fb';

export interface PliHandlerOptions {
  localSsrc: number;
  remoteSsrc: number;
  onSendRtcp: (packet: Uint8Array) => void;
  minIntervalMs?: number;
}

/**
 * Manages keyframe requests with rate limiting.
 */
export class PliHandler {
  localSsrc: number;
  remoteSsrc: number;
  onSendRtcp: (packet: Uint8Array) => void;
  minIntervalMs: number;
  lastRequestMs: number;
  firSeqNum: number;
  pendingRequest: boolean;

  constructor({
    localSsrc,
    remoteSsrc,
    onSendRtcp,
    minIntervalMs = 1000,
  }: PliHandlerOptions) {
    this.localSsrc = localSsrc;
    this.remoteSsrc = remoteSsrc;
    this.onSendRtcp = onSendRtcp;
    this.minIntervalMs = minIntervalMs;

    this.lastRequestMs = 0;
    this.firSeqNum = 0;
    this.pendingRequest = false;
  }

  requestKeyframe(): void {
    const now = performance.now();
    if (now - this.lastRequestMs < this.minIntervalMs) {
      this.pendingRequest = true;
      return;
    }

    const pli = serializePli(this.localSsrc, this.remoteSsrc);
    this.onSendRtcp(pli);
    this.lastRequestMs = now;
    this.pendingRequest = false;
  }

  requestFullIntra(): void {
    const now = performance.now();
    if (now - this.lastRequestMs < this.minIntervalMs) {
      return;
    }

    const fir = serializeFir(this.localSsrc, this.remoteSsrc, this.firSeqNum);
    this.firSeqNum = (this.firSeqNum + 1) & 0xFF;
    this.onSendRtcp(fir);
    this.lastRequestMs = now;
  }

  onFrameIncomplete(missingPackets: number, framePackets: number): void {
    if (missingPackets / framePackets > 0.3) {
      this.requestKeyframe();
    }
  }

  tick(): void {
    if (this.pendingRequest) {
      this.requestKeyframe();
    }
  }
}
