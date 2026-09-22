// PLI & FIR Handler (RFC 4585 Section 6.3.1, RFC 5104 Section 4.3.1)
//
// PLI (Picture Loss Indication):
//  RTCP PT=206 (PSFB), FMT=1
//  No FCI — just sender SSRC + media SSRC
//
// FIR (Full Intra Request):
//  RTCP PT=206 (PSFB), FMT=4
//  FCI: 4-byte SSRC + 1-byte seq + 3 reserved bytes per entry
//
// Reference: WebRTC modules/rtp_rtcp/source/rtcp_sender.cc BuildPLI/BuildFIR

import { RTCP_PT } from '../rtp/rtcp-packet';

const PSFB_FMT_PLI = 1;
const PSFB_FMT_FIR = 4;

export interface KeyframeRequestStats {
  pliSent: number;
  pliReceived: number;
  firSent: number;
  firReceived: number;
  keyframesRequested: number;
  lastRequestTime: number;
}

export interface KeyframeRequestHandlerOptions {
  /** Our SSRC (sender of PLI/FIR) */
  senderSsrc: number;
  /** Remote SSRC (media source) */
  mediaSsrc: number;
  /** Minimum interval between keyframe requests (ms) */
  minIntervalMs?: number;
  /** Callback when a keyframe is requested by the remote side */
  onKeyframeRequested?: () => void;
}

/**
 * Handles sending and receiving PLI/FIR RTCP messages.
 * Throttles outbound requests to avoid flooding.
 *
 * Reference: WebRTC modules/rtp_rtcp/source/rtcp_sender.cc
 */
export class KeyframeRequestHandler {
  senderSsrc: number;
  mediaSsrc: number;
  minIntervalMs: number;
  onKeyframeRequested: (() => void) | null;

  private _firSeqNum: number;
  private _lastRequestTime: number;

  stats: KeyframeRequestStats;

  constructor(options: KeyframeRequestHandlerOptions) {
    this.senderSsrc = options.senderSsrc;
    this.mediaSsrc = options.mediaSsrc;
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    this.onKeyframeRequested = options.onKeyframeRequested ?? null;

    this._firSeqNum = 0;
    this._lastRequestTime = Number.NEGATIVE_INFINITY;

    this.stats = {
      pliSent: 0,
      pliReceived: 0,
      firSent: 0,
      firReceived: 0,
      keyframesRequested: 0,
      lastRequestTime: 0,
    };
  }

  /**
   * Generate a PLI packet. Returns null if throttled.
   */
  generatePli(): Uint8Array | null {
    if (!this._canRequest()) return null;

    this._lastRequestTime = performance.now();
    this.stats.pliSent++;
    this.stats.keyframesRequested++;
    this.stats.lastRequestTime = this._lastRequestTime;

    // PLI: 12 bytes total (header + sender SSRC + media SSRC)
    const buffer = new Uint8Array(12);
    const view = new DataView(buffer.buffer);

    // V=2, P=0, FMT=1, PT=206
    view.setUint8(0, (2 << 6) | PSFB_FMT_PLI);
    view.setUint8(1, RTCP_PT.PSFB);
    view.setUint16(2, 2); // length in 32-bit words minus 1
    view.setUint32(4, this.senderSsrc >>> 0);
    view.setUint32(8, this.mediaSsrc >>> 0);

    return buffer;
  }

  /**
   * Generate a FIR packet. Returns null if throttled.
   * FIR is stronger than PLI — requests a full IDR regardless of
   * whether the decoder has partially recovered.
   */
  generateFir(): Uint8Array | null {
    if (!this._canRequest()) return null;

    this._lastRequestTime = performance.now();
    this.stats.firSent++;
    this.stats.keyframesRequested++;
    this.stats.lastRequestTime = this._lastRequestTime;

    // FIR: 12 bytes header + 8 bytes FCI entry = 20 bytes
    const buffer = new Uint8Array(20);
    const view = new DataView(buffer.buffer);

    // V=2, P=0, FMT=4, PT=206
    view.setUint8(0, (2 << 6) | PSFB_FMT_FIR);
    view.setUint8(1, RTCP_PT.PSFB);
    view.setUint16(2, 4); // length in 32-bit words minus 1
    view.setUint32(4, this.senderSsrc >>> 0);
    view.setUint32(8, 0); // media SSRC = 0 for FIR per RFC 5104

    // FCI entry
    view.setUint32(12, this.mediaSsrc >>> 0);
    view.setUint8(16, this._firSeqNum & 0xFF);
    // bytes 17-19 reserved = 0

    this._firSeqNum = (this._firSeqNum + 1) & 0xFF;

    return buffer;
  }

  /**
   * Handle an incoming RTCP PSFB packet. Returns true if it was PLI/FIR.
   */
  handleIncoming(data: Uint8Array): boolean {
    if (data.length < 12) return false;

    const firstByte = data[0];
    const fmt = firstByte & 0x1F;
    const pt = data[1];

    if (pt !== RTCP_PT.PSFB) return false;

    if (fmt === PSFB_FMT_PLI) {
      this.stats.pliReceived++;
      if (this.onKeyframeRequested) this.onKeyframeRequested();
      return true;
    }

    if (fmt === PSFB_FMT_FIR) {
      this.stats.firReceived++;
      if (this.onKeyframeRequested) this.onKeyframeRequested();
      return true;
    }

    return false;
  }

  private _canRequest(): boolean {
    const now = performance.now();
    return (now - this._lastRequestTime) >= this.minIntervalMs;
  }
}

/**
 * Check if an RTCP packet is a PLI or FIR.
 */
export function isPliOrFir(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  const fmt = data[0] & 0x1F;
  const pt = data[1];
  return pt === RTCP_PT.PSFB && (fmt === PSFB_FMT_PLI || fmt === PSFB_FMT_FIR);
}
