/**
 * Full Google Congestion Control (GCC) pipeline for the RtcTransport sample.
 *
 * This controller combines transport-wide packet feedback with delay-based
 * trendline detection, AIMD rate control, acknowledged throughput estimation,
 * and receiver-report loss adaptation. The structure matches the send-side GCC
 * pipeline deployed in WebRTC and aligned with RFC 8698 terminology.
 */

import {
  AcknowledgedBitrateEstimator,
  type AckedPacket,
} from './acknowledged-bitrate-estimator';
import { GccAimdRateControl } from './aimd-rate-control';
import { InterArrivalDelta } from './inter-arrival';
import { LossBasedBwe } from './loss-based-bwe';
import {
  TrendlineEstimator,
  type BandwidthUsage,
} from './trendline-estimator';

export interface PacketFeedback {
  arrivalTimeMs: number;
  sendTimeMs: number;
  sequenceNumber: number;
  sizeBytes: number;
}

export interface GccEstimate {
  acknowledgedBps: number|null;
  bwState: BandwidthUsage;
  delayBasedBps: number;
  lossBasedBps: number;
  rttMs: number;
  targetBitrateBps: number;
}

interface GccControllerOptions {
  initialBps?: number;
  maxBps?: number;
  minBps?: number;
}

const DEFAULT_INITIAL_BPS = 300000;
const DEFAULT_MAX_BPS = 2000000;
const DEFAULT_MIN_BPS = 30000;

/**
 * Send-side GCC controller.
 */
export class GccController {
  acknowledgedBitrateEstimator: AcknowledgedBitrateEstimator;
  aimdRateControl: GccAimdRateControl;
  currentEstimate: GccEstimate;
  interArrivalDelta: InterArrivalDelta;
  lossBasedBwe: LossBasedBwe;
  maxBitrateBps: number;
  minBitrateBps: number;
  trendlineEstimator: TrendlineEstimator;

  constructor({
    initialBps = DEFAULT_INITIAL_BPS,
    minBps = DEFAULT_MIN_BPS,
    maxBps = DEFAULT_MAX_BPS,
  }: GccControllerOptions = {}) {
    this.minBitrateBps = minBps;
    this.maxBitrateBps = maxBps;
    this.interArrivalDelta = new InterArrivalDelta();
    this.trendlineEstimator = new TrendlineEstimator();
    this.acknowledgedBitrateEstimator = new AcknowledgedBitrateEstimator();
    this.aimdRateControl = new GccAimdRateControl({
      initialBps,
      minBps,
      maxBps,
    });
    this.lossBasedBwe = new LossBasedBwe({
      minBps,
      maxBps,
    });
    this.currentEstimate = {
      acknowledgedBps: null,
      bwState: 'normal',
      delayBasedBps: initialBps,
      lossBasedBps: this.lossBasedBwe.getEstimateBps(),
      rttMs: 0,
      targetBitrateBps: initialBps,
    };
  }

  /**
   * Processes transport feedback and returns an updated bandwidth estimate.
   */
  onTransportFeedback(
      packets: PacketFeedback[], atTimeMs: number): GccEstimate {
    if (packets.length === 0) {
      return this.getEstimate();
    }

    const sortedPackets = [...packets].sort((left, right) => {
      if (left.arrivalTimeMs !== right.arrivalTimeMs) {
        return left.arrivalTimeMs - right.arrivalTimeMs;
      }
      if (left.sendTimeMs !== right.sendTimeMs) {
        return left.sendTimeMs - right.sendTimeMs;
      }
      return left.sequenceNumber - right.sequenceNumber;
    });

    const ackedPackets: AckedPacket[] = sortedPackets.map((packet) => ({
      arrivalTimeMs: packet.arrivalTimeMs,
      sendTimeMs: packet.sendTimeMs,
      sizeBytes: packet.sizeBytes,
    }));
    this.acknowledgedBitrateEstimator.update(ackedPackets);

    for (const packet of sortedPackets) {
      const deltas = this.interArrivalDelta.computeDeltas(
          packet.sendTimeMs, packet.arrivalTimeMs, packet.sizeBytes);
      if (!deltas) {
        continue;
      }

      this.trendlineEstimator.update(
          deltas.arrivalDeltaMs, deltas.sendDeltaMs, packet.arrivalTimeMs,
          packet.sizeBytes);
    }

    const acknowledgedBps =
        this.acknowledgedBitrateEstimator.getEstimateBps();
    const bwState = this.trendlineEstimator.state();
    this.aimdRateControl.update(bwState, acknowledgedBps, atTimeMs);

    const delayBasedBps = this.aimdRateControl.getEstimateBps();
    const lossBasedBps = this.lossBasedBwe.getEstimateBps();
    this.currentEstimate = {
      acknowledgedBps,
      bwState,
      delayBasedBps,
      lossBasedBps,
      rttMs: this.currentEstimate.rttMs,
      targetBitrateBps: this.clampBitrate(
          Math.min(delayBasedBps, lossBasedBps)),
    };
    return this.getEstimate();
  }

  /**
   * Processes receiver-report based RTT and loss feedback.
   */
  onRtcpFeedback(rttMs: number, fractionLost: number, atTimeMs: number): void {
    this.aimdRateControl.setRttMs(rttMs);
    this.lossBasedBwe.updateRtt(rttMs, atTimeMs);

    if (fractionLost <= 1) {
      this.lossBasedBwe.updatePacketsLost(
          Math.max(0, fractionLost) * 1000, 1000, atTimeMs);
    } else {
      this.lossBasedBwe.updatePacketsLost(
          Math.max(0, fractionLost), 256, atTimeMs);
    }

    const delayBasedBps = this.aimdRateControl.getEstimateBps();
    const lossBasedBps = this.lossBasedBwe.getEstimateBps();
    this.currentEstimate = {
      ...this.currentEstimate,
      delayBasedBps,
      lossBasedBps,
      rttMs,
      targetBitrateBps: this.clampBitrate(
          Math.min(delayBasedBps, lossBasedBps)),
    };
  }

  getEstimate(): GccEstimate {
    return { ...this.currentEstimate };
  }

  private clampBitrate(bitrateBps: number): number {
    return Math.min(
        this.maxBitrateBps, Math.max(this.minBitrateBps, bitrateBps));
  }
}
