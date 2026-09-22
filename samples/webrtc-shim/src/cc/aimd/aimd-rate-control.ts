// AIMD Rate Control (Additive Increase Multiplicative Decrease)
// Controls the target bitrate based on overuse detection signals.

import { OveruseState, type OveruseStateType } from './overuse-detector';

export interface AimdRateControlOptions {
  initialBitrateBps: number;
  minBitrateBps: number;
  maxBitrateBps: number;
}

/**
 * AIMD-based rate controller.
 * Increases rate additively when no congestion, decreases multiplicatively on
 * overuse.
 */
export class AimdRateControl {
  bitrateBps: number;
  minBitrateBps: number;
  maxBitrateBps: number;
  multiplicativeDecreaseFactor: number;
  additiveIncreasePerSec: number;
  lastUpdateMs: number;
  lastDecraseMs: number;
  inAlr: boolean;
  recentDecrease: boolean;

  constructor(
      { initialBitrateBps, minBitrateBps, maxBitrateBps }:
          AimdRateControlOptions) {
    this.bitrateBps = initialBitrateBps;
    this.minBitrateBps = minBitrateBps;
    this.maxBitrateBps = maxBitrateBps;

    // Rate control parameters
    this.multiplicativeDecreaseFactor = 0.85;
    this.additiveIncreasePerSec = 8000;

    // State
    this.lastUpdateMs = 0;
    this.lastDecraseMs = 0;
    this.inAlr = false;

    // Track whether we recently decreased (to avoid oscillation)
    this.recentDecrease = false;
  }

  update(state: OveruseStateType, nowMs: number): void {
    const dtMs = this.lastUpdateMs > 0 ? nowMs - this.lastUpdateMs : 0;
    this.lastUpdateMs = nowMs;

    switch (state) {
      case OveruseState.NORMAL:
        this._additiveIncrease(dtMs);
        this.recentDecrease = false;
        break;

      case OveruseState.OVERUSE:
        if (!this.recentDecrease || (nowMs - this.lastDecraseMs > 1000)) {
          this._multiplicativeDecrease();
          this.lastDecraseMs = nowMs;
          this.recentDecrease = true;
        }
        break;

      case OveruseState.UNDERUSE:
        this.recentDecrease = false;
        break;
    }
  }

  getEstimate(): number {
    return this.bitrateBps;
  }

  setEstimate(bps: number): void {
    this.bitrateBps =
        Math.max(this.minBitrateBps, Math.min(this.maxBitrateBps, bps));
  }

  private _additiveIncrease(dtMs: number): void {
    const increaseBps = this.additiveIncreasePerSec * (dtMs / 1000);
    this.bitrateBps =
        Math.min(this.maxBitrateBps, this.bitrateBps + increaseBps);
  }

  private _multiplicativeDecrease(): void {
    this.bitrateBps = Math.max(
        this.minBitrateBps,
        this.bitrateBps * this.multiplicativeDecreaseFactor);
  }
}
