/**
 * Acknowledged bitrate estimation for packet-feedback based GCC.
 *
 * The estimator smooths throughput measured from recently acknowledged packets,
 * similar in spirit to WebRTC's acknowledged_bitrate_estimator.cc.
 */

export interface AckedPacket {
  arrivalTimeMs: number;
  sendTimeMs: number;
  sizeBytes: number;
}

const ACK_BITRATE_SMOOTHING = 0.85;
const ACK_WINDOW_MS = 500;

/**
 * Computes a smoothed bitrate from acknowledged packet feedback.
 */
export class AcknowledgedBitrateEstimator {
  estimateBps: number|null;
  recentPackets: AckedPacket[];

  constructor() {
    this.estimateBps = null;
    this.recentPackets = [];
  }

  /**
   * Feeds newly acknowledged packets into the bitrate estimate.
   */
  update(packets: AckedPacket[]): void {
    if (packets.length === 0) {
      return;
    }

    const sortedPackets =
        [...packets].sort((left, right) => left.arrivalTimeMs -
            right.arrivalTimeMs);
    const latestArrivalTimeMs =
        sortedPackets[sortedPackets.length - 1]!.arrivalTimeMs;

    this.recentPackets.push(...sortedPackets);
    this.recentPackets = this.recentPackets.filter(
        (packet) => latestArrivalTimeMs - packet.arrivalTimeMs <=
            ACK_WINDOW_MS);

    if (this.recentPackets.length < 2) {
      return;
    }

    const firstArrivalTimeMs = this.recentPackets[0]!.arrivalTimeMs;
    const durationMs = latestArrivalTimeMs - firstArrivalTimeMs;
    if (durationMs <= 0) {
      return;
    }

    const totalBytes = this.recentPackets.reduce(
        (sumBytes, packet) => sumBytes + packet.sizeBytes, 0);
    const measuredBitrateBps = totalBytes * 8 * 1000 / durationMs;

    this.estimateBps = this.estimateBps === null ? measuredBitrateBps :
                                                   ACK_BITRATE_SMOOTHING *
            this.estimateBps +
            (1 - ACK_BITRATE_SMOOTHING) * measuredBitrateBps;
  }

  getEstimateBps(): number|null {
    return this.estimateBps;
  }
}
