// Simple Fixed-Rate Pacer (Phase 1)
// Drains packet queue at regular intervals.
// No bandwidth estimation, no priority queue.

export interface PacedPacket {
  data: Uint8Array;
  id: number;
}

export interface FixedPacerOptions {
  intervalMs?: number;
  maxBurstPackets?: number;
  onSend: (packet: PacedPacket) => void;
}

/**
 * Simple interval-based pacer.
 * Sends packets from the queue at a fixed interval.
 */
export class FixedPacer {
  intervalMs: number;
  maxBurstPackets: number;
  onSend: (packet: PacedPacket) => void;
  queue: PacedPacket[];
  timerId: ReturnType<typeof setInterval>|null;
  packetIdCounter: number;
  running: boolean;

  constructor({
    intervalMs = 20,
    maxBurstPackets = 3,
    onSend,
  }: FixedPacerOptions) {
    this.intervalMs = intervalMs;
    this.maxBurstPackets = maxBurstPackets;
    this.onSend = onSend;

    this.queue = [];
    this.timerId = null;
    this.packetIdCounter = 0;
    this.running = false;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.timerId = setInterval(() => this._drain(), this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  enqueue(data: Uint8Array): number {
    const id = this.packetIdCounter++;
    this.queue.push({ data, id });
    return id;
  }

  get queueSize(): number {
    return this.queue.length;
  }

  private _drain(): void {
    const count = Math.min(this.maxBurstPackets, this.queue.length);
    for (let i = 0; i < count; i++) {
      const packet = this.queue.shift();
      if (!packet) {
        return;
      }
      this.onSend(packet);
    }
  }
}
