import {
  BandwidthEstimator,
  type BandwidthEstimatorOptions,
  type DelayObservation,
} from './bandwidth-estimator';
import {
  GccController,
  type GccEstimate,
  type PacketFeedback,
} from './gcc/gcc-controller';

export type CongestionControlAlgorithm = 'simple'|'gcc';

export interface CongestionController {
  getStats(): Record<string, unknown>;
  getTargetBitrateBps(): number;
  onPacketAcked(seqNum: number, arrivalTimeMs: number): void;
  onPacketSent(sizeBytes: number, sendTimeMs: number, seqNum: number): void;
  onRtcpFeedback(rttMs: number, fractionLost: number, atTimeMs: number): void;
}

interface CongestionControllerOptions {
  initialBps?: number;
  maxBps?: number;
  minBps?: number;
}

interface SentPacketInfo {
  sendTimeMs: number;
  sizeBytes: number;
}

interface PreviousAckSample {
  arrivalTimeMs: number;
  sendTimeMs: number;
}

class SimpleCongestionController implements CongestionController {
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

class GccCongestionController implements CongestionController {
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

/**
 * Creates a congestion controller wrapper for the selected algorithm.
 */
export function createCongestionController(
    algorithm: CongestionControlAlgorithm,
    options: CongestionControllerOptions = {}): CongestionController {
  switch (algorithm) {
    case 'simple':
      return new SimpleCongestionController(options);
    case 'gcc':
      return new GccCongestionController(options);
  }
}

export type { GccEstimate };
