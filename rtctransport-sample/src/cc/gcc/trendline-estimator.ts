/**
 * Delay trend estimation for Google Congestion Control (GCC).
 *
 * This is the trendline delay detector from WebRTC's trendline_estimator.cc,
 * expressed in TypeScript for transport-feedback based congestion control as
 * described by RFC 8698.
 */

export type BandwidthUsage = 'normal'|'overusing'|'underusing';

interface DelaySample {
  arrivalTimeMs: number;
  smoothedDelayMs: number;
}

const DEFAULT_WINDOW_SIZE = 20;
const DELTA_COUNTER_MAX = 1000;
const MIN_NUM_DELTAS = 60;
const OVERUSING_TIME_THRESHOLD_MS = 10;
const MAX_ADAPT_OFFSET_MS = 15;
const THRESHOLD_GAIN = 4.0;
const SMOOTHING_COEFFICIENT = 0.9;
const THRESHOLD_INITIAL = 12.5;
const THRESHOLD_MIN = 6;
const THRESHOLD_MAX = 600;
const K_UP = 0.0087;
const K_DOWN = 0.039;

/**
 * Least-squares trendline detector operating on smoothed delay.
 */
export class TrendlineEstimator {
  accumulatedDelayMs: number;
  delaySamples: DelaySample[];
  hypothesis: BandwidthUsage;
  lastThresholdUpdateMs: number|null;
  numDeltas: number;
  overuseCounter: number;
  previousTrend: number;
  smoothedDelayMs: number;
  threshold: number;
  timeOverUsingMs: number;
  windowSize: number;

  constructor(windowSize: number = DEFAULT_WINDOW_SIZE) {
    this.windowSize = windowSize;
    this.accumulatedDelayMs = 0;
    this.smoothedDelayMs = 0;
    this.delaySamples = [];
    this.numDeltas = 0;
    this.threshold = THRESHOLD_INITIAL;
    this.hypothesis = 'normal';
    this.timeOverUsingMs = -1;
    this.overuseCounter = 0;
    this.previousTrend = 0;
    this.lastThresholdUpdateMs = null;
  }

  /**
   * Updates the trendline with an inter-group delay delta.
   */
  update(
      recvDeltaMs: number, sendDeltaMs: number, arrivalTimeMs: number,
      packetSize: number): void {
    void packetSize;

    const deltaMs = recvDeltaMs - sendDeltaMs;
    this.accumulatedDelayMs += deltaMs;
    this.smoothedDelayMs = this.numDeltas === 0 ? this.accumulatedDelayMs :
                                               SMOOTHING_COEFFICIENT *
            this.smoothedDelayMs +
            (1 - SMOOTHING_COEFFICIENT) * this.accumulatedDelayMs;

    this.delaySamples.push({
      arrivalTimeMs,
      smoothedDelayMs: this.smoothedDelayMs,
    });
    if (this.delaySamples.length > this.windowSize) {
      this.delaySamples.shift();
    }

    this.numDeltas = Math.min(this.numDeltas + 1, DELTA_COUNTER_MAX);

    if (this.delaySamples.length < 2) {
      return;
    }

    const trend = this.computeTrend();
    const modifiedTrend = Math.min(this.numDeltas, MIN_NUM_DELTAS) * trend *
        THRESHOLD_GAIN;

    this.detect(modifiedTrend, trend, recvDeltaMs);
    this.updateThreshold(modifiedTrend, arrivalTimeMs);
    this.previousTrend = trend;
  }

  state(): BandwidthUsage {
    return this.hypothesis;
  }

  private computeTrend(): number {
    const firstArrivalTimeMs = this.delaySamples[0]!.arrivalTimeMs;
    const normalizedSamples = this.delaySamples.map((sample) => ({
      x: sample.arrivalTimeMs - firstArrivalTimeMs,
      y: sample.smoothedDelayMs,
    }));

    const xMean = normalizedSamples.reduce((sum, sample) => sum + sample.x, 0) /
        normalizedSamples.length;
    const yMean = normalizedSamples.reduce((sum, sample) => sum + sample.y, 0) /
        normalizedSamples.length;

    let numerator = 0;
    let denominator = 0;
    for (const sample of normalizedSamples) {
      const xDelta = sample.x - xMean;
      numerator += xDelta * (sample.y - yMean);
      denominator += xDelta * xDelta;
    }

    if (denominator === 0) {
      return 0;
    }

    return numerator / denominator;
  }

  private detect(
      modifiedTrend: number, trend: number, recvDeltaMs: number): void {
    if (modifiedTrend > this.threshold) {
      if (this.timeOverUsingMs < 0) {
        this.timeOverUsingMs = recvDeltaMs / 2;
      } else {
        this.timeOverUsingMs += recvDeltaMs;
      }

      this.overuseCounter =
          Math.min(this.overuseCounter + 1, DELTA_COUNTER_MAX);

      if (this.timeOverUsingMs > OVERUSING_TIME_THRESHOLD_MS &&
          this.overuseCounter > 1 && trend >= this.previousTrend) {
        this.hypothesis = 'overusing';
      }
      return;
    }

    this.timeOverUsingMs = -1;
    this.overuseCounter = 0;

    if (modifiedTrend < -this.threshold) {
      this.hypothesis = 'underusing';
      return;
    }

    this.hypothesis = 'normal';
  }

  private updateThreshold(
      modifiedTrend: number, arrivalTimeMs: number): void {
    const absModifiedTrend = Math.abs(modifiedTrend);
    if (this.lastThresholdUpdateMs === null) {
      this.lastThresholdUpdateMs = arrivalTimeMs;
      return;
    }

    const deltaTimeMs =
        Math.min(arrivalTimeMs - this.lastThresholdUpdateMs, 100);
    this.lastThresholdUpdateMs = arrivalTimeMs;
    if (deltaTimeMs <= 0 ||
        absModifiedTrend > this.threshold + MAX_ADAPT_OFFSET_MS) {
      return;
    }

    const k = absModifiedTrend < this.threshold ? K_DOWN : K_UP;
    this.threshold += k * (absModifiedTrend - this.threshold) * deltaTimeMs;
    this.threshold =
        Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, this.threshold));
  }
}
