/**
 * GoogCC (Google Congestion Control)
 *
 * This implements the core congestion control logic including:
 *   - Delay-based bandwidth estimation (trendline filter + AIMD rate control)
 *   - Loss-based bandwidth estimation
 *   - Acknowledged bitrate estimation (Bayesian filter)
 *   - Probe controller (initial/periodic/ALR probing)
 *   - ALR (Application Limited Region) detection
 *
 * Usage:
 *   const cc = new GoogCcController({ startBitrateBps: 300000 });
 *
 *   // When sending a packet:
 *   cc.onSentPacket({ seqNum, sendTimeMs, sizeBytes });
 *
 *   // When receiving transport-cc feedback from the receiver:
 *   const update = cc.onTransportPacketsFeedback({
 *     feedbackTimeMs,
 *     packetFeedbacks: [
 *       { seqNum, sendTimeMs, receiveTimeMs, sizeBytes },
 *       ...
 *     ]
 *   });
 *   // update.targetBitrateBps is the new target bitrate to use
 *
 *   // Periodically (every ~25ms):
 *   const update = cc.onProcessInterval(nowMs);
 */

const BandwidthUsage = Object.freeze({
    NORMAL: 'normal',
    OVERUSING: 'overusing',
    UNDERUSING: 'underusing',
});

const RateControlState = Object.freeze({
    HOLD: 'hold',
    INCREASE: 'increase',
    DECREASE: 'decrease',
});

const MIN_BITRATE_BPS = 10_000;
const DEFAULT_START_BITRATE_BPS = 300_000;
const DEFAULT_MAX_BITRATE_BPS = 30_000_000;

// ============================================================================
// InterArrivalDelta — Groups packets by send-time bursts and computes deltas
// ============================================================================
class InterArrivalDelta {
    /**
     * @param {number} sendTimeGroupLengthMs - Max gap within a send-time group (default 5ms)
     */
    constructor(sendTimeGroupLengthMs = 5) {
        this.sendTimeGroupLengthMs = sendTimeGroupLengthMs;
        this.currentGroup = this._newGroup();
        this.prevGroup = this._newGroup();
        this.numConsecutiveReordered = 0;
    }

    _newGroup() {
        return {
            size: 0,
            firstSendTimeMs: -Infinity,
            sendTimeMs: -Infinity,
            firstArrivalMs: -Infinity,
            completeTimeMs: -Infinity,
            lastSystemTimeMs: -Infinity,
            isFirst: true,
        };
    }

    /**
     * Compute inter-group deltas. Returns null if not enough data, or
     * { sendDeltaMs, recvDeltaMs, sizeDelta }.
     */
    computeDeltas(sendTimeMs, arrivalTimeMs, systemTimeMs, packetSize) {
        let calculated = false;
        let sendDeltaMs = 0;
        let recvDeltaMs = 0;
        let sizeDelta = 0;

        if (this.currentGroup.isFirst) {
            this.currentGroup.sendTimeMs = sendTimeMs;
            this.currentGroup.firstSendTimeMs = sendTimeMs;
            this.currentGroup.firstArrivalMs = arrivalTimeMs;
            this.currentGroup.isFirst = false;
        } else if (this.currentGroup.firstSendTimeMs > sendTimeMs) {
            // Reordered packet
            return null;
        } else if (this._isNewGroup(arrivalTimeMs, sendTimeMs)) {
            // New group — the previous sample is ready
            if (this.prevGroup.completeTimeMs > -Infinity) {
                sendDeltaMs = this.currentGroup.sendTimeMs - this.prevGroup.sendTimeMs;
                recvDeltaMs = this.currentGroup.completeTimeMs - this.prevGroup.completeTimeMs;

                const systemDelta = this.currentGroup.lastSystemTimeMs - this.prevGroup.lastSystemTimeMs;
                if (recvDeltaMs - systemDelta >= 3000) {
                    // Clock offset jump
                    this._reset();
                    return null;
                }
                if (recvDeltaMs < 0) {
                    this.numConsecutiveReordered++;
                    if (this.numConsecutiveReordered >= 3) {
                        this._reset();
                    }
                    return null;
                }
                this.numConsecutiveReordered = 0;
                sizeDelta = this.currentGroup.size - this.prevGroup.size;
                calculated = true;
            }
            this.prevGroup = { ...this.currentGroup };
            this.currentGroup.firstSendTimeMs = sendTimeMs;
            this.currentGroup.sendTimeMs = sendTimeMs;
            this.currentGroup.firstArrivalMs = arrivalTimeMs;
            this.currentGroup.size = 0;
        } else {
            this.currentGroup.sendTimeMs = Math.max(this.currentGroup.sendTimeMs, sendTimeMs);
        }

        this.currentGroup.size += packetSize;
        this.currentGroup.completeTimeMs = arrivalTimeMs;
        this.currentGroup.lastSystemTimeMs = systemTimeMs;

        if (calculated) {
            return { sendDeltaMs, recvDeltaMs, sizeDelta };
        }
        return null;
    }

    _isNewGroup(arrivalTimeMs, sendTimeMs) {
        if (this.currentGroup.isFirst) return false;
        if (this._belongsToBurst(arrivalTimeMs, sendTimeMs)) return false;
        return sendTimeMs - this.currentGroup.firstSendTimeMs > this.sendTimeGroupLengthMs;
    }

    _belongsToBurst(arrivalTimeMs, sendTimeMs) {
        if (this.currentGroup.completeTimeMs <= -Infinity) return false;
        const arrivalDelta = arrivalTimeMs - this.currentGroup.completeTimeMs;
        const sendDelta = sendTimeMs - this.currentGroup.sendTimeMs;
        if (sendDelta === 0) return true;
        const propagationDelta = arrivalDelta - sendDelta;
        if (propagationDelta < 0 && arrivalDelta <= 5 &&
            arrivalTimeMs - this.currentGroup.firstArrivalMs < 100) {
            return true;
        }
        return false;
    }

    _reset() {
        this.numConsecutiveReordered = 0;
        this.currentGroup = this._newGroup();
        this.prevGroup = this._newGroup();
    }
}

// ============================================================================
// TrendlineEstimator — Detects delay trends via linear regression + threshold
// ============================================================================
class TrendlineEstimator {
    constructor(windowSize = 20) {
        this.windowSize = windowSize;
        this.smoothingCoef = 0.9;
        this.thresholdGain = 4.0;

        this.numOfDeltas = 0;
        this.firstArrivalTimeMs = -1;
        this.accumulatedDelay = 0;
        this.smoothedDelay = 0;
        this.delayHist = []; // { arrivalTimeMs, smoothedDelay, rawDelay }

        // Adaptive threshold parameters
        this.kUp = 0.0087;
        this.kDown = 0.039;
        this.overusingTimeThreshold = 10;
        this.threshold = 12.5;
        this.prevModifiedTrend = NaN;
        this.lastUpdateMs = -1;
        this.prevTrend = 0;
        this.timeOverUsing = -1;
        this.overuseCounter = 0;
        this.hypothesis = BandwidthUsage.NORMAL;
    }

    get state() {
        return this.hypothesis;
    }

    /**
     * Feed a new inter-group delta sample.
     */
    update(recvDeltaMs, sendDeltaMs, sendTimeMs, arrivalTimeMs, packetSize, calculatedDeltas) {
        if (calculatedDeltas) {
            this._updateTrendline(recvDeltaMs, sendDeltaMs, arrivalTimeMs);
        }
    }

    _updateTrendline(recvDeltaMs, sendDeltaMs, arrivalTimeMs) {
        const deltaMs = recvDeltaMs - sendDeltaMs;
        this.numOfDeltas = Math.min(this.numOfDeltas + 1, 1000);

        if (this.firstArrivalTimeMs === -1) {
            this.firstArrivalTimeMs = arrivalTimeMs;
        }

        // Exponential backoff filter
        this.accumulatedDelay += deltaMs;
        this.smoothedDelay = this.smoothingCoef * this.smoothedDelay +
            (1 - this.smoothingCoef) * this.accumulatedDelay;

        this.delayHist.push({
            arrivalTimeMs: arrivalTimeMs - this.firstArrivalTimeMs,
            smoothedDelay: this.smoothedDelay,
            rawDelay: this.accumulatedDelay,
        });
        if (this.delayHist.length > this.windowSize) {
            this.delayHist.shift();
        }

        let trend = this.prevTrend;
        if (this.delayHist.length === this.windowSize) {
            const slope = this._linearFitSlope();
            trend = slope != null ? slope : trend;
        }

        this._detect(trend, sendDeltaMs, arrivalTimeMs);
    }

    /**
     * Ordinary least-squares slope of smoothedDelay vs. arrivalTime.
     */
    _linearFitSlope() {
        const n = this.delayHist.length;
        if (n < 2) return null;

        let sumX = 0, sumY = 0;
        for (const p of this.delayHist) {
            sumX += p.arrivalTimeMs;
            sumY += p.smoothedDelay;
        }
        const xAvg = sumX / n;
        const yAvg = sumY / n;

        let num = 0, den = 0;
        for (const p of this.delayHist) {
            const dx = p.arrivalTimeMs - xAvg;
            const dy = p.smoothedDelay - yAvg;
            num += dx * dy;
            den += dx * dx;
        }
        if (den === 0) return null;
        return num / den;
    }

    /**
     * Overuse/underuse/normal detection with adaptive threshold.
     */
    _detect(trend, tsDelta, nowMs) {
        if (this.numOfDeltas < 2) {
            this.hypothesis = BandwidthUsage.NORMAL;
            return;
        }

        const kMinNumDeltas = 60;
        const modifiedTrend = Math.min(this.numOfDeltas, kMinNumDeltas) * trend * this.thresholdGain;
        this.prevModifiedTrend = modifiedTrend;

        if (modifiedTrend > this.threshold) {
            if (this.timeOverUsing === -1) {
                this.timeOverUsing = tsDelta / 2;
            } else {
                this.timeOverUsing += tsDelta;
            }
            this.overuseCounter++;
            if (this.timeOverUsing > this.overusingTimeThreshold && this.overuseCounter > 1) {
                if (trend >= this.prevTrend) {
                    this.timeOverUsing = 0;
                    this.overuseCounter = 0;
                    this.hypothesis = BandwidthUsage.OVERUSING;
                }
            }
        } else if (modifiedTrend < -this.threshold) {
            this.timeOverUsing = -1;
            this.overuseCounter = 0;
            this.hypothesis = BandwidthUsage.UNDERUSING;
        } else {
            this.timeOverUsing = -1;
            this.overuseCounter = 0;
            this.hypothesis = BandwidthUsage.NORMAL;
        }

        this.prevTrend = trend;
        this._updateThreshold(modifiedTrend, nowMs);
    }

    _updateThreshold(modifiedTrend, nowMs) {
        if (this.lastUpdateMs === -1) {
            this.lastUpdateMs = nowMs;
        }

        const kMaxAdaptOffsetMs = 15.0;
        if (Math.abs(modifiedTrend) > this.threshold + kMaxAdaptOffsetMs) {
            this.lastUpdateMs = nowMs;
            return;
        }

        const k = Math.abs(modifiedTrend) < this.threshold ? this.kDown : this.kUp;
        const kMaxTimeDeltaMs = 100;
        const timeDeltaMs = Math.min(nowMs - this.lastUpdateMs, kMaxTimeDeltaMs);
        this.threshold += k * (Math.abs(modifiedTrend) - this.threshold) * timeDeltaMs;
        this.threshold = Math.max(6, Math.min(600, this.threshold));
        this.lastUpdateMs = nowMs;
    }
}

// ============================================================================
// LinkCapacityEstimator — Exponential moving average of link capacity
// ============================================================================
class LinkCapacityEstimator {
    constructor() {
        this.estimateKbps = null;
        this.deviationKbps = 0.4;
    }

    hasEstimate() {
        return this.estimateKbps !== null;
    }

    estimateBps() {
        return this.estimateKbps !== null ? this.estimateKbps * 1000 : null;
    }

    upperBoundBps() {
        if (this.estimateKbps === null) return Infinity;
        return (this.estimateKbps + 3 * Math.sqrt(this.deviationKbps * this.estimateKbps)) * 1000;
    }

    lowerBoundBps() {
        if (this.estimateKbps === null) return 0;
        return Math.max(0, this.estimateKbps - 3 * Math.sqrt(this.deviationKbps * this.estimateKbps)) * 1000;
    }

    reset() {
        this.estimateKbps = null;
    }

    onOveruseDetected(acknowledgedRateBps) {
        this._update(acknowledgedRateBps, 0.05);
    }

    onProbeRate(probeRateBps) {
        this._update(probeRateBps, 0.5);
    }

    _update(rateBps, alpha) {
        const rateKbps = rateBps / 1000;
        if (this.estimateKbps === null) {
            this.estimateKbps = rateKbps;
            return;
        }
        const sampleKbps = rateKbps;
        this.estimateKbps = (1 - alpha) * this.estimateKbps + alpha * sampleKbps;
        const error = this.estimateKbps - sampleKbps;
        this.deviationKbps = (1 - alpha) * this.deviationKbps +
            alpha * (error * error) / Math.max(this.estimateKbps, 1.0);
        this.deviationKbps = Math.max(0.4, Math.min(2.5, this.deviationKbps));
    }
}

// ============================================================================
// AimdRateControl — AIMD (Additive Increase / Multiplicative Decrease)
// ============================================================================
class AimdRateControl {
    constructor() {
        this.minConfiguredBitrateBps = MIN_BITRATE_BPS;
        this.maxConfiguredBitrateBps = DEFAULT_MAX_BITRATE_BPS;
        this.currentBitrateBps = null; // null = not initialized
        this.latestEstimatedThroughputBps = null;
        this.linkCapacity = new LinkCapacityEstimator();
        this.rateControlState = RateControlState.HOLD;
        this.timeLastBitrateChangeMs = null;
        this.timeLastBitrateDecreaseMs = null;
        this.timeFirstThroughputEstimateMs = null;
        this.inAlr = false;
        this.rttMs = 200; // default
        this.beta = 0.85;
        this.lastDecreaseBps = null;
        this.inExperiment = false; // no_bitrate_increase_in_alr
    }

    setStartBitrate(startBitrateBps) {
        this.currentBitrateBps = startBitrateBps;
        this.latestEstimatedThroughputBps = startBitrateBps;
        this.rateControlState = RateControlState.HOLD;
    }

    setMinBitrate(minBps) {
        this.minConfiguredBitrateBps = minBps;
    }

    setMaxBitrate(maxBps) {
        this.maxConfiguredBitrateBps = maxBps;
    }

    setRtt(rttMs) {
        this.rttMs = rttMs;
    }

    setInApplicationLimitedRegion(inAlr) {
        this.inAlr = inAlr;
    }

    setNetworkStateEstimate(/* unused for simplicity */) { }

    validEstimate() {
        return this.currentBitrateBps !== null;
    }

    latestEstimate() {
        return this.currentBitrateBps || 0;
    }

    setEstimate(bitrateBps, atTimeMs) {
        const wasInitialized = this.currentBitrateBps !== null;
        this.currentBitrateBps = this._clampBitrate(bitrateBps);
        this.timeLastBitrateChangeMs = atTimeMs;
        if (!wasInitialized) {
            this.rateControlState = RateControlState.HOLD;
        }
    }

    /**
     * Core AIMD state machine update.
     * @param {{ bandwidthUsage: string, estimatedThroughputBps: number|null }} input
     * @param {number} atTimeMs
     * @returns {number} new bitrate estimate in bps
     */
    update(input, atTimeMs) {
        // Initialize from throughput estimate
        if (!this.validEstimate()) {
            if (input.estimatedThroughputBps != null) {
                this.currentBitrateBps = this._clampBitrate(input.estimatedThroughputBps);
                this.timeLastBitrateChangeMs = atTimeMs;
                this.timeFirstThroughputEstimateMs = atTimeMs;
            }
            return this.currentBitrateBps || 0;
        }

        // Wait for 5s of throughput measurements before reacting
        if (input.estimatedThroughputBps != null) {
            if (this.timeFirstThroughputEstimateMs === null) {
                this.timeFirstThroughputEstimateMs = atTimeMs;
            } else if (atTimeMs - this.timeFirstThroughputEstimateMs < 5000 &&
                input.bandwidthUsage === BandwidthUsage.OVERUSING) {
                // In the first 5 seconds, don't decrease on overuse
                // (allow the estimate to settle)
            }
            this.latestEstimatedThroughputBps = input.estimatedThroughputBps;
        }

        this._changeState(input.bandwidthUsage);
        return this._changeBitrate(input, atTimeMs);
    }

    _changeBitrate(input, atTimeMs) {
        const throughput = this.latestEstimatedThroughputBps;

        // Never increase above 1.5x throughput + 10kbps (guard against bad estimates)
        let increaseLimit = Infinity;
        if (throughput != null) {
            increaseLimit = throughput * 1.5 + 10000;
        }

        switch (this.rateControlState) {
            case RateControlState.HOLD:
                break;

            case RateControlState.INCREASE: {
                if (throughput != null && throughput > this.linkCapacity.upperBoundBps()) {
                    this.linkCapacity.reset();
                }

                if (this.linkCapacity.hasEstimate()) {
                    // Additive increase (near-max)
                    const additiveBps = this._additiveRateIncreaseBps(atTimeMs);
                    this.currentBitrateBps += additiveBps;
                } else {
                    // Multiplicative increase (slow-start): 8% per second
                    const timeSinceLastChange = atTimeMs - (this.timeLastBitrateChangeMs || atTimeMs);
                    const dtSeconds = Math.min(timeSinceLastChange, 1000) / 1000;
                    const multiplicativeIncrease = this.currentBitrateBps * (Math.pow(1.08, dtSeconds) - 1.0);
                    this.currentBitrateBps += Math.max(1000, multiplicativeIncrease);
                }

                this.currentBitrateBps = Math.min(this.currentBitrateBps, increaseLimit);
                this.timeLastBitrateChangeMs = atTimeMs;
                break;
            }

            case RateControlState.DECREASE: {
                let decreasedBps;
                if (throughput != null) {
                    decreasedBps = throughput * this.beta;
                    if (decreasedBps > this.currentBitrateBps && this.linkCapacity.hasEstimate()) {
                        decreasedBps = this.beta * this.linkCapacity.estimateBps();
                    }
                } else if (this.linkCapacity.hasEstimate()) {
                    decreasedBps = this.beta * this.linkCapacity.estimateBps();
                } else {
                    decreasedBps = this.currentBitrateBps * this.beta;
                }

                if (decreasedBps < this.currentBitrateBps) {
                    this.currentBitrateBps = decreasedBps;
                }

                if (throughput != null) {
                    this.linkCapacity.onOveruseDetected(throughput);
                }

                this.lastDecreaseBps = this.currentBitrateBps;
                this.currentBitrateBps = this._clampBitrate(this.currentBitrateBps);
                this.timeLastBitrateChangeMs = atTimeMs;
                this.timeLastBitrateDecreaseMs = atTimeMs;

                // Immediately transition to HOLD after a decrease
                this.rateControlState = RateControlState.HOLD;
                break;
            }
        }

        this.currentBitrateBps = this._clampBitrate(this.currentBitrateBps);
        return this.currentBitrateBps;
    }

    /**
     * Compute additive increase rate: ~one packet per response-time interval.
     * response_time = 2 * (RTT + 100ms)
     */
    _additiveRateIncreaseBps(atTimeMs) {
        const timeSinceLastChange = atTimeMs - (this.timeLastBitrateChangeMs || atTimeMs);
        const dtSeconds = Math.min(timeSinceLastChange, 1000) / 1000;

        const bitsPerFrame = this.currentBitrateBps / 30.0;
        const packetsPerFrame = Math.ceil(bitsPerFrame / (8 * 1200));
        const avgPacketSizeBits = bitsPerFrame / packetsPerFrame;

        const responseTimeSeconds = (this.rttMs + 100) / 500; // 2*(rtt+100ms) in seconds
        let increaseRateBpsPerSecond = avgPacketSizeBits / responseTimeSeconds;
        increaseRateBpsPerSecond = Math.max(4000, increaseRateBpsPerSecond);

        return increaseRateBpsPerSecond * dtSeconds;
    }

    /**
     * Whether we can reduce further right now (rate-limiting for overuse).
     */
    timeToReduceFurther(atTimeMs, estimatedThroughputBps) {
        const reducingSlowly = this.timeLastBitrateDecreaseMs != null &&
            (atTimeMs - this.timeLastBitrateDecreaseMs) >= Math.max(10, Math.min(200, this.rttMs));

        if (estimatedThroughputBps != null && estimatedThroughputBps < this.currentBitrateBps * 0.5) {
            return true;
        }
        return reducingSlowly;
    }

    /**
     * For the initial overuse before we have measured throughput.
     */
    initialTimeToReduceFurther(atTimeMs) {
        if (this.timeLastBitrateDecreaseMs === null) return true;
        return (atTimeMs - this.timeLastBitrateDecreaseMs) >= 200;
    }

    _changeState(bandwidthUsage) {
        switch (bandwidthUsage) {
            case BandwidthUsage.NORMAL:
                if (this.rateControlState === RateControlState.HOLD) {
                    this.rateControlState = RateControlState.INCREASE;
                }
                break;
            case BandwidthUsage.OVERUSING:
                this.rateControlState = RateControlState.DECREASE;
                break;
            case BandwidthUsage.UNDERUSING:
                this.rateControlState = RateControlState.HOLD;
                break;
        }
    }

    _clampBitrate(bps) {
        return Math.max(this.minConfiguredBitrateBps, Math.min(this.maxConfiguredBitrateBps, bps));
    }

    getExpectedBandwidthPeriodMs() {
        if (this.lastDecreaseBps != null) {
            const bitsPerFrame = this.currentBitrateBps / 30;
            const packetsPerFrame = Math.ceil(bitsPerFrame / (8 * 1200));
            const avgPacketSizeBits = bitsPerFrame / packetsPerFrame;
            const responseTimeMs = 2 * (this.rttMs + 100);
            const increaseBpsPerMs = Math.max(4000, avgPacketSizeBits / (responseTimeMs / 1000)) / 1000;
            const recoverTimeMs = this.lastDecreaseBps / increaseBpsPerMs;
            return Math.max(2000, Math.min(50000, recoverTimeMs));
        }
        return 3000;
    }
}

// ============================================================================
// BitrateEstimator — Bayesian throughput estimator
// ============================================================================
class BitrateEstimator {
    constructor() {
        this.sumBytes = 0;
        this.currentWindowMs = 0;
        this.prevTimeMs = null;
        this.bitrateEstimateBps = null;
        this.bitrateEstimateVar = 50.0;
        this.uncertaintyScale = 10.0;
        this.initialRateWindowMs = 500;
        this.rateWindowMs = 150;
    }

    /**
     * Process an acknowledged packet.
     */
    update(atTimeMs, amountBytes) {
        if (this.prevTimeMs === null) {
            this.prevTimeMs = atTimeMs;
            return;
        }

        const dtMs = atTimeMs - this.prevTimeMs;
        if (dtMs < 0) return;

        this.currentWindowMs += dtMs;
        this.sumBytes += amountBytes;
        this.prevTimeMs = atTimeMs;

        const rateWindow = this.bitrateEstimateBps === null
            ? this.initialRateWindowMs
            : this.rateWindowMs;

        if (this.currentWindowMs >= rateWindow) {
            this._updateEstimate(this.currentWindowMs);
            this.currentWindowMs = 0;
            this.sumBytes = 0;
        }
    }

    _updateEstimate(windowMs) {
        const bitrateSampleBps = (8000 * this.sumBytes) / windowMs;

        if (this.bitrateEstimateBps === null) {
            this.bitrateEstimateBps = bitrateSampleBps;
            return;
        }

        // Bayesian update
        const sampleUncertainty = this.uncertaintyScale *
            Math.abs(this.bitrateEstimateBps - bitrateSampleBps) /
            (this.bitrateEstimateBps + Math.min(bitrateSampleBps, this.bitrateEstimateBps));
        const sampleVar = sampleUncertainty * sampleUncertainty;
        const predVar = this.bitrateEstimateVar + 5.0; // process noise

        this.bitrateEstimateBps =
            (sampleVar * this.bitrateEstimateBps + predVar * bitrateSampleBps) / (sampleVar + predVar);
        this.bitrateEstimateVar = sampleVar * predVar / (sampleVar + predVar);
    }

    bitrate() {
        return this.bitrateEstimateBps;
    }

    expectFastRateChange() {
        this.bitrateEstimateVar += 200;
    }
}

// ============================================================================
// AcknowledgedBitrateEstimator — Wraps BitrateEstimator with ALR awareness
// ============================================================================
class AcknowledgedBitrateEstimator {
    constructor() {
        this.bitrateEstimator = new BitrateEstimator();
        this.inAlr = false;
    }

    setAlr(inAlr) {
        this.inAlr = inAlr;
    }

    setAlrEndedTime(/* timeMs */) {
        this.bitrateEstimator.expectFastRateChange();
    }

    /**
     * Process a list of PacketResult sorted by receive time.
     */
    incomingPacketFeedbackVector(packetFeedbacks) {
        for (const fb of packetFeedbacks) {
            this.bitrateEstimator.update(fb.receiveTimeMs, fb.sizeBytes);
        }
    }

    bitrate() {
        return this.bitrateEstimator.bitrate();
    }
}

// ============================================================================
// AlrDetector — Detects when the application is sending below capacity
// ============================================================================
class AlrDetector {
    constructor() {
        this.bandwidthUsageRatio = 0.65;
        this.startBudgetLevelRatio = 0.80;
        this.stopBudgetLevelRatio = 0.50;

        this.estimatedBitrateBps = 0;
        this.budget = 0;       // accumulated budget in bytes
        this.lastUpdateMs = null;
        this.alrStartTimeMs = null;
    }

    setEstimatedBitrate(bitrateBps) {
        this.estimatedBitrateBps = bitrateBps;
    }

    onBytesSent(sizeBytes, sendTimeMs) {
        if (this.lastUpdateMs !== null) {
            const dtMs = sendTimeMs - this.lastUpdateMs;
            // Budget grows at target rate (bandwidth * usage_ratio)
            const targetBytesPerMs = (this.estimatedBitrateBps * this.bandwidthUsageRatio) / 8000;
            this.budget += targetBytesPerMs * dtMs;
            this.budget -= sizeBytes;
        }
        this.lastUpdateMs = sendTimeMs;

        // Calculate budget ratio (positive = underspending)
        const budgetTarget = this.estimatedBitrateBps > 0
            ? (this.estimatedBitrateBps * this.bandwidthUsageRatio) / 8
            : 1;
        const budgetRatio = this.budget / budgetTarget;

        if (budgetRatio > this.startBudgetLevelRatio && this.alrStartTimeMs === null) {
            this.alrStartTimeMs = sendTimeMs;
        } else if (budgetRatio < this.stopBudgetLevelRatio && this.alrStartTimeMs !== null) {
            this.alrStartTimeMs = null;
        }
    }

    getApplicationLimitedRegionStartTime() {
        return this.alrStartTimeMs;
    }
}

// ============================================================================
// DelayBasedBwe — Delay-based bandwidth estimation
// ============================================================================
class DelayBasedBwe {
    constructor() {
        this.interArrivalDelta = new InterArrivalDelta(5);
        this.trendlineEstimator = new TrendlineEstimator(20);
        this.rateControl = new AimdRateControl();
        this.prevBitrateBps = 0;
        this.prevState = BandwidthUsage.NORMAL;
        this.lastSeenPacketMs = null;
    }

    setStartBitrate(startBps) {
        this.rateControl.setStartBitrate(startBps);
    }

    setMinBitrate(minBps) {
        this.rateControl.setMinBitrate(minBps);
    }

    onRttUpdate(avgRttMs) {
        this.rateControl.setRtt(avgRttMs);
    }

    lastEstimate() {
        return this.rateControl.latestEstimate();
    }

    lastState() {
        return this.prevState;
    }

    getExpectedBwePeriodMs() {
        return this.rateControl.getExpectedBandwidthPeriodMs();
    }

    /**
     * Process transport feedback.
     * @returns {{ updated, probe, targetBitrateBps, recoveredFromOveruse, delayDetectorState }}
     */
    incomingPacketFeedbackVector(feedbacks, feedbackTimeMs, ackedBitrateBps, probeBitrateBps, inAlr) {
        if (feedbacks.length === 0) {
            return { updated: false, probe: false, targetBitrateBps: 0, recoveredFromOveruse: false, delayDetectorState: BandwidthUsage.NORMAL };
        }

        // Reset if stream timed out
        if (this.lastSeenPacketMs !== null && feedbackTimeMs - this.lastSeenPacketMs > 2000) {
            this.interArrivalDelta = new InterArrivalDelta(5);
            this.trendlineEstimator = new TrendlineEstimator(20);
        }
        this.lastSeenPacketMs = feedbackTimeMs;

        let recoveredFromOveruse = false;
        let prevDetectorState = this.trendlineEstimator.state;

        // Sort by receive time
        const sorted = [...feedbacks].sort((a, b) => a.receiveTimeMs - b.receiveTimeMs);

        for (const fb of sorted) {
            const deltas = this.interArrivalDelta.computeDeltas(
                fb.sendTimeMs, fb.receiveTimeMs, feedbackTimeMs, fb.sizeBytes
            );

            const calculatedDeltas = deltas !== null;
            this.trendlineEstimator.update(
                calculatedDeltas ? deltas.recvDeltaMs : 0,
                calculatedDeltas ? deltas.sendDeltaMs : 0,
                fb.sendTimeMs,
                fb.receiveTimeMs,
                fb.sizeBytes,
                calculatedDeltas
            );

            if (prevDetectorState === BandwidthUsage.UNDERUSING &&
                this.trendlineEstimator.state === BandwidthUsage.NORMAL) {
                recoveredFromOveruse = true;
            }
            prevDetectorState = this.trendlineEstimator.state;
        }

        this.rateControl.setInApplicationLimitedRegion(inAlr);
        return this._maybeUpdateEstimate(ackedBitrateBps, probeBitrateBps, recoveredFromOveruse, inAlr, feedbackTimeMs);
    }

    _maybeUpdateEstimate(ackedBitrateBps, probeBitrateBps, recoveredFromOveruse, inAlr, atTimeMs) {
        const result = {
            updated: false,
            probe: false,
            targetBitrateBps: 0,
            recoveredFromOveruse: false,
            delayDetectorState: this.trendlineEstimator.state,
        };

        if (this.trendlineEstimator.state === BandwidthUsage.OVERUSING) {
            if (ackedBitrateBps != null &&
                this.rateControl.timeToReduceFurther(atTimeMs, ackedBitrateBps)) {
                result.updated = this._updateEstimate(atTimeMs, ackedBitrateBps, result);
            } else if (ackedBitrateBps == null && this.rateControl.validEstimate() &&
                this.rateControl.initialTimeToReduceFurther(atTimeMs)) {
                // Halve rate every 200ms when no throughput estimate
                this.rateControl.setEstimate(this.rateControl.latestEstimate() / 2, atTimeMs);
                result.updated = true;
                result.probe = false;
                result.targetBitrateBps = this.rateControl.latestEstimate();
            }
        } else {
            if (probeBitrateBps != null) {
                result.probe = true;
                result.updated = true;
                this.rateControl.setEstimate(probeBitrateBps, atTimeMs);
                result.targetBitrateBps = this.rateControl.latestEstimate();
            } else {
                result.updated = this._updateEstimate(atTimeMs, ackedBitrateBps, result);
                result.recoveredFromOveruse = recoveredFromOveruse;
            }
        }

        const detectorState = this.trendlineEstimator.state;
        if ((result.updated && this.prevBitrateBps !== result.targetBitrateBps) ||
            detectorState !== this.prevState) {
            this.prevBitrateBps = result.updated ? result.targetBitrateBps : this.prevBitrateBps;
            this.prevState = detectorState;
        }

        result.delayDetectorState = detectorState;
        return result;
    }

    _updateEstimate(atTimeMs, ackedBitrateBps, result) {
        const input = {
            bandwidthUsage: this.trendlineEstimator.state,
            estimatedThroughputBps: ackedBitrateBps,
        };
        result.targetBitrateBps = this.rateControl.update(input, atTimeMs);
        return this.rateControl.validEstimate();
    }

    triggerOveruse(atTimeMs, linkCapacityBps) {
        const input = {
            bandwidthUsage: BandwidthUsage.OVERUSING,
            estimatedThroughputBps: linkCapacityBps,
        };
        return this.rateControl.update(input, atTimeMs);
    }
}

// ============================================================================
// SendSideBandwidthEstimation — Combines delay-based & loss-based estimates
// ============================================================================
class SendSideBandwidthEstimation {
    constructor(startBitrateBps) {
        this.minBitrateConfigured = MIN_BITRATE_BPS;
        this.maxBitrateConfigured = DEFAULT_MAX_BITRATE_BPS;
        this.currentTarget = startBitrateBps;
        this.lastLoggedTarget = startBitrateBps;

        this.hasDecreasedSinceLastFractionLoss = false;
        this.lastLossFeedbackMs = null;
        this.lastLossPacketReportMs = null;
        this.lastFractionLoss = 0;           // Q8 (0-255)
        this.lastRoundTripTimeMs = 0;

        this.receiverLimit = Infinity;
        this.delayBasedLimit = Infinity;
        this.timeLastDecreaseMs = 0;
        this.firstReportTimeMs = null;

        // Loss tracking
        this.lostPacketsSinceLastUpdate = 0;
        this.expectedPacketsSinceLastUpdate = 0;

        // Min history: deque of { timeMs, bitrateBps }
        this.minBitrateHistory = [];

        // Loss-based thresholds
        this.lowLossThreshold = 0.02;
        this.highLossThreshold = 0.10;

        // RTT-based backoff
        this.rttLimit = 3000;
        this.lastRttBackoffMs = 0;
        this.propagationRttMs = 0;
        this.lastPropagationRttUpdateMs = null;

        this.lossBasedState = 'delay_based';
    }

    targetRate() {
        return this.currentTarget;
    }

    fractionLoss() {
        return this.lastFractionLoss;
    }

    roundTripTime() {
        return this.lastRoundTripTimeMs;
    }

    isRttAboveLimit() {
        return this.propagationRttMs > this.rttLimit;
    }

    getMinBitrate() {
        return this.minBitrateConfigured;
    }

    lossBasedStateValue() {
        return this.lossBasedState;
    }

    setBitrates(sendBitrateBps, minBps, maxBps, atTimeMs) {
        this.setMinMaxBitrate(minBps, maxBps);
        if (sendBitrateBps != null) {
            this.setSendBitrate(sendBitrateBps, atTimeMs);
        }
    }

    setSendBitrate(bitrateBps, atTimeMs) {
        this.currentTarget = Math.max(this.minBitrateConfigured, bitrateBps);
        this._updateMinHistory(atTimeMs);
    }

    setMinMaxBitrate(minBps, maxBps) {
        this.minBitrateConfigured = Math.max(MIN_BITRATE_BPS, minBps);
        this.maxBitrateConfigured = maxBps;
    }

    updateReceiverEstimate(atTimeMs, bandwidthBps) {
        this.receiverLimit = bandwidthBps;
        this._applyTargetLimits(atTimeMs);
    }

    updateDelayBasedEstimate(atTimeMs, bitrateBps) {
        this.delayBasedLimit = bitrateBps;
        this._applyTargetLimits(atTimeMs);
    }

    updateRtt(rttMs, atTimeMs) {
        this.lastRoundTripTimeMs = rttMs;
    }

    updatePropagationRtt(atTimeMs, propagationRttMs) {
        this.propagationRttMs = propagationRttMs;
        this.lastPropagationRttUpdateMs = atTimeMs;
    }

    setAcknowledgedRate(bitrateBps, atTimeMs) {
        // Used by LossBasedBweV2 (simplified here)
    }

    onSentPacket(sentPacket) {
        // Used for RTT backoff tracking (simplified)
    }

    onRouteChange() {
        this.currentTarget = this.minBitrateConfigured;
        this.minBitrateHistory = [];
        this.lastFractionLoss = 0;
        this.lastLossFeedbackMs = null;
        this.firstReportTimeMs = null;
        this.hasDecreasedSinceLastFractionLoss = false;
        this.lostPacketsSinceLastUpdate = 0;
        this.expectedPacketsSinceLastUpdate = 0;
    }

    /**
     * Loss-based update triggered from transport loss reports.
     */
    updatePacketsLost(packetsLost, numberOfPackets, atTimeMs) {
        this.lostPacketsSinceLastUpdate += packetsLost;
        this.expectedPacketsSinceLastUpdate += numberOfPackets;

        if (this.expectedPacketsSinceLastUpdate < 20) {
            return; // Wait for more data
        }

        this.hasDecreasedSinceLastFractionLoss = false;
        this.lastLossPacketReportMs = atTimeMs;

        if (this.expectedPacketsSinceLastUpdate > 0) {
            this.lastFractionLoss = Math.min(255,
                Math.round((this.lostPacketsSinceLastUpdate * 256) / this.expectedPacketsSinceLastUpdate));
        }

        this.lostPacketsSinceLastUpdate = 0;
        this.expectedPacketsSinceLastUpdate = 0;

        this.updateEstimate(atTimeMs);
    }

    /**
     * Main periodic update. Applies loss-based and RTT-based adjustments.
     */
    updateEstimate(atTimeMs) {
        // RTT backoff
        if (this.isRttAboveLimit()) {
            if (atTimeMs - this.lastRttBackoffMs >= 1000) {
                this.currentTarget *= 0.8;
                this.lastRttBackoffMs = atTimeMs;
            }
            this.currentTarget = Math.max(this.currentTarget, 5000); // 5kbps floor
            this._applyTargetLimits(atTimeMs);
            return;
        }

        // Start phase (first 2 seconds): just rely on delay-based + receiver limit
        if (this.firstReportTimeMs === null) {
            this.firstReportTimeMs = atTimeMs;
        }
        const inStartPhase = (atTimeMs - this.firstReportTimeMs) < 2000;
        if (inStartPhase) {
            const limit = Math.max(this.delayBasedLimit, this.receiverLimit);
            if (limit < Infinity) {
                this.currentTarget = Math.max(this.currentTarget, limit);
            }
        }

        // Loss-based adjustment
        const kBweIncreaseIntervalMs = 1000;
        const kBweDecreaseIntervalMs = 300;

        const lossRate = this.lastFractionLoss / 256;

        this._updateMinHistory(atTimeMs);

        if (lossRate < this.lowLossThreshold) {
            // Low loss — increase by 8% of min-bitrate + 1kbps
            if (this.minBitrateHistory.length > 0) {
                const minBitrate = this.minBitrateHistory[0].bitrateBps;
                this.currentTarget = minBitrate * 1.08 + 1000;
            }
            this.lossBasedState = 'delay_based';
        } else if (lossRate >= this.lowLossThreshold && lossRate <= this.highLossThreshold) {
            // Medium loss — hold
            this.lossBasedState = 'delay_based';
        } else {
            // High loss — decrease
            if (!this.hasDecreasedSinceLastFractionLoss &&
                atTimeMs - this.timeLastDecreaseMs >= kBweDecreaseIntervalMs + this.lastRoundTripTimeMs) {
                this.currentTarget = this.currentTarget * (1.0 - 0.5 * lossRate);
                this.hasDecreasedSinceLastFractionLoss = true;
                this.timeLastDecreaseMs = atTimeMs;
                this.lossBasedState = 'decreasing';
            }
        }

        this._applyTargetLimits(atTimeMs);
    }

    /**
     * Feed back from LossBasedBweV2 (simplified: just use loss from RTCP).
     */
    updateLossBasedEstimator(feedbackReport, delayDetectorState, probeBitrate, inAlr) {
        // In the real implementation, this would update LossBasedBweV2
        // Here we use the simpler loss-based logic from updatePacketsLost
    }

    _getUpperLimit() {
        return Math.min(this.delayBasedLimit, this.receiverLimit, this.maxBitrateConfigured);
    }

    _applyTargetLimits(atTimeMs) {
        const upper = this._getUpperLimit();
        this.currentTarget = Math.max(this.minBitrateConfigured, Math.min(this.currentTarget, upper));
    }

    _updateMinHistory(atTimeMs) {
        const kBweIncreaseIntervalMs = 1000;
        // Remove stale entries
        while (this.minBitrateHistory.length > 0 &&
            atTimeMs - this.minBitrateHistory[0].timeMs > kBweIncreaseIntervalMs) {
            this.minBitrateHistory.shift();
        }
        // Remove entries that are >= current (keep minimums)
        while (this.minBitrateHistory.length > 0 &&
            this.minBitrateHistory[this.minBitrateHistory.length - 1].bitrateBps >= this.currentTarget) {
            this.minBitrateHistory.pop();
        }
        this.minBitrateHistory.push({ timeMs: atTimeMs, bitrateBps: this.currentTarget });
    }
}

// ============================================================================
// ProbeController — Decides when and at what bitrate to send probe clusters
// ============================================================================
class ProbeController {
    constructor() {
        this.State = Object.freeze({ INIT: 0, WAITING: 1, COMPLETE: 2 });

        this.state = this.State.INIT;
        this.minBitrateBps = 0;
        this.startBitrateBps = 0;
        this.maxBitrateBps = DEFAULT_MAX_BITRATE_BPS;
        this.estimatedBitrateBps = 0;

        this.firstExponentialProbeScale = 3.0;
        this.secondExponentialProbeScale = 6.0;
        this.furtherExponentialProbeScale = 2.0;
        this.furtherProbeThreshold = 0.7;

        this.alrProbing = false;
        this.alrStartTimeMs = null;
        this.lastAlrProbeTimeMs = null;
        this.alrProbingIntervalMs = 5000;
        this.alrProbeScale = 2.0;

        this.lastProbeTimestampMs = null;
        this.maxWaitingTimeMs = 1000;
        this.lastProbeTargetBps = 0;

        this.probeIdCounter = 0;

        // Drop recovery
        this.bitrateBeforeLastLargeDropBps = null;
        this.lastLargeDropTimeMs = null;
        this.lastDropProbeTimeMs = null;

        this.networkAvailable = true;
    }

    onNetworkAvailability(msg) {
        this.networkAvailable = msg.networkAvailable;
        if (!this.networkAvailable) return [];
        return [];
    }

    setBitrates(minBps, startBps, maxBps, atTimeMs) {
        this.minBitrateBps = minBps;
        this.maxBitrateBps = maxBps;

        if (startBps > 0) {
            this.startBitrateBps = startBps;
            if (this.state === this.State.INIT) {
                return this._initiateExponentialProbing(atTimeMs);
            }
        }
        if (maxBps > 0 && maxBps > this.estimatedBitrateBps) {
            // Max increased — may need to probe
        }
        return [];
    }

    setEstimatedBitrate(bitrateBps, bandwidthLimitedCause, atTimeMs) {
        const wasLargerBefore = this.estimatedBitrateBps > 0;
        const ratio = wasLargerBefore ? bitrateBps / this.estimatedBitrateBps : 1;

        if (wasLargerBefore && ratio < 0.66) {
            this.bitrateBeforeLastLargeDropBps = this.estimatedBitrateBps;
            this.lastLargeDropTimeMs = atTimeMs;
        }

        this.estimatedBitrateBps = bitrateBps;

        const probes = [];
        if (this.state === this.State.WAITING) {
            if (bitrateBps > this.furtherProbeThreshold * this.lastProbeTargetBps) {
                // Continue probing
                const target = Math.min(
                    bitrateBps * this.furtherExponentialProbeScale,
                    this.maxBitrateBps
                );
                if (target > bitrateBps) {
                    probes.push(this._createProbe(target, atTimeMs));
                } else {
                    this.state = this.State.COMPLETE;
                }
            } else {
                this.state = this.State.COMPLETE;
            }
        }
        return probes;
    }

    setAlrStartTime(timeMs) {
        this.alrStartTimeMs = timeMs;
    }

    setAlrEndedTime(timeMs) {
        // Could trigger a probe after ALR ends
    }

    enablePeriodicAlrProbing(enable) {
        this.alrProbing = enable;
    }

    enableRepeatedInitialProbing(/* enable */) { }

    onMaxTotalAllocatedBitrate(totalBps, atTimeMs) {
        const probes = [];
        if (totalBps > 0 && totalBps > this.estimatedBitrateBps) {
            const target = Math.min(totalBps, this.maxBitrateBps);
            probes.push(this._createProbe(target, atTimeMs));
        }
        return probes;
    }

    reset(atTimeMs) {
        this.state = this.State.INIT;
        this.lastProbeTimestampMs = null;
        this.bitrateBeforeLastLargeDropBps = null;
    }

    /**
     * Periodic processing — triggers ALR probes or repeated initial probes.
     */
    process(atTimeMs) {
        const probes = [];

        // Timeout waiting state
        if (this.state === this.State.WAITING &&
            this.lastProbeTimestampMs !== null &&
            atTimeMs - this.lastProbeTimestampMs > this.maxWaitingTimeMs) {
            this.state = this.State.COMPLETE;
        }

        // ALR probing
        if (this.alrProbing && this.state === this.State.COMPLETE &&
            this.alrStartTimeMs !== null) {
            if (this.lastAlrProbeTimeMs === null ||
                atTimeMs - this.lastAlrProbeTimeMs > this.alrProbingIntervalMs) {
                const target = Math.min(
                    this.estimatedBitrateBps * this.alrProbeScale,
                    this.maxBitrateBps
                );
                if (target > this.estimatedBitrateBps) {
                    probes.push(this._createProbe(target, atTimeMs));
                    this.lastAlrProbeTimeMs = atTimeMs;
                }
            }
        }

        return probes;
    }

    /**
     * After recovering from overuse, try to re-probe to pre-drop rate.
     */
    requestProbe(atTimeMs) {
        const probes = [];
        if (this.bitrateBeforeLastLargeDropBps !== null &&
            this.lastLargeDropTimeMs !== null &&
            atTimeMs - this.lastLargeDropTimeMs < 5000 &&
            (this.lastDropProbeTimeMs === null || atTimeMs - this.lastDropProbeTimeMs > 5000)) {
            const target = Math.min(
                this.bitrateBeforeLastLargeDropBps * 0.85,
                this.maxBitrateBps
            );
            if (target > this.estimatedBitrateBps * 0.95) {
                probes.push(this._createProbe(target, atTimeMs));
                this.lastDropProbeTimeMs = atTimeMs;
            }
        }
        return probes;
    }

    setNetworkStateEstimate(/* estimate */) { }

    _initiateExponentialProbing(atTimeMs) {
        const probes = [];
        const first = Math.min(
            this.startBitrateBps * this.firstExponentialProbeScale,
            this.maxBitrateBps
        );
        probes.push(this._createProbe(first, atTimeMs));

        const second = Math.min(
            this.startBitrateBps * this.secondExponentialProbeScale,
            this.maxBitrateBps
        );
        if (second > first) {
            probes.push(this._createProbe(second, atTimeMs));
        }

        this.state = this.State.WAITING;
        return probes;
    }

    /**
     * Create a probe cluster configuration.
     */
    _createProbe(targetBps, atTimeMs) {
        this.lastProbeTimestampMs = atTimeMs;
        this.lastProbeTargetBps = targetBps;

        return {
            id: this.probeIdCounter++,
            targetBitrateBps: Math.round(targetBps),
            minPackets: 5,
            minDurationMs: 15,
            atTimeMs,
        };
    }
}

// ============================================================================
// ProbeBitrateEstimator — Estimates bitrate from probe clusters
// ============================================================================
class ProbeBitrateEstimator {
    constructor() {
        // Tracks in-flight probe clusters
        this.clusters = new Map(); // probeClusterId -> { sendBytes, sendStartMs, sendEndMs, recvBytes, recvStartMs, recvEndMs }
        this.lastEstimatedBitrateBps = null;
    }

    handleProbeAndEstimateBitrate(packetFeedback) {
        const probeId = packetFeedback.probeClusterId;
        if (probeId == null) return;

        if (!this.clusters.has(probeId)) {
            this.clusters.set(probeId, {
                sendBytes: 0, sendStartMs: Infinity, sendEndMs: -Infinity,
                recvBytes: 0, recvStartMs: Infinity, recvEndMs: -Infinity,
            });
        }

        const cluster = this.clusters.get(probeId);
        cluster.sendBytes += packetFeedback.sizeBytes;
        cluster.sendStartMs = Math.min(cluster.sendStartMs, packetFeedback.sendTimeMs);
        cluster.sendEndMs = Math.max(cluster.sendEndMs, packetFeedback.sendTimeMs);
        cluster.recvBytes += packetFeedback.sizeBytes;
        cluster.recvStartMs = Math.min(cluster.recvStartMs, packetFeedback.receiveTimeMs);
        cluster.recvEndMs = Math.max(cluster.recvEndMs, packetFeedback.receiveTimeMs);

        const sendDuration = cluster.sendEndMs - cluster.sendStartMs;
        const recvDuration = cluster.recvEndMs - cluster.recvStartMs;

        if (sendDuration <= 0 && recvDuration <= 0) return;

        // Take the minimum of send-side and receive-side estimates (conservative)
        const sendBitrateBps = sendDuration > 0 ? (8000 * cluster.sendBytes / sendDuration) : Infinity;
        const recvBitrateBps = recvDuration > 0 ? (8000 * cluster.recvBytes / recvDuration) : Infinity;

        this.lastEstimatedBitrateBps = Math.min(sendBitrateBps, recvBitrateBps);
    }

    fetchAndResetLastEstimatedBitrate() {
        const result = this.lastEstimatedBitrateBps;
        this.lastEstimatedBitrateBps = null;
        return result;
    }
}

// ============================================================================
// GoogCcController — Top-level controller wiring everything together
// ============================================================================
class GoogCcController {
    /**
     * @param {Object} [config]
     * @param {number} [config.startBitrateBps=300000]
     * @param {number} [config.minBitrateBps=10000]
     * @param {number} [config.maxBitrateBps=30000000]
     */
    constructor(config = {}) {
        const startBitrate = config.startBitrateBps != null ? config.startBitrateBps : DEFAULT_START_BITRATE_BPS;
        const minBitrate = config.minBitrateBps != null ? config.minBitrateBps : MIN_BITRATE_BPS;
        const maxBitrate = config.maxBitrateBps != null ? config.maxBitrateBps : DEFAULT_MAX_BITRATE_BPS;

        this.minBitrate = minBitrate;
        this.maxBitrate = maxBitrate;

        this.probeController = new ProbeController();
        this.delayBasedBwe = new DelayBasedBwe();
        this.bandwidthEstimation = new SendSideBandwidthEstimation(startBitrate);
        this.acknowledgedBitrateEstimator = new AcknowledgedBitrateEstimator();
        this.alrDetector = new AlrDetector();
        this.probeBitrateEstimator = new ProbeBitrateEstimator();

        this.delayBasedBwe.setStartBitrate(startBitrate);
        this.delayBasedBwe.setMinBitrate(minBitrate);

        this.bandwidthEstimation.setBitrates(startBitrate, minBitrate, maxBitrate, 0);

        this.lastTargetBitrateBps = startBitrate;
        this.lastFractionLoss = 0;
        this.lastRttMs = 0;
        this.firstPacketSent = false;
        this.firstFeedbackReceived = false;
        this.previouslyInAlr = false;

        // Pacing
        this.pacingMultiplier = 2.5;

        // Store sent packets for loss computation
        this._sentPackets = new Map(); // seqNum -> { sendTimeMs, sizeBytes, probeClusterId? }
        this._highestAckedSeqNum = -1;

        // Feedback RTT tracking
        this.feedbackMaxRtts = [];

        // Initialize probes
        this._pendingProbes = this.probeController.setBitrates(
            minBitrate, startBitrate, maxBitrate, 0
        );
    }

    // ---- Public API --------------------------------------------------------

    /**
     * Call when a packet is sent.
     * @param {{ seqNum: number, sendTimeMs: number, sizeBytes: number, probeClusterId?: number }} packet
     */
    onSentPacket(packet) {
        this._sentPackets.set(packet.seqNum, {
            sendTimeMs: packet.sendTimeMs,
            sizeBytes: packet.sizeBytes,
            probeClusterId: packet.probeClusterId != null ? packet.probeClusterId : null,
        });

        this.alrDetector.onBytesSent(packet.sizeBytes, packet.sendTimeMs);
        this.acknowledgedBitrateEstimator.setAlr(
            this.alrDetector.getApplicationLimitedRegionStartTime() !== null
        );

        if (!this.firstPacketSent) {
            this.firstPacketSent = true;
            this.bandwidthEstimation.updatePropagationRtt(packet.sendTimeMs, 0);
        }

        // Evict old sent packets (keep last 5000)
        if (this._sentPackets.size > 10000) {
            const cutoff = packet.seqNum - 5000;
            for (const [seq] of this._sentPackets) {
                if (seq < cutoff) this._sentPackets.delete(seq);
            }
        }
    }

    /**
     * Call when receiving transport-cc feedback from the remote peer.
     *
     * @param {{
     *   feedbackTimeMs: number,
     *   packetFeedbacks: Array<{
     *     seqNum: number,
     *     receiveTimeMs: number  // -1 or undefined if lost
     *   }>
     * }} report
     * @returns {{
     *   targetBitrateBps: number,
     *   probeClusters: Array,
     *   pacingBitrateBps: number,
     *   paddingBitrateBps: number,
     *   lossRate: number,
     *   rttMs: number,
     * }}
     */
    onTransportPacketsFeedback(report) {
        if (!report.packetFeedbacks || report.packetFeedbacks.length === 0) {
            return this._currentState(report.feedbackTimeMs);
        }

        if (!this.firstFeedbackReceived) {
            this.firstFeedbackReceived = true;
            this.pacingMultiplier = 1.1;
        }

        // Reconstruct full packet results by matching with sent info
        const received = [];
        let lostCount = 0;
        let totalCount = 0;

        for (const fb of report.packetFeedbacks) {
            const sent = this._sentPackets.get(fb.seqNum);
            if (!sent) continue;

            totalCount++;
            if (fb.receiveTimeMs == null || fb.receiveTimeMs < 0) {
                lostCount++;
                continue;
            }

            received.push({
                seqNum: fb.seqNum,
                sendTimeMs: sent.sendTimeMs,
                receiveTimeMs: fb.receiveTimeMs,
                sizeBytes: sent.sizeBytes,
                probeClusterId: sent.probeClusterId,
            });
        }

        if (received.length === 0) {
            return this._currentState(report.feedbackTimeMs);
        }

        // Compute RTT stats
        let maxFeedbackRttMs = 0;
        let minPropagationRttMs = Infinity;
        let maxRecvTimeMs = 0;

        for (const fb of received) {
            maxRecvTimeMs = Math.max(maxRecvTimeMs, fb.receiveTimeMs);
        }
        for (const fb of received) {
            const feedbackRtt = report.feedbackTimeMs - fb.sendTimeMs;
            const minPendingTime = maxRecvTimeMs - fb.receiveTimeMs;
            const propagationRtt = feedbackRtt - minPendingTime;

            maxFeedbackRttMs = Math.max(maxFeedbackRttMs, feedbackRtt);
            minPropagationRttMs = Math.min(minPropagationRttMs, propagationRtt);
        }

        if (maxFeedbackRttMs > 0) {
            this.feedbackMaxRtts.push(maxFeedbackRttMs);
            if (this.feedbackMaxRtts.length > 32) this.feedbackMaxRtts.shift();
            this.bandwidthEstimation.updatePropagationRtt(report.feedbackTimeMs, Math.max(0, minPropagationRttMs));
        }

        // ALR tracking
        const alrStartTime = this.alrDetector.getApplicationLimitedRegionStartTime();
        if (this.previouslyInAlr && alrStartTime === null) {
            this.acknowledgedBitrateEstimator.setAlrEndedTime(report.feedbackTimeMs);
        }
        this.previouslyInAlr = alrStartTime !== null;
        const inAlr = alrStartTime !== null;

        // Update acknowledged bitrate estimator
        const sortedByRecv = [...received].sort((a, b) => a.receiveTimeMs - b.receiveTimeMs);
        this.acknowledgedBitrateEstimator.incomingPacketFeedbackVector(sortedByRecv);
        const ackedBitrateBps = this.acknowledgedBitrateEstimator.bitrate();

        // Probe bitrate estimation
        for (const fb of sortedByRecv) {
            if (fb.probeClusterId != null) {
                this.probeBitrateEstimator.handleProbeAndEstimateBitrate(fb);
            }
        }
        let probeBitrateBps = this.probeBitrateEstimator.fetchAndResetLastEstimatedBitrate();

        // Guard: don't trust probe if far below current estimate + throughput
        if (probeBitrateBps != null && ackedBitrateBps != null) {
            const limit = Math.min(
                this.delayBasedBwe.lastEstimate(),
                ackedBitrateBps * 0.85
            );
            probeBitrateBps = Math.max(probeBitrateBps, limit);
        }

        // Delay-based BWE
        const delayResult = this.delayBasedBwe.incomingPacketFeedbackVector(
            received, report.feedbackTimeMs, ackedBitrateBps, probeBitrateBps, inAlr
        );

        if (delayResult.updated) {
            if (delayResult.probe) {
                this.bandwidthEstimation.setSendBitrate(delayResult.targetBitrateBps, report.feedbackTimeMs);
            }
            this.bandwidthEstimation.updateDelayBasedEstimate(
                report.feedbackTimeMs, delayResult.targetBitrateBps
            );
        }

        // Loss-based update
        if (totalCount > 0) {
            this.bandwidthEstimation.updatePacketsLost(lostCount, totalCount, report.feedbackTimeMs);
        }

        // RTT update
        if (maxFeedbackRttMs > 0) {
            this.bandwidthEstimation.updateRtt(maxFeedbackRttMs, report.feedbackTimeMs);
            this.delayBasedBwe.onRttUpdate(maxFeedbackRttMs);
        }

        // Update target and gather probes
        const update = this._maybeUpdateNetworkChanged(report.feedbackTimeMs);

        // Recovery probes after overuse
        if (delayResult.recoveredFromOveruse) {
            this.probeController.setAlrStartTime(alrStartTime);
            const recoveryProbes = this.probeController.requestProbe(report.feedbackTimeMs);
            update.probeClusters.push(...recoveryProbes);
        }

        return update;
    }

    /**
     * Call periodically (every ~25-100ms) to allow timed processing.
     * @param {number} nowMs
     * @returns {Object} Same shape as onTransportPacketsFeedback return value
     */
    onProcessInterval(nowMs) {
        this.bandwidthEstimation.updateEstimate(nowMs);

        this.probeController.setAlrStartTime(
            this.alrDetector.getApplicationLimitedRegionStartTime()
        );

        const probes = this.probeController.process(nowMs);
        const update = this._maybeUpdateNetworkChanged(nowMs);
        update.probeClusters.push(...probes);
        return update;
    }

    /**
     * Call when receiving a REMB (Receiver Estimated Max Bitrate) message.
     * @param {number} bitrateBps
     * @param {number} atTimeMs
     */
    onRemoteBitrateReport(bitrateBps, atTimeMs) {
        this.bandwidthEstimation.updateReceiverEstimate(atTimeMs, bitrateBps);
    }

    /**
     * Get pending probe clusters that need to be sent.
     * Each cluster specifies target bitrate and min packets/duration.
     * @returns {Array<{ id, targetBitrateBps, minPackets, minDurationMs }>}
     */
    getPendingProbes() {
        const probes = [...this._pendingProbes];
        this._pendingProbes = [];
        return probes;
    }

    // ---- Internal ----------------------------------------------------------
    _maybeUpdateNetworkChanged(atTimeMs) {
        const fractionLoss = this.bandwidthEstimation.fractionLoss();
        const rttMs = this.bandwidthEstimation.roundTripTime();
        const targetBitrateBps = this.bandwidthEstimation.targetRate();

        let changed = false;
        if (targetBitrateBps !== this.lastTargetBitrateBps ||
            fractionLoss !== this.lastFractionLoss ||
            rttMs !== this.lastRttMs) {
            changed = true;
            this.lastTargetBitrateBps = targetBitrateBps;
            this.lastFractionLoss = fractionLoss;
            this.lastRttMs = rttMs;

            this.alrDetector.setEstimatedBitrate(targetBitrateBps);
        }

        const probeClusters = [];
        if (changed) {
            const newProbes = this.probeController.setEstimatedBitrate(
                targetBitrateBps, null, atTimeMs
            );
            probeClusters.push(...newProbes);
        }

        this._pendingProbes.push(...probeClusters);

        const pacingBitrateBps = Math.max(
            this.minBitrate, targetBitrateBps
        ) * this.pacingMultiplier;

        return {
            targetBitrateBps: Math.round(targetBitrateBps),
            probeClusters,
            pacingBitrateBps: Math.round(pacingBitrateBps),
            paddingBitrateBps: 0,
            lossRate: fractionLoss / 255,
            rttMs,
        };
    }

    _currentState(atTimeMs) {
        return {
            targetBitrateBps: Math.round(this.lastTargetBitrateBps),
            probeClusters: [],
            pacingBitrateBps: Math.round(this.lastTargetBitrateBps * this.pacingMultiplier),
            paddingBitrateBps: 0,
            lossRate: this.lastFractionLoss / 255,
            rttMs: this.lastRttMs,
        };
    }
}
