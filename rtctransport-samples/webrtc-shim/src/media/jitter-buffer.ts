// Fixed-Delay Jitter Buffer (Phase 1)
// Reorders packets by sequence number and applies a fixed playout delay.

export interface BufferedPacket {
  sequenceNumber: number;
  timestamp: number;
  payload: Uint8Array;
  receiveTime: number;
}

export interface JitterBufferStats {
  received: number;
  played: number;
  dropped: number;
  reordered: number;
  bufferSize: number;
}

export interface JitterBufferOptions {
  delayMs?: number;
  maxSize?: number;
  clockRate: number;
  onPlayoutReady: (packet: BufferedPacket) => void;
}

type InternalJitterBufferStats = Omit<JitterBufferStats, 'bufferSize'>;

/**
 * Simple fixed-delay jitter buffer.
 * Holds packets for a fixed duration before releasing them in order.
 */
export class JitterBuffer {
  delayMs: number;
  maxSize: number;
  clockRate: number;
  onPlayoutReady: JitterBufferOptions['onPlayoutReady'];
  buffer: BufferedPacket[];
  nextExpectedSeq: number;
  playoutTimerId: number | null;
  started: boolean;
  playoutStartTime: number;
  firstPacketTimestamp: number;
  stats: InternalJitterBufferStats;

  constructor({
    delayMs = 60,
    maxSize = 100,
    clockRate,
    onPlayoutReady,
  }: JitterBufferOptions) {
    this.delayMs = delayMs;
    this.maxSize = maxSize;
    this.clockRate = clockRate;
    this.onPlayoutReady = onPlayoutReady;

    this.buffer = [];
    this.nextExpectedSeq = -1;
    this.playoutTimerId = null;
    this.started = false;
    this.playoutStartTime = 0;
    this.firstPacketTimestamp = 0;

    // Statistics
    this.stats = {
      received: 0,
      played: 0,
      dropped: 0,
      reordered: 0,
    };
  }

  /**
   * Start the playout timer.
   */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.playoutTimerId = setInterval((): void => this._checkPlayout(), 5);
  }

  /**
   * Stop the jitter buffer.
   */
  stop(): void {
    this.started = false;
    if (this.playoutTimerId !== null) {
      clearInterval(this.playoutTimerId);
      this.playoutTimerId = null;
    }
  }

  /**
   * Insert a packet into the jitter buffer.
   */
  insert(packet: BufferedPacket): void {
    this.stats.received++;

    // Initialize on first packet
    if (this.nextExpectedSeq === -1) {
      this.nextExpectedSeq = packet.sequenceNumber;
      this.playoutStartTime = packet.receiveTime + this.delayMs;
      this.firstPacketTimestamp = packet.timestamp;
    }

    // Drop packets that are too old (already past playout time)
    if (this._isLate(packet)) {
      this.stats.dropped++;
      return;
    }

    // Drop if buffer is full
    if (this.buffer.length >= this.maxSize) {
      this.stats.dropped++;
      return;
    }

    // Insert in sequence-number order
    const insertIdx = this._findInsertIndex(packet.sequenceNumber);
    if (insertIdx === -1) {
      // Duplicate
      return;
    }

    if (insertIdx < this.buffer.length) {
      this.stats.reordered++;
    }

    this.buffer.splice(insertIdx, 0, packet);
  }

  /**
   * Get buffer statistics.
   */
  getStats(): JitterBufferStats {
    return {...this.stats, bufferSize: this.buffer.length};
  }

  _isLate(packet: BufferedPacket): boolean {
    if (this.nextExpectedSeq === -1) {
      return false;
    }
    // Use sequence number comparison with wraparound
    const diff = this._seqDiff(packet.sequenceNumber, this.nextExpectedSeq);
    return diff < -5;  // Allow some late packets
  }

  _findInsertIndex(seq: number): number {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const diff = this._seqDiff(seq, this.buffer[i].sequenceNumber);
      if (diff === 0) {
        return -1;  // Duplicate
      }
      if (diff > 0) {
        return i + 1;  // Insert after this one
      }
    }
    return 0;  // Insert at beginning
  }

  _seqDiff(a: number, b: number): number {
    // 16-bit wraparound-aware difference
    let diff = (a - b) & 0xFFFF;
    if (diff > 0x7FFF) {
      diff -= 0x10000;
    }
    return diff;
  }

  _checkPlayout(): void {
    const now = performance.now();

    while (this.buffer.length > 0) {
      const packet = this.buffer[0];

      // Calculate when this packet should be played out
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
}
