// ================================================================
//  NetworkLinkSimulator — leaky-bucket model
// ================================================================
class NetworkLinkSimulator {
    /**
     * @param {string} name
     * @param {Object} config
     * @param {number} config.bitrateBps        Link bitrate in bits/sec
     * @param {number} config.maxQueueBytes      Max bytes in the simulator
     * @param {number} config.fixedLatencyMs     Fixed propagation delay (ms)
     * @param {number} config.randomLossRate     Independent loss probability [0,1]
     * @param {number} config.burstLossRate      Gilbert G→B transition prob [0,1]
     */
    constructor(name, config = {}) {
        this.name = name;
        this.bitrateBps = config.bitrateBps ?? 1_000_000;
        this.maxQueueBytes = config.maxQueueBytes ?? 102_400;
        this.fixedLatencyMs = config.fixedLatencyMs ?? 50;
        this.randomLossRate = config.randomLossRate ?? 0;
        this.burstLossRate = config.burstLossRate ?? 0;
        // Average burst length ~3.3 packets (1/0.3)
        this.burstRecoveryRate = 0.3;
        this._reset();
    }

    _reset() {
        this.queue = [];          // {packet, sizeBytes, availableTimeMs}
        this.queuedBytes = 0;
        this.nextTransmitEndMs = 0;
        this.inBurst = false;

        this.queueLog = [{ timeMs: 0, queueBytes: 0 }];
        this.lossLog = [];       // {timeMs, sizeBytes, reason}
        this.stats = { sent: 0, delivered: 0, dropped: 0 };
    }

    /** Returns true if accepted; false if dropped. */
    enqueue(packet, sizeBytes, nowMs) {
        this.stats.sent++;

        // Drop if network queue is full
        if (this.queuedBytes + sizeBytes > this.maxQueueBytes) {
            this.stats.dropped++;
            this.lossLog.push({ timeMs: nowMs, sizeBytes, reason: 'overflow' });
            return false;
        }

        // Drop in bursts
        if (this.inBurst) {
            if (Math.random() < this.burstRecoveryRate) {
                this.inBurst = false;
            }
        } else {
            if (Math.random() < this.burstLossRate) {
                this.inBurst = true;
            }
        }
        if (this.inBurst) {
            this.stats.dropped++;
            this.lossLog.push({ timeMs: nowMs, sizeBytes, reason: 'burst' });
            return false;
        }

        // Also drop randomly
        if (Math.random() < this.randomLossRate) {
            this.stats.dropped++;
            this.lossLog.push({ timeMs: nowMs, sizeBytes, reason: 'random' });
            return false;
        }

        // Schedule packet send
        const txStart = Math.max(nowMs, this.nextTransmitEndMs);
        const txDuration = (sizeBytes * 8 / this.bitrateBps) * 1000; // ms
        const txEnd = txStart + txDuration;
        this.nextTransmitEndMs = txEnd;

        // Add some fixed latency
        const available = txEnd + this.fixedLatencyMs;
        this.queue.push({ packet, sizeBytes, availableTimeMs: available });
        this.queuedBytes += sizeBytes;
        this.queueLog.push({ timeMs: nowMs, queueBytes: this.queuedBytes });
        return true;
    }

    /** Returns the time the next packet should be dequeue, or Infinity if none. */
    nextDequeueTimeMs() {
        return this.queue.length > 0 ? this.queue[0].availableTimeMs : Infinity;
    }

    /** Dequeue the next packet, if available */
    dequeue(nowMs) {
        if (this.queue.length === 0) {
            return null;
        }
        if (nowMs < this.queue[0].availableTimeMs) {
            return null;
        }
        const entry = this.queue.shift();
        this.queuedBytes -= entry.sizeBytes;
        this.stats.delivered++;
        this.queueLog.push({ timeMs: nowMs, queueBytes: this.queuedBytes });
        return { packet: entry.packet, sizeBytes: entry.sizeBytes };
    }
}
