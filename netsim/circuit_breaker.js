// ================================================================
//  CircuitBreaker — loss-based rate limiter (CUBIC-like, lenient)
//
//  It maintains its own sequence numbers and feedback loop. 
//  When too many bytes are in flight it drops packets before
//  they reach the network.
//
//  A single instance spans one direction (e.g. A→B).  Sender-side
//  methods are called at the sending endpoint; receiver-side
//  methods are called at the receiving endpoint.
// ================================================================
class CircuitBreaker {
    /**
     * @param {Object} [config]
     * @param {number} [config.initialWindowBytes=2000000]  Starting cwnd
     * @param {number} [config.maxWindowBytes=20000000]     Ceiling
     * @param {number} [config.minWindowBytes=5000]         Floor
     * @param {number} [config.beta=0.85]        Multiplicative decrease (CUBIC=0.7)
     * @param {number} [config.cubicC=40000]     CUBIC C (bytes/s³, fast recovery)
     * @param {number} [config.lossThreshold=0.10] Loss fraction that triggers response
     * @param {number} [config.feedbackIntervalMs=50]
     */
    constructor(config = {}) {
        // -- CUBIC parameters (lenient) --
        this.beta = config.beta ?? 0.85;
        this.cubicC = config.cubicC ?? 40_000;
        this.lossThreshold = config.lossThreshold ?? 0.10;
        this.minPktsForDecision = 5;

        // -- Congestion window --
        this.cwnd = config.initialWindowBytes ?? 2_000_000;  // 2 MB
        this.maxCwnd = config.maxWindowBytes ?? 20_000_000; // 20 MB
        this.minCwnd = config.minWindowBytes ?? 5_000;      // 5 KB

        // -- CUBIC state --
        this.W_max = this.cwnd;
        this.lastReductionTimeMs = -Infinity;
        this.K = 0;   // seconds to reach W_max

        // -- Sender-side tracking --
        this.bytesInFlight = 0;
        this.sentPackets = new Map();   // cbSeq → {sendTimeMs, sizeBytes}
        this.nextCbSeq = 0;
        this.rttMs = 100;         // smoothed RTT estimate

        // -- Receiver-side tracking --
        this.recvMap = new Map(); // cbSeq → receiveTimeMs
        this.highestRecvCbSeq = -1;
        this.lastReportedCbSeq = -1;
        this.lastFeedbackSentMs = -Infinity;
        this.feedbackIntervalMs = config.feedbackIntervalMs ?? 50;

        // -- Logging --
        this.cwndLog = [{ timeMs: 0, cwndBytes: this.cwnd, bytesInFlight: 0 }];
        this.dropLog = [];                 // {timeMs, sizeBytes}
        this.stats = { sent: 0, dropped: 0, passed: 0 };
    }

    //  Returns { allowed:true, packet, sizeBytes } or { allowed:false }.
    send(packet, sizeBytes, nowMs) {
        this.stats.sent++;

        if (this.bytesInFlight + sizeBytes > this.cwnd) {
            this.stats.dropped++;
            this.dropLog.push({ timeMs: nowMs, sizeBytes });
            this.cwndLog.push({
                timeMs: nowMs,
                cwndBytes: this.cwnd,
                bytesInFlight: this.bytesInFlight,
            });
            return { allowed: false };
        }

        const cbSeq = this.nextCbSeq++;
        this.bytesInFlight += sizeBytes;
        this.sentPackets.set(cbSeq, { sendTimeMs: nowMs, sizeBytes });

        // Wrap the original packet — add cbSeq while preserving all fields
        const wrappedPacket = Object.assign({}, packet, { cbSeq });

        this.stats.passed++;
        return { allowed: true, packet: wrappedPacket, sizeBytes };
    }

    //  Returns the earliest time at which sendFeedback() should be called.
    nextFeedbackTimeMs() {
        if (this.highestRecvCbSeq > this.lastReportedCbSeq) {
            return this.lastFeedbackSentMs + this.feedbackIntervalMs;
        }
        return Infinity;
    }

    //  Returns a packet { type:'cb-feedback', cbFeedbacks:[…] } to
    //  enqueue on the reverse network link.
    sendFeedback(nowMs) {
        const cbFeedbacks = [];
        for (let seq = this.lastReportedCbSeq + 1; seq <= this.highestRecvCbSeq; seq++) {
            if (this.recvMap.has(seq)) {
                cbFeedbacks.push({ cbSeq: seq, receiveTimeMs: this.recvMap.get(seq) });
                this.recvMap.delete(seq);
            } else {
                cbFeedbacks.push({ cbSeq: seq, receiveTimeMs: -1 });
            }
        }
        this.lastReportedCbSeq = this.highestRecvCbSeq;
        this.lastFeedbackSentMs = nowMs;
        return { type: 'cb-feedback', cbFeedbacks };
    }

    //  Processes a cb-feedback packet received from the far end.
    //  Updates bytesInFlight, RTT, and cwnd (CUBIC).
    handleFeedback(feedbackPacket, nowMs) {
        const feedbacks = feedbackPacket.cbFeedbacks;
        let acked = 0, lost = 0;
        let rttSum = 0, rttCount = 0;

        for (const fb of feedbacks) {
            const sent = this.sentPackets.get(fb.cbSeq);
            if (!sent) continue;

            this.bytesInFlight -= sent.sizeBytes;
            this.sentPackets.delete(fb.cbSeq);

            if (fb.receiveTimeMs >= 0) {
                acked++;
                const rtt = nowMs - sent.sendTimeMs;
                if (rtt > 0) { rttSum += rtt; rttCount++; }
            } else {
                lost++;
            }
        }
        if (this.bytesInFlight < 0) this.bytesInFlight = 0;

        // Smooth RTT
        if (rttCount > 0) {
            this.rttMs = this.rttMs * 0.875 + (rttSum / rttCount) * 0.125;
        }

        // Decide whether to reduce or grow
        const total = acked + lost;
        if (total >= this.minPktsForDecision) {
            const lossRate = lost / total;
            if (lossRate > this.lossThreshold) {
                this._onLossDetected(nowMs);
            } else if (acked > 0) {
                this._cubicGrow(nowMs);
            }
        } else if (acked > 0) {
            this._cubicGrow(nowMs);
        }

        // Evict very old unacked entries to prevent unbounded memory
        this._cleanupStale(nowMs);

        this.cwndLog.push({
            timeMs: nowMs,
            cwndBytes: this.cwnd,
            bytesInFlight: this.bytesInFlight,
        });
    }

    onDataReceived(cbSeq, nowMs) {
        this.recvMap.set(cbSeq, nowMs);
        this.highestRecvCbSeq = Math.max(this.highestRecvCbSeq, cbSeq);
    }

    _onLossDetected(nowMs) {
        // Don't reduce more than once per smoothed RTT
        if (nowMs - this.lastReductionTimeMs < this.rttMs) return;

        this.W_max = this.cwnd;
        this.cwnd = Math.max(this.cwnd * this.beta, this.minCwnd);
        this.lastReductionTimeMs = nowMs;

        // K = time (seconds) until CUBIC curve reaches W_max again
        this.K = Math.cbrt(this.W_max * (1 - this.beta) / this.cubicC);
    }

    _cubicGrow(nowMs) {
        // Before any loss has ever occurred, the window is already generous
        if (this.lastReductionTimeMs === -Infinity) return;

        const t = (nowMs - this.lastReductionTimeMs) / 1000; // seconds
        const W_cubic = this.cubicC * Math.pow(t - this.K, 3) + this.W_max;

        if (W_cubic > this.cwnd) {
            this.cwnd = Math.min(W_cubic, this.maxCwnd);
        }
    }

    _cleanupStale(nowMs) {
        const TIMEOUT_MS = 30_000;
        for (const [seq, info] of this.sentPackets) {
            if (nowMs - info.sendTimeMs > TIMEOUT_MS) {
                this.bytesInFlight -= info.sizeBytes;
                this.sentPackets.delete(seq);
            }
        }
        if (this.bytesInFlight < 0) this.bytesInFlight = 0;
    }
}
