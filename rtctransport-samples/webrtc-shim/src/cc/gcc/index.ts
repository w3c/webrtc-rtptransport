// GCC congestion controller.
//
// Google Congestion Control: trendline delay estimator + loss-based estimate
// combined by the GccController, exposed through the shared CC contract.

import {
  type CongestionController,
  type CongestionControllerOptions,
  type SentPacketInfo,
} from '../congestion-controller';
import {
  GccController,
  type GccEstimate,
  type PacketFeedback,
} from './gcc-controller';

export class GccCongestionController implements CongestionController {
  gccController: GccController;
  sentPackets: Map<number, SentPacketInfo>;

  constructor(options: CongestionControllerOptions = {}) {
    this.gccController = new GccController(options);
    this.sentPackets = new Map();
  }

  getStats(): Record<string, unknown> {
    return { ...this.gccController.getEstimate() };
  }

  getTargetBitrateBps(): number {
    return this.gccController.getEstimate().targetBitrateBps;
  }

  onPacketAcked(seqNum: number, arrivalTimeMs: number): void {
    const sentPacket = this.sentPackets.get(seqNum);
    if (!sentPacket) {
      return;
    }
    this.sentPackets.delete(seqNum);

    const feedback: PacketFeedback = {
      arrivalTimeMs,
      sendTimeMs: sentPacket.sendTimeMs,
      sequenceNumber: seqNum,
      sizeBytes: sentPacket.sizeBytes,
    };
    this.gccController.onTransportFeedback([feedback], arrivalTimeMs);
  }

  onPacketSent(sizeBytes: number, sendTimeMs: number, seqNum: number): void {
    this.sentPackets.set(seqNum, {
      sendTimeMs,
      sizeBytes,
    });
  }

  onRtcpFeedback(rttMs: number, fractionLost: number, atTimeMs: number): void {
    this.gccController.onRtcpFeedback(rttMs, fractionLost, atTimeMs);
  }
}

export type { GccEstimate };
