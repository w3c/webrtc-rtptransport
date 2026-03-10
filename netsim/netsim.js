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

function runSimulation(cfg) {
    const linkAB = new NetworkLinkSimulator('A → B', cfg.linkAB);
    const linkBA = new NetworkLinkSimulator('B → A', cfg.linkBA);

    const PKT_SIZE = cfg.packetSizeBytes;
    const FEEDBACK_INTERVAL_MS = 50;
    const PROCESS_INTERVAL_MS = 25;
    const FEEDBACK_PKT_SIZE = 80;
    const duration = cfg.durationMs;
    const DRAIN_MS = 2000;

    // ---- Endpoint A (sends data via linkAB, receives data+feedback from linkBA) ----
    const ccA = new GoogCcController({
        startBitrateBps: cfg.startBitrateBps,
        minBitrateBps: 30_000,
        maxBitrateBps: cfg.maxBitrateBps,
    });
    let bitrateA = cfg.startBitrateBps;
    let seqA = 0;
    let budgetA = 0;
    let lastProcessA = 0;

    // Receiver-A state: receives B's data from linkBA, sends feedback via linkAB
    let highestRecvSeqBA = -1;
    let lastReportedSeqBA = -1;
    const recvMapBA = new Map();
    let lastFeedbackFromA = -FEEDBACK_INTERVAL_MS;

    // ---- Endpoint B (sends data via linkBA, receives data+feedback from linkAB) ----
    const ccB = new GoogCcController({
        startBitrateBps: cfg.startBitrateBps,
        minBitrateBps: 30_000,
        maxBitrateBps: cfg.maxBitrateBps,
    });
    let bitrateB = cfg.startBitrateBps;
    let seqB = 0;
    let budgetB = 0;
    let lastProcessB = 0;

    // Receiver-B state: receives A's data from linkAB, sends feedback via linkBA
    let highestRecvSeqAB = -1;
    let lastReportedSeqAB = -1;
    const recvMapAB = new Map();
    let lastFeedbackFromB = -FEEDBACK_INTERVAL_MS;

    const bitrateLogA = [{ timeMs: 0, targetBps: bitrateA, ackedBps: 0 }];
    const bitrateLogB = [{ timeMs: 0, targetBps: bitrateB, ackedBps: 0 }];

    const endTime = duration + DRAIN_MS;
    for (let now = 0; now <= endTime; now++) {

        // 1. Dequeue from linkAB → packets arrive at B
        while (linkAB.nextDequeueTimeMs() <= now) {
            const result = linkAB.dequeue(now);
            if (!result) {
                break;
            }
            const pkt = result.packet;

            if (pkt.type === 'data') {
                // B received data sent by A
                recvMapAB.set(pkt.seqNum, now);
                highestRecvSeqAB = Math.max(highestRecvSeqAB, pkt.seqNum);
            } else if (pkt.type === 'feedback') {
                // B receives feedback about B's own data (sent by A as receiver)
                // Override feedbackTimeMs with B's receive time for correct RTT
                const update = ccB.onTransportPacketsFeedback({
                    feedbackTimeMs: now,
                    packetFeedbacks: pkt.packetFeedbacks,
                });
                bitrateB = update.targetBitrateBps;
                const ackedB = ccB.acknowledgedBitrateEstimator.bitrate() || 0;
                bitrateLogB.push({ timeMs: now, targetBps: bitrateB, ackedBps: ackedB });
            }
        }

        // 2. Dequeue from linkBA → packets arrive at A
        while (linkBA.nextDequeueTimeMs() <= now) {
            const result = linkBA.dequeue(now);
            if (!result) {
                break;
            }
            const pkt = result.packet;

            if (pkt.type === 'data') {
                // A received data sent by B
                recvMapBA.set(pkt.seqNum, now);
                highestRecvSeqBA = Math.max(highestRecvSeqBA, pkt.seqNum);
            } else if (pkt.type === 'feedback') {
                // A receives feedback about A's own data (sent by B as receiver)
                const update = ccA.onTransportPacketsFeedback({
                    feedbackTimeMs: now,
                    packetFeedbacks: pkt.packetFeedbacks,
                });
                bitrateA = update.targetBitrateBps;
                const ackedA = ccA.acknowledgedBitrateEstimator.bitrate() || 0;
                bitrateLogA.push({ timeMs: now, targetBps: bitrateA, ackedBps: ackedA });
            }
        }

        // 3. Send data packets (only during active period)
        if (now <= duration) {
            // A sends data on linkAB
            budgetA += bitrateA / 8000; // bytes per ms
            while (budgetA >= PKT_SIZE) {
                budgetA -= PKT_SIZE;
                ccA.onSentPacket({ seqNum: seqA, sendTimeMs: now, sizeBytes: PKT_SIZE });
                linkAB.enqueue({ type: 'data', seqNum: seqA }, PKT_SIZE, now);
                seqA++;
            }

            // B sends data on linkBA
            budgetB += bitrateB / 8000;
            while (budgetB >= PKT_SIZE) {
                budgetB -= PKT_SIZE;
                ccB.onSentPacket({ seqNum: seqB, sendTimeMs: now, sizeBytes: PKT_SIZE });
                linkBA.enqueue({ type: 'data', seqNum: seqB }, PKT_SIZE, now);
                seqB++;
            }
        }

        // 4. Generate & send feedback packets
        // B sends feedback about A's data (via linkBA)
        if (now - lastFeedbackFromB >= FEEDBACK_INTERVAL_MS && highestRecvSeqAB > lastReportedSeqAB) {
            const feedbacks = [];
            for (let seq = lastReportedSeqAB + 1; seq <= highestRecvSeqAB; seq++) {
                if (recvMapAB.has(seq)) {
                    feedbacks.push({ seqNum: seq, receiveTimeMs: recvMapAB.get(seq) });
                    recvMapAB.delete(seq);
                } else {
                    feedbacks.push({ seqNum: seq, receiveTimeMs: -1 });
                }
            }
            lastReportedSeqAB = highestRecvSeqAB;
            linkBA.enqueue({ type: 'feedback', packetFeedbacks: feedbacks }, FEEDBACK_PKT_SIZE, now);
            lastFeedbackFromB = now;
        }

        // A sends feedback about B's data (via linkAB)
        if (now - lastFeedbackFromA >= FEEDBACK_INTERVAL_MS && highestRecvSeqBA > lastReportedSeqBA) {
            const feedbacks = [];
            for (let seq = lastReportedSeqBA + 1; seq <= highestRecvSeqBA; seq++) {
                if (recvMapBA.has(seq)) {
                    feedbacks.push({ seqNum: seq, receiveTimeMs: recvMapBA.get(seq) });
                    recvMapBA.delete(seq);
                } else {
                    feedbacks.push({ seqNum: seq, receiveTimeMs: -1 });
                }
            }
            lastReportedSeqBA = highestRecvSeqBA;
            linkAB.enqueue({ type: 'feedback', packetFeedbacks: feedbacks }, FEEDBACK_PKT_SIZE, now);
            lastFeedbackFromA = now;
        }

        // 5. GoogCC process intervals
        if (now - lastProcessA >= PROCESS_INTERVAL_MS) {
            const update = ccA.onProcessInterval(now);
            bitrateA = update.targetBitrateBps;
            const ackedA = ccA.acknowledgedBitrateEstimator.bitrate() || 0;
            bitrateLogA.push({ timeMs: now, targetBps: bitrateA, ackedBps: ackedA });
            lastProcessA = now;
        }
        if (now - lastProcessB >= PROCESS_INTERVAL_MS) {
            const update = ccB.onProcessInterval(now);
            bitrateB = update.targetBitrateBps;
            const ackedB = ccB.acknowledgedBitrateEstimator.bitrate() || 0;
            bitrateLogB.push({ timeMs: now, targetBps: bitrateB, ackedBps: ackedB });
            lastProcessB = now;
        }
    }

    // Add final log entries
    const ackedAFinal = ccA.acknowledgedBitrateEstimator.bitrate() || 0;
    const ackedBFinal = ccB.acknowledgedBitrateEstimator.bitrate() || 0;
    bitrateLogA.push({ timeMs: endTime, targetBps: bitrateA, ackedBps: ackedAFinal });
    bitrateLogB.push({ timeMs: endTime, targetBps: bitrateB, ackedBps: ackedBFinal });

    return {
        linkAB,
        linkBA,
        bitrateLogA,
        bitrateLogB,
        ccA,
        ccB,
        virtualTimeMs: endTime,
    };
}

// ================================================================
//  Chart helpers
// ================================================================

function decimateMinMax(data, maxPoints) {
    if (data.length <= maxPoints) return data;
    const bucketCount = Math.floor(maxPoints / 2);
    const bucketSize = data.length / bucketCount;
    const result = [data[0]];
    for (let i = 0; i < bucketCount; i++) {
        const lo = Math.floor(i * bucketSize);
        const hi = Math.min(Math.floor((i + 1) * bucketSize), data.length);
        let minPt = data[lo], maxPt = data[lo];
        for (let j = lo; j < hi; j++) {
            if (data[j].y < minPt.y) minPt = data[j];
            if (data[j].y > maxPt.y) maxPt = data[j];
        }
        if (minPt.x <= maxPt.x) {
            result.push(minPt);
            if (minPt !== maxPt) result.push(maxPt);
        } else {
            result.push(maxPt);
            if (minPt !== maxPt) result.push(minPt);
        }
    }
    result.push(data[data.length - 1]);
    return result;
}

let charts = {};

function destroyAllCharts() {
    for (const key of Object.keys(charts)) {
        if (charts[key]) { charts[key].destroy(); charts[key] = null; }
    }
    charts = {};
}

function buildCcChart(canvasId, title, bitrateLog, linkCapacityBps) {
    const ctx = document.getElementById(canvasId).getContext('2d');

    let targetData = bitrateLog.map(p => ({ x: p.timeMs / 1000, y: p.targetBps / 1000 }));
    targetData = decimateMinMax(targetData, 4000);

    let ackedData = bitrateLog
        .filter(p => p.ackedBps > 0)
        .map(p => ({ x: p.timeMs / 1000, y: p.ackedBps / 1000 }));
    ackedData = decimateMinMax(ackedData, 4000);

    const endTime = bitrateLog[bitrateLog.length - 1].timeMs / 1000;
    const capacityData = [
        { x: 0, y: linkCapacityBps / 1000 },
        { x: endTime, y: linkCapacityBps / 1000 },
    ];

    return new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [
                {
                    label: 'Target Bitrate (kbps)',
                    data: targetData,
                    stepped: 'before',
                    borderColor: '#2563eb',
                    backgroundColor: 'rgba(37,99,235,0.06)',
                    fill: true,
                    pointRadius: 0,
                    borderWidth: 1.5,
                    order: 1,
                },
                {
                    label: 'Acked Bitrate (kbps)',
                    data: ackedData,
                    borderColor: '#10b981',
                    backgroundColor: 'transparent',
                    fill: false,
                    pointRadius: 0,
                    borderWidth: 1.5,
                    tension: 0.3,
                    order: 2,
                },
                {
                    label: 'Link Capacity (kbps)',
                    data: capacityData,
                    borderColor: '#ef4444',
                    backgroundColor: 'transparent',
                    borderDash: [6, 4],
                    fill: false,
                    pointRadius: 0,
                    borderWidth: 2,
                    order: 3,
                },
            ],
        },
        options: {
            responsive: true,
            animation: false,
            interaction: { mode: 'nearest', intersect: false },
            scales: {
                x: {
                    type: 'linear',
                    title: { display: true, text: 'Time (s)', font: { size: 12 } },
                    ticks: { font: { size: 11 } },
                },
                y: {
                    title: { display: true, text: 'Bitrate (kbps)', font: { size: 12 } },
                    beginAtZero: true,
                    ticks: { font: { size: 11 } },
                },
            },
            plugins: {
                title: { display: true, text: title, font: { size: 15, weight: '600' }, padding: { bottom: 8 } },
                legend: { position: 'bottom', labels: { usePointStyle: true, padding: 14, font: { size: 12 } } },
                tooltip: {
                    callbacks: {
                        label(ctx) {
                            return `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(0)} kbps`;
                        }
                    }
                },
            },
        },
    });
}

function buildLinkChart(canvasId, title, link) {
    const ctx = document.getElementById(canvasId).getContext('2d');

    // Convert to chart coordinates (seconds, KB)
    let queueData = link.queueLog.map(p => ({ x: p.timeMs / 1000, y: p.queueBytes / 1024 }));
    queueData = decimateMinMax(queueData, 8000);

    const overflowPts = link.lossLog
        .filter(e => e.reason === 'overflow')
        .map(e => ({ x: e.timeMs / 1000, y: 0 }));
    const randomPts = link.lossLog
        .filter(e => e.reason === 'random')
        .map(e => ({ x: e.timeMs / 1000, y: 0 }));
    const burstPts = link.lossLog
        .filter(e => e.reason === 'burst')
        .map(e => ({ x: e.timeMs / 1000, y: 0 }));

    return new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [
                {
                    label: 'Data in Link (KB)',
                    data: queueData,
                    stepped: 'before',
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59,130,246,0.08)',
                    fill: true,
                    pointRadius: 0,
                    borderWidth: 1.5,
                    order: 2,
                },
                {
                    label: 'Overflow Drop',
                    data: overflowPts,
                    type: 'scatter',
                    pointRadius: 6,
                    pointHoverRadius: 8,
                    pointStyle: 'triangle',
                    backgroundColor: '#ef4444',
                    borderColor: '#ef4444',
                    order: 0,
                },
                {
                    label: 'Random Drop',
                    data: randomPts,
                    type: 'scatter',
                    pointRadius: 4,
                    pointHoverRadius: 7,
                    backgroundColor: '#f97316',
                    borderColor: '#f97316',
                    order: 0,
                },
                {
                    label: 'Burst Drop',
                    data: burstPts,
                    type: 'scatter',
                    pointRadius: 5,
                    pointHoverRadius: 8,
                    pointStyle: 'rectRot',
                    backgroundColor: '#a855f7',
                    borderColor: '#a855f7',
                    order: 0,
                },
            ],
        },
        options: {
            responsive: true,
            animation: false,
            interaction: { mode: 'nearest', intersect: false },
            scales: {
                x: {
                    type: 'linear',
                    title: { display: true, text: 'Time (s)', font: { size: 12 } },
                    ticks: { font: { size: 11 } },
                },
                y: {
                    title: { display: true, text: 'Data in Link (KB)', font: { size: 12 } },
                    beginAtZero: true,
                    ticks: { font: { size: 11 } },
                },
            },
            plugins: {
                title: { display: true, text: title, font: { size: 15, weight: '600' }, padding: { bottom: 8 } },
                legend: { position: 'bottom', labels: { usePointStyle: true, padding: 14, font: { size: 12 } } },
                tooltip: {
                    callbacks: {
                        label(ctx) {
                            if (ctx.dataset.type === 'scatter') {
                                return `${ctx.dataset.label} @ ${ctx.parsed.x.toFixed(3)}s`;
                            }
                            return `${ctx.parsed.y.toFixed(1)} KB`;
                        }
                    }
                },
            },
        },
    });
}

function renderStats(elId, name, link, cc) {
    const el = document.getElementById(elId);
    const s = link.stats;
    const lossRate = s.sent > 0 ? ((s.dropped / s.sent) * 100).toFixed(2) : '0.00';
    const overflow = link.lossLog.filter(e => e.reason === 'overflow').length;
    const random = link.lossLog.filter(e => e.reason === 'random').length;
    const burst = link.lossLog.filter(e => e.reason === 'burst').length;

    const ccState = cc._currentState(0);
    const ackedBps = cc.acknowledgedBitrateEstimator.bitrate() || 0;

    el.innerHTML = `
    <h3>${name}</h3>
    <p><b>CC Target:</b> ${(ccState.targetBitrateBps / 1000).toFixed(0)} kbps</p>
    <p><b>Acked Rate:</b> ${(ackedBps / 1000).toFixed(0)} kbps</p>
    <p><b>CC Loss:</b> ${(ccState.lossRate * 100).toFixed(1)}%&emsp;<b>RTT:</b> ${ccState.rttMs.toFixed(0)} ms</p>
    <hr style="margin:6px 0;border:none;border-top:1px solid #e2e8f0">
    <p>Pkts sent: <b>${s.sent.toLocaleString()}</b>&emsp;Delivered: <b>${s.delivered.toLocaleString()}</b></p>
    <p>Dropped: <b>${s.dropped.toLocaleString()}</b> (${lossRate}%)</p>
    <p class="sub">Overflow: ${overflow.toLocaleString()}&emsp;Random: ${random.toLocaleString()}&emsp;Burst: ${burst.toLocaleString()}</p>`;
}

// ================================================================
//  UI wiring
// ================================================================

document.querySelectorAll('input[type="range"]').forEach(input => {
    const span = document.getElementById(input.id + '-v');
    if (!span) return;
    const refresh = () => {
        const v = parseFloat(input.value);
        span.textContent = (input.step && parseFloat(input.step) < 1) ? v.toFixed(1) : String(v);
    };
    input.addEventListener('input', refresh);
    refresh();
});

function val(id) {
    return parseFloat(document.getElementById(id).value);
}

function getConfig() {
    return {
        linkAB: {
            bitrateBps: val('linkab-bitrate') * 1000,
            maxQueueBytes: val('linkab-queue') * 1024,
            fixedLatencyMs: val('linkab-latency'),
            randomLossRate: val('linkab-rloss') / 100,
            burstLossRate: val('linkab-bloss') / 100,
        },
        linkBA: {
            bitrateBps: val('linkba-bitrate') * 1000,
            maxQueueBytes: val('linkba-queue') * 1024,
            fixedLatencyMs: val('linkba-latency'),
            randomLossRate: val('linkba-rloss') / 100,
            burstLossRate: val('linkba-bloss') / 100,
        },
        startBitrateBps: val('cc-start') * 1000,
        maxBitrateBps: val('cc-max') * 1000,
        packetSizeBytes: val('pkt-size'),
        durationMs: val('sim-dur') * 1000,
    };
}

document.getElementById('run-btn').addEventListener('click', () => {
    const btn = document.getElementById('run-btn');
    btn.disabled = true;
    btn.textContent = 'Running…';

    setTimeout(() => {
        try {
            const cfg = getConfig();

            const t0 = performance.now();
            const result = runSimulation(cfg);
            const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

            destroyAllCharts();

            charts.ccA = buildCcChart('chart-cc-a', 'GoogCC: Endpoint A → B', result.bitrateLogA, cfg.linkAB.bitrateBps);
            charts.ccB = buildCcChart('chart-cc-b', 'GoogCC: Endpoint B → A', result.bitrateLogB, cfg.linkBA.bitrateBps);
            charts.linkAB = buildLinkChart('chart-ab', 'Link A → B (queue)', result.linkAB);
            charts.linkBA = buildLinkChart('chart-ba', 'Link B → A (queue)', result.linkBA);

            document.getElementById('stats-row').style.display = 'grid';
            renderStats('stats-ab', 'A → B', result.linkAB, result.ccA);
            renderStats('stats-ba', 'B → A', result.linkBA, result.ccB);

            document.getElementById('sim-info').textContent =
                `Simulated ${(result.virtualTimeMs / 1000).toFixed(1)}s of virtual time ` +
                `in ${elapsed}s wall-clock`;

        } catch (err) {
            console.error(err);
            alert('Simulation error: ' + err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Run Simulation';
        }
    }, 60);
});
