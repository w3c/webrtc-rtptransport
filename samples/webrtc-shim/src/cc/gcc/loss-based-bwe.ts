/**
 * Loss-based bandwidth estimation for GCC.
 *
 * This is a lightweight send-side loss controller inspired by WebRTC's
 * send_side_bandwidth_estimation.cc, using the commonly deployed 2% and 10%
 * loss thresholds from GCC deployments.
 */

interface LossBasedBweOptions {
  maxBps?: number;
  minBps?: number;
}

interface BitrateHistorySample {
  atTimeMs: number;
  bitrateBps: number;
}

const DEFAULT_MAX_BPS = 2000000;
const DEFAULT_MIN_BPS = 30000;
const HISTORY_WINDOW_MS = 10000;
const HIGH_LOSS_THRESHOLD = 0.10;
const HIGH_RTT_THRESHOLD_MS = 300;
const LOW_LOSS_THRESHOLD = 0.02;
const RTT_BACKOFF_FACTOR = 0.9;
const RTT_BACKOFF_INTERVAL_MS = 1000;
const RTT_BACKOFF_PERSISTENCE_MS = 3000;

/**
 * Receiver-report driven loss-based bandwidth estimator.
 */
export class LossBasedBwe {
  bitrateHistory: BitrateHistorySample[];
  currentEstimateBps: number;
  highRttStartMs: number|null;
  lastRttBackoffMs: number|null;
  maxBitrateBps: number;
  minBitrateBps: number;

  constructor({
    minBps = DEFAULT_MIN_BPS,
    maxBps = DEFAULT_MAX_BPS,
  }: LossBasedBweOptions = {}) {
    this.minBitrateBps = minBps;
    this.maxBitrateBps = maxBps;
    this.currentEstimateBps = maxBps;
    this.bitrateHistory = [];
    this.highRttStartMs = null;
    this.lastRttBackoffMs = null;
  }

  /**
   * Updates the loss-based estimate from packet loss feedback.
   */
  updatePacketsLost(
      packetsLost: number, totalPackets: number, atTimeMs: number): void {
    if (totalPackets <= 0) {
      return;
    }

    const lossRate =
        Math.max(0, Math.min(1, packetsLost / Math.max(1, totalPackets)));
    const minRecentBitrateBps = this.getMinRecentBitrateBps(atTimeMs);

    if (lossRate < LOW_LOSS_THRESHOLD) {
      let nextBitrateBps = this.currentEstimateBps * 1.05;
      if (minRecentBitrateBps !== null) {
        nextBitrateBps =
            Math.min(nextBitrateBps, minRecentBitrateBps * 1.5);
      }
      this.currentEstimateBps = this.clampBitrate(nextBitrateBps);
    } else if (lossRate >= HIGH_LOSS_THRESHOLD) {
      const decreaseBps = 0.5 * lossRate * this.currentEstimateBps;
      this.currentEstimateBps =
          this.clampBitrate(this.currentEstimateBps - decreaseBps);
    }

    this.recordBitrate(atTimeMs);
  }

  /**
   * Applies RTT-aware backoff when round-trip time remains elevated.
   */
  updateRtt(rttMs: number, atTimeMs: number): void {
    if (rttMs > HIGH_RTT_THRESHOLD_MS) {
      if (this.highRttStartMs === null) {
        this.highRttStartMs = atTimeMs;
      }

      const rttSustainedMs = atTimeMs - this.highRttStartMs;
      const canBackoff = this.lastRttBackoffMs === null ||
          atTimeMs - this.lastRttBackoffMs >= RTT_BACKOFF_INTERVAL_MS;
      if (rttSustainedMs >= RTT_BACKOFF_PERSISTENCE_MS && canBackoff) {
        this.currentEstimateBps =
            this.clampBitrate(this.currentEstimateBps * RTT_BACKOFF_FACTOR);
        this.lastRttBackoffMs = atTimeMs;
        this.recordBitrate(atTimeMs);
      }
      return;
    }

    this.highRttStartMs = null;
    this.lastRttBackoffMs = null;
  }

  getEstimateBps(): number {
    return this.currentEstimateBps;
  }

  private clampBitrate(bitrateBps: number): number {
    return Math.min(
        this.maxBitrateBps, Math.max(this.minBitrateBps, bitrateBps));
  }

  private getMinRecentBitrateBps(atTimeMs: number): number|null {
    this.pruneHistory(atTimeMs);
    if (this.bitrateHistory.length === 0) {
      return null;
    }

    return this.bitrateHistory.reduce(
        (minBitrateBps, sample) => Math.min(minBitrateBps, sample.bitrateBps),
        this.bitrateHistory[0]!.bitrateBps);
  }

  private pruneHistory(atTimeMs: number): void {
    this.bitrateHistory = this.bitrateHistory.filter(
        (sample) => atTimeMs - sample.atTimeMs <= HISTORY_WINDOW_MS);
  }

  private recordBitrate(atTimeMs: number): void {
    this.bitrateHistory.push({
      atTimeMs,
      bitrateBps: this.currentEstimateBps,
    });
    this.pruneHistory(atTimeMs);
  }
}
