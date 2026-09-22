/**
 * AIMD rate control for Google Congestion Control (GCC).
 *
 * This mirrors WebRTC's aimd_rate_control.cc high-level behavior: delay-based
 * state transitions drive Hold/Increase/Decrease updates, with multiplicative
 * decrease on overuse and additive or multiplicative increase when bandwidth is
 * stable.
 */

import type { BandwidthUsage } from './trendline-estimator';

interface GccAimdRateControlOptions {
  beta?: number;
  initialBps?: number;
  maxBps?: number;
  minBps?: number;
}

type RateControlState = 'hold'|'increase'|'decrease';

const DEFAULT_INITIAL_BPS = 300000;
const DEFAULT_MAX_BPS = 2000000;
const DEFAULT_MIN_BPS = 30000;
const DEFAULT_RTT_MS = 200;
const DEFAULT_PACKET_SIZE_BYTES = 1200;
const ADDITIVE_INCREASE_MIN_BPS_PER_SEC = 4000;
const ESTIMATED_THROUGHPUT_CAP_BPS = 10000;
const MULTIPLICATIVE_INCREASE_ALPHA = 1.08;
const SAFETY_MARGIN_BPS = 5000;

class LinkCapacityTracker {
  deviationBps: number;
  estimateBps: number|null;

  constructor() {
    this.estimateBps = null;
    this.deviationBps = 0;
  }

  hasEstimate(): boolean {
    return this.estimateBps !== null;
  }

  lowerBoundBps(): number|null {
    if (this.estimateBps === null) {
      return null;
    }
    return Math.max(0, this.estimateBps - 3 * this.deviationBps);
  }

  onOveruse(throughputBps: number): void {
    if (this.estimateBps === null) {
      this.estimateBps = throughputBps;
      this.deviationBps = throughputBps * 0.4;
      return;
    }

    const error = throughputBps - this.estimateBps;
    this.estimateBps += 0.05 * error;
    this.deviationBps += 0.05 * (Math.abs(error) - this.deviationBps);
  }
}

/**
 * Delay-based GCC AIMD controller.
 */
export class GccAimdRateControl {
  beta: number;
  currentBitrateBps: number;
  initialized: boolean;
  lastUpdateMs: number|null;
  linkCapacityTracker: LinkCapacityTracker;
  maxBitrateBps: number;
  minBitrateBps: number;
  rttMs: number;
  state: RateControlState;

  constructor({
    initialBps = DEFAULT_INITIAL_BPS,
    minBps = DEFAULT_MIN_BPS,
    maxBps = DEFAULT_MAX_BPS,
    beta = 0.85,
  }: GccAimdRateControlOptions) {
    this.currentBitrateBps = initialBps;
    this.minBitrateBps = minBps;
    this.maxBitrateBps = maxBps;
    this.beta = beta;
    this.state = 'hold';
    this.rttMs = DEFAULT_RTT_MS;
    this.lastUpdateMs = null;
    this.initialized = false;
    this.linkCapacityTracker = new LinkCapacityTracker();
  }

  /**
   * Updates the bitrate estimate from delay state and throughput feedback.
   */
  update(
      bwState: BandwidthUsage, estimatedThroughputBps: number|null,
      atTimeMs: number): void {
    if (estimatedThroughputBps !== null && !this.initialized) {
      this.currentBitrateBps =
          this.clampBitrate(Math.max(this.currentBitrateBps,
              estimatedThroughputBps));
      this.initialized = true;
    }

    this.changeState(bwState);

    if (this.lastUpdateMs === null) {
      this.lastUpdateMs = atTimeMs;
    }
    const deltaTimeMs = Math.max(0, atTimeMs - this.lastUpdateMs);
    this.lastUpdateMs = atTimeMs;

    switch (this.state) {
      case 'hold':
        break;
      case 'increase':
        this.increase(deltaTimeMs, estimatedThroughputBps);
        break;
      case 'decrease':
        this.decrease(estimatedThroughputBps);
        break;
    }
  }

  getEstimateBps(): number {
    return this.currentBitrateBps;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  setRttMs(rttMs: number): void {
    this.rttMs = Math.max(0, rttMs);
  }

  private changeState(bwState: BandwidthUsage): void {
    switch (bwState) {
      case 'normal':
        if (this.state === 'hold') {
          this.state = 'increase';
        }
        break;
      case 'overusing':
        this.state = 'decrease';
        break;
      case 'underusing':
        this.state = 'hold';
        break;
    }
  }

  private clampBitrate(bitrateBps: number): number {
    return Math.min(
        this.maxBitrateBps, Math.max(this.minBitrateBps, bitrateBps));
  }

  private decrease(estimatedThroughputBps: number|null): void {
    if (estimatedThroughputBps === null) {
      this.state = 'hold';
      return;
    }

    this.linkCapacityTracker.onOveruse(estimatedThroughputBps);
    const reducedBitrateBps =
        this.beta * estimatedThroughputBps - SAFETY_MARGIN_BPS;
    this.currentBitrateBps = this.clampBitrate(
        Math.min(this.currentBitrateBps, reducedBitrateBps));
    this.initialized = true;
    this.state = 'hold';
  }

  private increase(
      deltaTimeMs: number, estimatedThroughputBps: number|null): void {
    if (deltaTimeMs <= 0) {
      return;
    }

    const deltaTimeSeconds = deltaTimeMs / 1000;
    if (this.isNearCapacity()) {
      const responseTimeMs = 2 * (this.rttMs + 100);
      const additiveIncreaseBpsPerSecond = Math.max(
          ADDITIVE_INCREASE_MIN_BPS_PER_SEC,
          DEFAULT_PACKET_SIZE_BYTES * 8 * 1000 / responseTimeMs);
      this.currentBitrateBps = this.clampBitrate(
          this.currentBitrateBps +
          additiveIncreaseBpsPerSecond * deltaTimeSeconds);
    } else {
      this.currentBitrateBps = this.clampBitrate(
          this.currentBitrateBps *
          Math.pow(MULTIPLICATIVE_INCREASE_ALPHA, deltaTimeSeconds));
    }

    if (estimatedThroughputBps !== null) {
      this.currentBitrateBps = Math.min(
          this.currentBitrateBps,
          1.5 * estimatedThroughputBps + ESTIMATED_THROUGHPUT_CAP_BPS);
    }
  }

  private isNearCapacity(): boolean {
    const lowerBoundBps = this.linkCapacityTracker.lowerBoundBps();
    return lowerBoundBps !== null && this.currentBitrateBps >= lowerBoundBps;
  }
}
