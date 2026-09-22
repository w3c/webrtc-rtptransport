/**
 * Packet group delta computation for delay-based congestion control.
 *
 * This follows the packet grouping used by Google Congestion Control (GCC) in
 * WebRTC's inter_arrival_delta.cc. Packets are grouped into send-time bursts
 * and the estimator reports deltas between consecutive completed groups.
 */

interface TimestampGroup {
  completeArrivalTimeMs: number;
  firstArrivalTimeMs: number;
  firstSendTimeMs: number;
  lastSendTimeMs: number;
  sizeBytes: number;
}

const BURST_DELTA_THRESHOLD_MS = 5;
const MAX_BURST_DURATION_MS = 100;
const MAX_CONSECUTIVE_REORDERED_GROUPS = 3;

/**
 * Groups packets by send-time burst and returns inter-group deltas.
 */
export class InterArrivalDelta {
  currentGroup: TimestampGroup|null;
  previousGroup: TimestampGroup|null;
  consecutiveReorderedGroups: number;
  sendTimeGroupLengthMs: number;

  constructor(sendTimeGroupLengthMs: number = 5) {
    this.sendTimeGroupLengthMs = sendTimeGroupLengthMs;
    this.currentGroup = null;
    this.previousGroup = null;
    this.consecutiveReorderedGroups = 0;
  }

  /**
   * Updates the current packet group state and returns inter-group deltas when
   * a completed group boundary is observed.
   */
  computeDeltas(
      sendTimeMs: number, arrivalTimeMs: number,
      packetSize: number): {
    arrivalDeltaMs: number;
    sendDeltaMs: number;
    sizeDelta: number;
  }|null {
    if (!this.currentGroup) {
      this.currentGroup =
          this.createTimestampGroup(sendTimeMs, arrivalTimeMs, packetSize);
      return null;
    }

    if (sendTimeMs < this.currentGroup.firstSendTimeMs) {
      return null;
    }

    if (!this.isNewTimestampGroup(sendTimeMs, arrivalTimeMs)) {
      this.addPacketToGroup(this.currentGroup, sendTimeMs, arrivalTimeMs,
          packetSize);
      return null;
    }

    const completedGroup = this.currentGroup;
    let deltas: {
      arrivalDeltaMs: number;
      sendDeltaMs: number;
      sizeDelta: number;
    }|null = null;

    if (this.previousGroup) {
      const sendDeltaMs =
          completedGroup.firstSendTimeMs - this.previousGroup.firstSendTimeMs;
      const arrivalDeltaMs =
          completedGroup.completeArrivalTimeMs -
          this.previousGroup.completeArrivalTimeMs;

      if (arrivalDeltaMs < 0 || sendDeltaMs <= 0) {
        this.consecutiveReorderedGroups++;
        if (this.consecutiveReorderedGroups >=
            MAX_CONSECUTIVE_REORDERED_GROUPS) {
          this.reset();
          this.currentGroup =
              this.createTimestampGroup(sendTimeMs, arrivalTimeMs, packetSize);
          return null;
        }
      } else {
        this.consecutiveReorderedGroups = 0;
        deltas = {
          arrivalDeltaMs,
          sendDeltaMs,
          sizeDelta: completedGroup.sizeBytes - this.previousGroup.sizeBytes,
        };
      }
    }

    this.previousGroup = { ...completedGroup };
    this.currentGroup =
        this.createTimestampGroup(sendTimeMs, arrivalTimeMs, packetSize);
    return deltas;
  }

  private addPacketToGroup(
      group: TimestampGroup, sendTimeMs: number, arrivalTimeMs: number,
      packetSize: number): void {
    group.lastSendTimeMs = Math.max(group.lastSendTimeMs, sendTimeMs);
    group.completeArrivalTimeMs =
        Math.max(group.completeArrivalTimeMs, arrivalTimeMs);
    group.sizeBytes += packetSize;
  }

  private createTimestampGroup(
      sendTimeMs: number, arrivalTimeMs: number,
      packetSize: number): TimestampGroup {
    return {
      completeArrivalTimeMs: arrivalTimeMs,
      firstArrivalTimeMs: arrivalTimeMs,
      firstSendTimeMs: sendTimeMs,
      lastSendTimeMs: sendTimeMs,
      sizeBytes: packetSize,
    };
  }

  private isNewTimestampGroup(
      sendTimeMs: number, arrivalTimeMs: number): boolean {
    if (!this.currentGroup) {
      return false;
    }

    if (sendTimeMs - this.currentGroup.firstSendTimeMs <=
        this.sendTimeGroupLengthMs) {
      return false;
    }

    return !this.isPacketInBurst(sendTimeMs, arrivalTimeMs);
  }

  private isPacketInBurst(sendTimeMs: number, arrivalTimeMs: number): boolean {
    if (!this.currentGroup) {
      return false;
    }

    const arrivalDeltaMs =
        arrivalTimeMs - this.currentGroup.completeArrivalTimeMs;
    const sendDeltaMs = sendTimeMs - this.currentGroup.lastSendTimeMs;
    const propagationDeltaMs = arrivalDeltaMs - sendDeltaMs;

    return arrivalDeltaMs <= BURST_DELTA_THRESHOLD_MS &&
        propagationDeltaMs < 0 &&
        arrivalTimeMs - this.currentGroup.firstArrivalTimeMs <
            MAX_BURST_DURATION_MS;
  }

  private reset(): void {
    this.currentGroup = null;
    this.previousGroup = null;
    this.consecutiveReorderedGroups = 0;
  }
}
