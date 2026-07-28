// Adaptive Jitter Buffer (Phase 2)
// NetEQ-inspired adaptive playout delay based on observed jitter.

import type {BufferedPacket} from './jitter-buffer';

export interface AdaptiveJitterBufferOptions {
  clockRate: number;
  onPlayoutReady: (packet: BufferedPacket) => void;
  minDelayMs?: number;
  maxDelayMs?: number;
  targetDelayMs?: number;
  maxSize?: number;
}

export interface AdaptiveJitterBufferStats {
  received: number;
  played: number;
  dropped: number;
  expanded: number;
  accelerated: number;
  currentDelayMs: number;
  jitterMs: number;
  bufferSize: number;
}

type InternalAdaptiveJitterBufferStats =
    Omit<AdaptiveJitterBufferStats, 'jitterMs'|'bufferSize'>;

/**
 * Adaptive audio jitter buffer that adjusts playout delay dynamically.
 */
export class AdaptiveJitterBuffer {
  clockRate: number;
  onPlayoutReady: AdaptiveJitterBufferOptions['onPlayoutReady'];
  minDelayMs: number;
  maxDelayMs: number;
  targetDelayMs: number;
  maxSize: number;
  buffer: BufferedPacket[];
  nextExpectedSeq: number;
  playoutStartTime: number;
  firstPacketTimestamp: number;
  timerId: number | null;
  started: boolean;
  jitterMs: number;
  lastArrivalMs: number;
  lastTimestamp: number;
  adaptationAlpha: number;
  peakJitterMs: number;
  peakDecayFactor: number;
  stats: InternalAdaptiveJitterBufferStats;

  constructor({
    clockRate,
    onPlayoutReady,
    minDelayMs = 20,
    maxDelayMs = 400,
    targetDelayMs = 60,
    maxSize = 200,
  }: AdaptiveJitterBufferOptions) {
    this.clockRate = clockRate;
    this.onPlayoutReady = onPlayoutReady;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.targetDelayMs = targetDelayMs;
    this.maxSize = maxSize;

    this.buffer = [];
    this.nextExpectedSeq = -1;
    this.playoutStartTime = 0;
    this.firstPacketTimestamp = 0;
    this.timerId = null;
    this.started = false;

    // Jitter estimation (exponential moving average)
    this.jitterMs = 0;
    this.lastArrivalMs = 0;
    this.lastTimestamp = 0;

    // Delay adaptation
    this.adaptationAlpha = 0.01;  // Slow adaptation
    this.peakJitterMs = 0;
    this.peakDecayFactor = 0.999;

    // Statistics
    this.stats = {
      received: 0,
      played: 0,
      dropped: 0,
      expanded: 0,  // Playout stretching (to increase delay)
      accelerated: 0,  // Playout shrinking (to decrease delay)
      currentDelayMs: targetDelayMs,
    };
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.timerId = setInterval((): void => this._checkPlayout(), 5);
  }

  stop(): void {
    this.started = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Insert a packet into the buffer.
   */
  insert(packet: BufferedPacket): void {
    this.stats.received++;
    const now = packet.receiveTime;

    // Update jitter estimate
    if (this.lastArrivalMs > 0) {
      const arrivalDeltaMs = now - this.lastArrivalMs;
      const expectedDeltaMs =
          (((packet.timestamp - this.lastTimestamp) >>> 0) / this.clockRate) *
          1000;
      const jitterSample = Math.abs(arrivalDeltaMs - expectedDeltaMs);

      // EMA jitter
      this.jitterMs += 0.0625 * (jitterSample - this.jitterMs);

      // Peak jitter with decay
      this.peakJitterMs =
          Math.max(this.peakJitterMs * this.peakDecayFactor, jitterSample);
    }
    this.lastArrivalMs = now;
    this.lastTimestamp = packet.timestamp;

    // Adapt target delay
    this._adaptDelay();

    // Initialize on first packet
    if (this.nextExpectedSeq === -1) {
      this.nextExpectedSeq = packet.sequenceNumber;
      this.playoutStartTime = now + this.targetDelayMs;
      this.firstPacketTimestamp = packet.timestamp;
    }

    // Drop if too late
    if (this.buffer.length >= this.maxSize) {
      this.stats.dropped++;
      return;
    }

    // Insert in order
    const idx = this._findInsertIndex(packet.sequenceNumber);
    if (idx === -1) {
      return;  // Duplicate
    }
    this.buffer.splice(idx, 0, packet);
  }

  getStats(): AdaptiveJitterBufferStats {
    return {
      ...this.stats,
      jitterMs: this.jitterMs,
      bufferSize: this.buffer.length,
    };
  }

  _adaptDelay(): void {
    // Target delay = base + peak_jitter * safety_margin
    const newTarget = this.minDelayMs + this.peakJitterMs * 2;
    const clamped = Math.max(this.minDelayMs, Math.min(this.maxDelayMs, newTarget));

    // Smooth adaptation
    this.targetDelayMs += this.adaptationAlpha * (clamped - this.targetDelayMs);
    this.stats.currentDelayMs = Math.round(this.targetDelayMs);
  }

  _checkPlayout(): void {
    const now = performance.now();

    while (this.buffer.length > 0) {
      const packet = this.buffer[0];
      const timestampDiff = (packet.timestamp - this.firstPacketTimestamp) >>> 0;
      const timeDiffMs = (timestampDiff / this.clockRate) * 1000;
      const playoutTime = this.playoutStartTime + timeDiffMs;

      if (now >= playoutTime) {
        this.buffer.shift();
        this.nextExpectedSeq = (packet.sequenceNumber + 1) & 0xFFFF;
        this.stats.played++;
        this.onPlayoutReady(packet);
      } else {
        break;
      }
    }
  }

  _findInsertIndex(seq: number): number {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const diff = this._seqDiff(seq, this.buffer[i].sequenceNumber);
      if (diff === 0) {
        return -1;
      }
      if (diff > 0) {
        return i + 1;
      }
    }
    return 0;
  }

  _seqDiff(a: number, b: number): number {
    let diff = (a - b) & 0xFFFF;
    if (diff > 0x7FFF) {
      diff -= 0x10000;
    }
    return diff;
  }
}
