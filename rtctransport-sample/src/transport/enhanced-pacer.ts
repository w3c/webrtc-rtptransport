// Enhanced Token-Bucket Pacer (Phase 2)
// Paces packets according to target bitrate with burst allowance and probing.

export const PacketPriority = {
  AUDIO: 0,
  RETRANSMISSION: 1,
  VIDEO: 2,
  PADDING: 3,
} as const;

export type PacketPriorityType =
    typeof PacketPriority[keyof typeof PacketPriority];

export interface QueuedPacket {
  data: Uint8Array;
  id: number;
  priority: number;
  enqueueTimeMs: number;
}

export interface EnhancedPacerOptions {
  targetBitrateBps: number;
  burstFactor?: number;
  intervalMs?: number;
  onSend: (packet: QueuedPacket) => void;
  maxQueueSizeBytes?: number;
}

export interface EnhancedPacerStats {
  bytesSent: number;
  packetsSent: number;
  packetsDropped: number;
}

export interface EnhancedPacerQueueStats extends EnhancedPacerStats {
  queueBytes: number;
  queuePackets: number;
  targetBitrateBps: number;
}

/**
 * Token-bucket pacer with priority queue and bandwidth probing.
 */
export class EnhancedPacer {
  targetBitrateBps: number;
  burstFactor: number;
  intervalMs: number;
  onSend: (packet: QueuedPacket) => void;
  maxQueueSizeBytes: number;
  tokens: number;
  maxTokens: number;
  lastDrainMs: number;
  queues: QueuedPacket[][];
  totalQueueBytes: number;
  timerId: ReturnType<typeof setInterval>|null;
  running: boolean;
  packetIdCounter: number;
  stats: EnhancedPacerStats;

  constructor({
    targetBitrateBps,
    burstFactor = 1.5,
    intervalMs = 5,
    onSend,
    maxQueueSizeBytes = 60000,
  }: EnhancedPacerOptions) {
    this.targetBitrateBps = targetBitrateBps;
    this.burstFactor = burstFactor;
    this.intervalMs = intervalMs;
    this.onSend = onSend;
    this.maxQueueSizeBytes = maxQueueSizeBytes;

    this.tokens = 0;
    this.maxTokens = 0;
    this.lastDrainMs = 0;

    this.queues = [[], [], [], []];
    this.totalQueueBytes = 0;

    this.timerId = null;
    this.running = false;
    this.packetIdCounter = 0;

    this.stats = {
      bytesSent: 0,
      packetsSent: 0,
      packetsDropped: 0,
    };

    this._updateTokenRate();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastDrainMs = performance.now();
    this.timerId = setInterval(() => this._drain(), this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  setTargetBitrate(bitrateBps: number): void {
    this.targetBitrateBps = bitrateBps;
    this._updateTokenRate();
  }

  enqueue(
      data: Uint8Array,
      priority: number = PacketPriority.VIDEO): number {
    if (this.totalQueueBytes + data.length > this.maxQueueSizeBytes) {
      if (!this._makeRoom(data.length)) {
        this.stats.packetsDropped++;
        return -1;
      }
    }

    const id = this.packetIdCounter++;
    this.queues[priority].push({
      data,
      id,
      priority,
      enqueueTimeMs: performance.now(),
    });
    this.totalQueueBytes += data.length;
    return id;
  }

  enqueuePadding(size: number): void {
    const padding = new Uint8Array(size);
    padding[0] = 0xFF;
    this.enqueue(padding, PacketPriority.PADDING);
  }

  getStats(): EnhancedPacerQueueStats {
    return {
      ...this.stats,
      queueBytes: this.totalQueueBytes,
      queuePackets: this.queues.reduce((sum, queue) => sum + queue.length, 0),
      targetBitrateBps: this.targetBitrateBps,
    };
  }

  private _updateTokenRate(): void {
    const bytesPerInterval =
        (this.targetBitrateBps / 8) * (this.intervalMs / 1000);
    this.maxTokens = Math.ceil(bytesPerInterval * this.burstFactor);
  }

  private _drain(): void {
    const now = performance.now();
    const dtMs = now - this.lastDrainMs;
    this.lastDrainMs = now;

    const newTokens = (this.targetBitrateBps / 8) * (dtMs / 1000);
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);

    for (let priority = 0; priority < this.queues.length; priority++) {
      const queue = this.queues[priority];

      while (queue.length > 0) {
        const nextPacket = queue[0];
        if (!nextPacket || this.tokens < nextPacket.data.length) {
          break;
        }

        const packet = queue.shift();
        if (!packet) {
          break;
        }

        this.tokens -= packet.data.length;
        this.totalQueueBytes -= packet.data.length;
        this.stats.bytesSent += packet.data.length;
        this.stats.packetsSent++;
        this.onSend(packet);
      }
    }
  }

  private _makeRoom(neededBytes: number): boolean {
    for (let priority = this.queues.length - 1;
         priority >= PacketPriority.VIDEO; priority--) {
      while (this.queues[priority].length > 0 &&
             this.totalQueueBytes + neededBytes > this.maxQueueSizeBytes) {
        const dropped = this.queues[priority].pop();
        if (!dropped) {
          break;
        }
        this.totalQueueBytes -= dropped.data.length;
        this.stats.packetsDropped++;
      }
    }
    return this.totalQueueBytes + neededBytes <= this.maxQueueSizeBytes;
  }
}
