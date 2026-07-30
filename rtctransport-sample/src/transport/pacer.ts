// Packet Pacer (based on WebRTC PacingController)
//
// Token-bucket pacer with burst control, priority queues, and queue-driven
// bitrate opening. Reference: webrtc/modules/pacing/pacing_controller.cc
//
// Key concepts:
// - Media debt accumulates when packets are sent, drains at pacing_rate
// - Packets are released when debt has drained sufficiently
// - Burst window limits how many packets can be sent back-to-back
// - Priority: audio > retransmission > video > FEC > padding
// - Large queues temporarily increase effective send rate

export enum PacketPriority {
  Audio = 0,
  Retransmission = 1,
  Video = 2,
  Fec = 3,
  Padding = 4,
}

export interface PacedPacket {
  data: Uint8Array;
  priority: PacketPriority;
  enqueueTimeMs: number;
  size: number;
}

export interface PacerOptions {
  /** Target pacing bitrate in bps. */
  pacingRateBps?: number;
  /** Maximum burst size in bytes (default: 63KB per WebRTC). */
  maxBurstBytes?: number;
  /** Maximum debt in time (ms) before packets are delayed (default: 500ms). */
  maxDebtMs?: number;
  /** Burst interval — packets within this window are sent immediately (ms). */
  burstIntervalMs?: number;
  /** Queue time limit — if avg queue time exceeds this, rate is boosted (ms). */
  queueTimeLimitMs?: number;
  /** Callback to actually send a packet on the wire. */
  onSend: (packet: PacedPacket) => void;
  /** Minimum process interval (ms). Default: 5ms (JS timer resolution). */
  processIntervalMs?: number;
}

export interface PacerStats {
  packetsSent: number;
  bytesSent: number;
  packetsQueued: number;
  bytesQueued: number;
  mediaDebtMs: number;
  paddingDebtMs: number;
  effectiveRateBps: number;
  queueDelayMs: number;
}

// Constants matching WebRTC
const DEFAULT_PACING_RATE_BPS = 500_000;
const MAX_BURST_BYTES = 63_000;
const MAX_DEBT_MS = 500;
const DEFAULT_BURST_INTERVAL_MS = 5;
const QUEUE_TIME_LIMIT_MS = 2000;
const CONGESTED_INTERVAL_MS = 500;
const MIN_PROCESS_INTERVAL_MS = 5;

/**
 * Token-bucket pacer with priority queues and queue-driven rate opening.
 *
 * Based on WebRTC's PacingController:
 * - Media debt grows when packets are sent (debt += packet_size / rate)
 * - Debt drains over time (debt -= elapsed_time)
 * - Packets are released when debt < burst allowance
 * - Large queues boost the effective rate to drain backlog
 */
export class Pacer {
  private _pacingRateBps: number;
  private _maxBurstBytes: number;
  private _maxDebtMs: number;
  private _burstIntervalMs: number;
  private _queueTimeLimitMs: number;
  private _processIntervalMs: number;
  private _onSend: (packet: PacedPacket) => void;

  // Debt tracking (in milliseconds worth of data at current rate)
  private _mediaDebtMs: number;
  private _paddingDebtMs: number;
  private _lastProcessTimeMs: number;

  // Priority queues (lower index = higher priority)
  private _queues: PacedPacket[][];
  private _totalQueuedBytes: number;
  private _totalQueuedPackets: number;

  // Effective rate (may be boosted for queue draining)
  private _adjustedRateBps: number;

  // Timer
  private _timerId: number | null;
  private _running: boolean;

  // Stats
  private _stats: { packetsSent: number; bytesSent: number };

  constructor(options: PacerOptions) {
    this._pacingRateBps = options.pacingRateBps ?? DEFAULT_PACING_RATE_BPS;
    this._maxBurstBytes = options.maxBurstBytes ?? MAX_BURST_BYTES;
    this._maxDebtMs = options.maxDebtMs ?? MAX_DEBT_MS;
    this._burstIntervalMs = options.burstIntervalMs ?? DEFAULT_BURST_INTERVAL_MS;
    this._queueTimeLimitMs = options.queueTimeLimitMs ?? QUEUE_TIME_LIMIT_MS;
    this._processIntervalMs = options.processIntervalMs ?? MIN_PROCESS_INTERVAL_MS;
    this._onSend = options.onSend;

    this._mediaDebtMs = 0;
    this._paddingDebtMs = 0;
    this._lastProcessTimeMs = performance.now();

    // One queue per priority level
    this._queues = Array.from({length: 5}, () => []);
    this._totalQueuedBytes = 0;
    this._totalQueuedPackets = 0;

    this._adjustedRateBps = this._pacingRateBps;
    this._timerId = null;
    this._running = false;
    this._stats = {packetsSent: 0, bytesSent: 0};
  }

  /**
   * Start the pacer timer loop.
   */
  start(): void {
    if (this._running) return;
    this._running = true;
    this._lastProcessTimeMs = performance.now();
    this._timerId = window.setInterval(
        () => this._process(), this._processIntervalMs);
  }

  /**
   * Stop the pacer.
   */
  stop(): void {
    this._running = false;
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
  }

  /**
   * Update the target pacing bitrate.
   */
  setPacingRate(bps: number): void {
    this._pacingRateBps = Math.max(1000, bps);
    // Don't lower adjusted rate below new pacing rate immediately
    this._adjustedRateBps = Math.max(this._adjustedRateBps, this._pacingRateBps);
  }

  /**
   * Enqueue a packet for paced sending.
   * Audio packets bypass the pacer if debt is low (unpaced fast path).
   */
  enqueuePacket(data: Uint8Array, priority: PacketPriority): void {
    const packet: PacedPacket = {
      data,
      priority,
      enqueueTimeMs: performance.now(),
      size: data.length,
    };

    // Fast path: audio with low debt → send immediately (WebRTC unpaced audio)
    if (priority === PacketPriority.Audio && this._mediaDebtMs < 1) {
      this._sendPacket(packet);
      return;
    }

    this._queues[priority].push(packet);
    this._totalQueuedBytes += packet.size;
    this._totalQueuedPackets++;
  }

  /**
   * Get current pacer statistics.
   */
  getStats(): PacerStats {
    return {
      packetsSent: this._stats.packetsSent,
      bytesSent: this._stats.bytesSent,
      packetsQueued: this._totalQueuedPackets,
      bytesQueued: this._totalQueuedBytes,
      mediaDebtMs: Math.round(this._mediaDebtMs * 10) / 10,
      paddingDebtMs: Math.round(this._paddingDebtMs * 10) / 10,
      effectiveRateBps: this._adjustedRateBps,
      queueDelayMs: this._getAverageQueueDelay(),
    };
  }

  /**
   * Main processing loop — drain debt, send packets.
   */
  private _process(): void {
    const now = performance.now();
    const elapsedMs = now - this._lastProcessTimeMs;
    this._lastProcessTimeMs = now;

    if (elapsedMs <= 0) return;

    // Drain debt over time
    this._mediaDebtMs = Math.max(0, this._mediaDebtMs - elapsedMs);
    this._paddingDebtMs = Math.max(0, this._paddingDebtMs - elapsedMs);

    // Boost rate if queue is too large (WebRTC queue-driven rate opening)
    this._maybeBoostRate(now);

    // Send packets while within budget
    let burstBytesSent = 0;
    const burstBudgetMs = this._burstIntervalMs;

    while (this._totalQueuedPackets > 0) {
      // Debt check: can we send?
      if (this._mediaDebtMs > burstBudgetMs) break;
      // Burst limit
      if (burstBytesSent >= this._maxBurstBytes) break;

      const packet = this._popHighestPriority();
      if (!packet) break;

      this._sendPacket(packet);
      burstBytesSent += packet.size;
    }
  }

  /**
   * Boost the effective send rate when queue delay exceeds limits.
   * Based on WebRTC's MaybeUpdateMediaRateDueToLongQueue().
   */
  private _maybeBoostRate(now: number): void {
    if (this._totalQueuedBytes === 0) {
      this._adjustedRateBps = this._pacingRateBps;
      return;
    }

    const avgQueueDelayMs = this._getAverageQueueDelay();
    const timeLeftMs = Math.max(1, this._queueTimeLimitMs - avgQueueDelayMs);

    // Rate needed to drain the queue within the time limit
    const minRateNeeded = (this._totalQueuedBytes * 8 * 1000) / timeLeftMs;

    if (minRateNeeded > this._pacingRateBps) {
      this._adjustedRateBps = Math.min(
          minRateNeeded, this._pacingRateBps * 2.5);
    } else {
      this._adjustedRateBps = this._pacingRateBps;
    }
  }

  /**
   * Pop the highest-priority packet from the queues.
   */
  private _popHighestPriority(): PacedPacket | null {
    for (const queue of this._queues) {
      if (queue.length > 0) {
        const packet = queue.shift()!;
        this._totalQueuedBytes -= packet.size;
        this._totalQueuedPackets--;
        return packet;
      }
    }
    return null;
  }

  /**
   * Send a packet and update debt.
   */
  private _sendPacket(packet: PacedPacket): void {
    // Update debt: time in ms to transmit this packet at current rate
    const transmitTimeMs = (packet.size * 8 * 1000) / this._adjustedRateBps;
    this._mediaDebtMs += transmitTimeMs;

    // Cap debt
    if (this._mediaDebtMs > this._maxDebtMs) {
      this._mediaDebtMs = this._maxDebtMs;
    }

    this._stats.packetsSent++;
    this._stats.bytesSent += packet.size;

    this._onSend(packet);
  }

  /**
   * Compute average queue delay across all non-empty queues.
   */
  private _getAverageQueueDelay(): number {
    if (this._totalQueuedPackets === 0) return 0;

    const now = performance.now();
    let totalDelay = 0;
    let count = 0;

    for (const queue of this._queues) {
      if (queue.length > 0) {
        // Sample from front (oldest) packet
        totalDelay += now - queue[0].enqueueTimeMs;
        count++;
      }
    }

    return count > 0 ? totalDelay / count : 0;
  }
}
