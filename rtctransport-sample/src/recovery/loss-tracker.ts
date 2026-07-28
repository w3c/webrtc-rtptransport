// Loss Tracker
// Monitors packet loss patterns to decide between NACK and PLI strategies.

export interface LossTrackerOptions {
  windowSize?: number;
  burstThreshold?: number;
  maxNackAge?: number;
}

interface ReceptionEntry {
  seq: number;
  received: boolean;
  timeMs: number;
}

export type RecoveryStrategy = 'nack'|'pli'|'none';

/**
 * Tracks packet loss patterns and decides recovery strategy.
 */
export class LossTracker {
  windowSize: number;
  burstThreshold: number;
  maxNackAge: number;
  receptionHistory: ReceptionEntry[];
  lastReceivedSeq: number;
  consecutiveLosses: number;
  totalLost: number;
  totalExpected: number;

  constructor({
    windowSize = 100,
    burstThreshold = 5,
    maxNackAge = 500,
  }: LossTrackerOptions = {}) {
    this.windowSize = windowSize;
    this.burstThreshold = burstThreshold;
    this.maxNackAge = maxNackAge;

    this.receptionHistory = [];
    this.lastReceivedSeq = -1;
    this.consecutiveLosses = 0;
    this.totalLost = 0;
    this.totalExpected = 0;
  }

  onReceived(seq: number, timeMs: number): void {
    this._addEntry(seq, true, timeMs);
    this.consecutiveLosses = 0;
    this.lastReceivedSeq = seq;
  }

  onGapDetected(missingSeqs: number[], timeMs: number): void {
    for (const seq of missingSeqs) {
      this._addEntry(seq, false, timeMs);
      this.totalLost++;
    }
    this.consecutiveLosses += missingSeqs.length;
    this.totalExpected += missingSeqs.length;
  }

  getRecoveryStrategy(): RecoveryStrategy {
    if (this.consecutiveLosses >= this.burstThreshold) {
      return 'pli';
    }

    if (this.consecutiveLosses > 0) {
      return 'nack';
    }

    return 'none';
  }

  isTooOldForNack(lostTimeMs: number, nowMs: number): boolean {
    return (nowMs - lostTimeMs) > this.maxNackAge;
  }

  getLossRate(): number {
    if (this.totalExpected === 0) {
      return 0;
    }
    return this.totalLost / this.totalExpected;
  }

  private _addEntry(seq: number, received: boolean, timeMs: number): void {
    this.receptionHistory.push({ seq, received, timeMs });
    this.totalExpected++;

    while (this.receptionHistory.length > this.windowSize) {
      const removed = this.receptionHistory.shift();
      this.totalExpected--;
      if (removed && !removed.received) {
        this.totalLost--;
      }
    }
  }
}
