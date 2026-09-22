// GCC-like Bandwidth Estimator
// Implements delay-based and loss-based bandwidth estimation
// inspired by Google Congestion Control (draft-ietf-rmcat-gcc).

import {
  OveruseDetector,
  type OveruseStateType,
} from './overuse-detector';
import { AimdRateControl } from './aimd-rate-control';

export interface BandwidthEstimatorOptions {
  initialBitrateBps?: number;
  minBitrateBps?: number;
  maxBitrateBps?: number;
}

export interface DelayObservation {
  owdDelta: number;
}

export interface BandwidthEstimatorStats {
  delayBasedBps: number;
  lossBasedBps: number;
  effectiveBps: number;
  overuseState: OveruseStateType;
}

/**
 * Bandwidth estimator combining delay-based and loss-based estimates.
 */
export class BandwidthEstimator {
  minBitrateBps: number;
  maxBitrateBps: number;
  currentBitrateBps: number;
  overuseDetector: OveruseDetector;
  aimdController: AimdRateControl;
  lossBitrateBps: number;
  lastLossUpdateMs: number;
  stats: BandwidthEstimatorStats;

  constructor({
    initialBitrateBps = 300000,
    minBitrateBps = 30000,
    maxBitrateBps = 2000000,
  }: BandwidthEstimatorOptions = {}) {
    this.minBitrateBps = minBitrateBps;
    this.maxBitrateBps = maxBitrateBps;
    this.currentBitrateBps = initialBitrateBps;

    this.overuseDetector = new OveruseDetector();
    this.aimdController = new AimdRateControl({
      initialBitrateBps,
      minBitrateBps,
      maxBitrateBps,
    });

    this.lossBitrateBps = maxBitrateBps;
    this.lastLossUpdateMs = 0;

    this.stats = {
      delayBasedBps: initialBitrateBps,
      lossBasedBps: maxBitrateBps,
      effectiveBps: initialBitrateBps,
      overuseState: 'normal',
    };
  }

  onDelayFeedback(delayObservations: DelayObservation[], nowMs: number): void {
    for (const obs of delayObservations) {
      this.overuseDetector.update(obs.owdDelta, nowMs);
    }

    const state = this.overuseDetector.getState();
    this.stats.overuseState = state;

    this.aimdController.update(state, nowMs);
    this.stats.delayBasedBps = this.aimdController.getEstimate();

    this._updateEffective();
  }

  onLossFeedback(fractionLost: number, nowMs: number): void {
    const lossRate = fractionLost / 256;

    if (lossRate < 0.02) {
      this.lossBitrateBps =
          Math.min(this.maxBitrateBps, this.lossBitrateBps * 1.05);
    } else if (lossRate < 0.10) {
      // Moderate loss: maintain
    } else {
      this.lossBitrateBps = Math.max(
          this.minBitrateBps,
          this.currentBitrateBps * (1 - 0.5 * lossRate));
    }

    this.stats.lossBasedBps = this.lossBitrateBps;
    this.lastLossUpdateMs = nowMs;
    this._updateEffective();
  }

  getEstimate(): number {
    return this.currentBitrateBps;
  }

  getStats(): BandwidthEstimatorStats {
    return { ...this.stats };
  }

  private _updateEffective(): void {
    this.currentBitrateBps = Math.max(
        this.minBitrateBps,
        Math.min(
            this.stats.delayBasedBps, this.lossBitrateBps,
            this.maxBitrateBps));
    this.stats.effectiveBps = this.currentBitrateBps;
  }
}
