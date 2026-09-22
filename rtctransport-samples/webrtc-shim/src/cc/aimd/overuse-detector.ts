// Overuse Detector
// Implements inter-arrival time model for detecting network congestion.
// Based on the delay-based congestion detection in GCC.

export const OveruseState = {
  NORMAL: 'normal',
  OVERUSE: 'overuse',
  UNDERUSE: 'underuse',
} as const;

export type OveruseStateType =
    typeof OveruseState[keyof typeof OveruseState];

export interface OveruseDetectorOptions {
  initialThreshold?: number;
  minThreshold?: number;
  maxThreshold?: number;
}

/**
 * Adaptive threshold overuse detector.
 * Uses a Kalman-filter-like approach to estimate delay trend.
 */
export class OveruseDetector {
  threshold: number;
  minThreshold: number;
  maxThreshold: number;
  offset: number;
  prevOffset: number;
  slope: number;
  processNoise: number;
  measurementNoise: number;
  variance: number;
  state: OveruseStateType;
  overuseCounter: number;
  overuseTimeMs: number;
  lastUpdateMs: number;
  kUp: number;
  kDown: number;

  constructor({
    initialThreshold = 12.5,
    minThreshold = 6,
    maxThreshold = 600,
  }: OveruseDetectorOptions = {}) {
    this.threshold = initialThreshold;
    this.minThreshold = minThreshold;
    this.maxThreshold = maxThreshold;

    // Kalman filter state
    this.offset = 0;
    this.prevOffset = 0;
    this.slope = 8.0 / 512;
    this.processNoise = 1e-3;
    this.measurementNoise = 0;
    this.variance = 0.4;

    // State detection
    this.state = OveruseState.NORMAL;
    this.overuseCounter = 0;
    this.overuseTimeMs = 0;
    this.lastUpdateMs = 0;

    // Adaptive threshold parameters
    this.kUp = 0.0087;
    this.kDown = 0.039;
  }

  update(deltaMs: number, nowMs: number): void {
    const residual = deltaMs - this.offset;
    const adaptiveGain =
        this.variance / (this.variance + this.measurementNoise);

    this.offset += adaptiveGain * residual;
    this.variance = (1 - adaptiveGain) * this.variance + this.processNoise;

    this.measurementNoise = Math.max(
        this.measurementNoise +
            0.001 * (residual * residual - this.measurementNoise),
        0);

    this._detectState(nowMs);
    this._adaptThreshold();

    this.prevOffset = this.offset;
    this.lastUpdateMs = nowMs;
  }

  getState(): OveruseStateType {
    return this.state;
  }

  getOffset(): number {
    return this.offset;
  }

  private _detectState(nowMs: number): void {
    if (this.offset > this.threshold) {
      if (this.overuseTimeMs === 0) {
        this.overuseTimeMs = nowMs;
      }
      this.overuseCounter++;

      if (nowMs - this.overuseTimeMs > 100 && this.overuseCounter > 1) {
        this.state = OveruseState.OVERUSE;
      }
    } else if (this.offset < -this.threshold) {
      this.state = OveruseState.UNDERUSE;
      this.overuseCounter = 0;
      this.overuseTimeMs = 0;
    } else {
      this.state = OveruseState.NORMAL;
      this.overuseCounter = 0;
      this.overuseTimeMs = 0;
    }
  }

  private _adaptThreshold(): void {
    if (Math.abs(this.offset) < this.threshold) {
      this.threshold *= (1 + this.kUp);
    } else {
      this.threshold *= (1 - this.kDown);
    }
    this.threshold = Math.max(
        this.minThreshold, Math.min(this.maxThreshold, this.threshold));
  }
}
