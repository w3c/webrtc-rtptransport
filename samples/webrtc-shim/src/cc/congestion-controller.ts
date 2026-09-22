// Congestion Control (CC) contract shared by every algorithm implementation.
//
// A CongestionController consumes send/ack/RTCP signals and produces a target
// send bitrate. The proxy backend applies that target to the media encoder
// (rate control, RC) via the shim's CC loop. Concrete implementations live in
// the `aimd/` and `gcc/` sub-folders.

export type CongestionControlAlgorithm = 'aimd'|'gcc';

export interface CongestionController {
  getStats(): Record<string, unknown>;
  getTargetBitrateBps(): number;
  onPacketAcked(seqNum: number, arrivalTimeMs: number): void;
  onPacketSent(sizeBytes: number, sendTimeMs: number, seqNum: number): void;
  onRtcpFeedback(rttMs: number, fractionLost: number, atTimeMs: number): void;
}

export interface CongestionControllerOptions {
  initialBps?: number;
  maxBps?: number;
  minBps?: number;
}

export interface SentPacketInfo {
  sendTimeMs: number;
  sizeBytes: number;
}
