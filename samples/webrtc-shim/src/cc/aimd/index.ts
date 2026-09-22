// AIMD congestion controller.
//
// Delay-based (overuse detector) + loss-based bandwidth estimation feeding a
// classic AIMD rate-control loop. This is the "simple" reference algorithm.

import {
  type CongestionController,
  type CongestionControllerOptions,
  type SentPacketInfo,
} from '../congestion-controller';
import {
  BandwidthEstimator,
  type BandwidthEstimatorOptions,
  type DelayObservation,
} from './bandwidth-estimator';

interface PreviousAckSample {
  arrivalTimeMs: number;
  sendTimeMs: number;
}

export class AimdCongestionController implements CongestionController {
  bandwidthEstimator: BandwidthEstimator;
  previousAckSample: PreviousAckSample|null;
  sentPackets: Map<number, SentPacketInfo>;

  constructor(options: CongestionControllerOptions = {}) {
    const estimatorOptions: BandwidthEstimatorOptions = {
      initialBitrateBps: options.initialBps,
      maxBitrateBps: options.maxBps,
      minBitrateBps: options.minBps,
    };
    this.bandwidthEstimator = new BandwidthEstimator(estimatorOptions);
    this.sentPackets = new Map();
    this.previousAckSample = null;
  }

  getStats(): Record<string, unknown> {
    return { ...this.bandwidthEstimator.getStats() };
  }

  getTargetBitrateBps(): number {
    return this.bandwidthEstimator.getEstimate();
  }

  onPacketAcked(seqNum: number, arrivalTimeMs: number): void {
    const sentPacket = this.sentPackets.get(seqNum);
    if (!sentPacket) {
      return;
    }
    this.sentPackets.delete(seqNum);

    const observations: DelayObservation[] = [];
    if (this.previousAckSample) {
      const recvDeltaMs = arrivalTimeMs - this.previousAckSample.arrivalTimeMs;
      const sendDeltaMs = sentPacket.sendTimeMs - this.previousAckSample.sendTimeMs;
      observations.push({
        owdDelta: recvDeltaMs - sendDeltaMs,
      });
    }
    this.previousAckSample = {
      arrivalTimeMs,
      sendTimeMs: sentPacket.sendTimeMs,
    };

    if (observations.length > 0) {
      this.bandwidthEstimator.onDelayFeedback(observations, arrivalTimeMs);
    }
  }

  onPacketSent(sizeBytes: number, sendTimeMs: number, seqNum: number): void {
    this.sentPackets.set(seqNum, {
      sendTimeMs,
      sizeBytes,
    });
  }

  onRtcpFeedback(rttMs: number, fractionLost: number, atTimeMs: number): void {
    void rttMs;
    this.bandwidthEstimator.onLossFeedback(fractionLost, atTimeMs);
  }
}
