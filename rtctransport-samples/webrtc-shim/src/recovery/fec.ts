// XOR-based Forward Error Correction (RFC 5109 ULP FEC)
//
// Simplified FEC: protects groups of N media packets with one FEC packet.
// Each FEC packet is the XOR of all protected packets' payloads.
// Recovery: when exactly one packet in a group is lost, XOR the FEC packet
// with all received packets to recover the missing one.
//
// Reference: WebRTC modules/rtp_rtcp/source/forward_error_correction.cc
//            modules/rtp_rtcp/source/ulpfec_generator.cc

export interface FecEncoderOptions {
  /** Number of media packets per FEC group (default: 5) */
  groupSize?: number;
  /** Payload type for FEC packets */
  fecPayloadType?: number;
}

export interface FecPacket {
  /** FEC packet payload (XOR of group payloads, with header) */
  data: Uint8Array;
  /** Base sequence number of the protected group */
  baseSeq: number;
  /** Number of packets protected */
  protectedCount: number;
  /** Bitmask of protected packets (bit i = baseSeq + i) */
  protectionMask: number;
}

interface MediaPacketEntry {
  seq: number;
  payload: Uint8Array;
  timestamp: number;
}

export interface FecStats {
  fecPacketsSent: number;
  fecPacketsReceived: number;
  packetsRecoveredByFec: number;
  unrecoverableGroups: number;
}

/**
 * XOR-based FEC Encoder.
 * Accumulates media packets in groups and generates one FEC packet per group.
 *
 * The FEC packet format (simplified from RFC 5109):
 *  [2 bytes: base seq] [2 bytes: protection mask] [2 bytes: length recovery]
 *  [4 bytes: timestamp recovery] [N bytes: XOR'd payload]
 */
export class FecEncoder {
  groupSize: number;
  fecPayloadType: number;

  private _currentGroup: MediaPacketEntry[];
  stats: FecStats;

  constructor(options: FecEncoderOptions = {}) {
    this.groupSize = options.groupSize ?? 5;
    this.fecPayloadType = options.fecPayloadType ?? 127;
    this._currentGroup = [];
    this.stats = {
      fecPacketsSent: 0,
      fecPacketsReceived: 0,
      packetsRecoveredByFec: 0,
      unrecoverableGroups: 0,
    };
  }

  /**
   * Add a media packet. Returns a FEC packet if the group is complete.
   */
  addPacket(seq: number, payload: Uint8Array,
            timestamp: number): FecPacket | null {
    this._currentGroup.push({seq, payload, timestamp});

    if (this._currentGroup.length >= this.groupSize) {
      const fec = this._generateFecPacket();
      this._currentGroup = [];
      this.stats.fecPacketsSent++;
      return fec;
    }

    return null;
  }

  /**
   * Force-flush the current group (e.g., on keyframe boundary).
   */
  flush(): FecPacket | null {
    if (this._currentGroup.length < 2) {
      this._currentGroup = [];
      return null;
    }
    const fec = this._generateFecPacket();
    this._currentGroup = [];
    this.stats.fecPacketsSent++;
    return fec;
  }

  private _generateFecPacket(): FecPacket {
    const group = this._currentGroup;
    const baseSeq = group[0].seq;

    // Find max payload length in group
    let maxLen = 0;
    for (const pkt of group) {
      if (pkt.payload.length > maxLen) maxLen = pkt.payload.length;
    }

    // XOR all payloads
    const xorPayload = new Uint8Array(maxLen);
    let timestampXor = 0;
    let lengthXor = 0;

    for (const pkt of group) {
      // XOR payload bytes
      for (let i = 0; i < pkt.payload.length; i++) {
        xorPayload[i] ^= pkt.payload[i];
      }
      timestampXor ^= pkt.timestamp;
      lengthXor ^= pkt.payload.length;
    }

    // Build protection mask
    let mask = 0;
    for (let i = 0; i < group.length; i++) {
      mask |= (1 << i);
    }

    // FEC header: baseSeq(2) + mask(2) + lengthRecovery(2) + tsRecovery(4)
    const headerSize = 10;
    const fecData = new Uint8Array(headerSize + maxLen);
    const view = new DataView(fecData.buffer);

    view.setUint16(0, baseSeq & 0xFFFF);
    view.setUint16(2, mask & 0xFFFF);
    view.setUint16(4, lengthXor & 0xFFFF);
    view.setUint32(6, timestampXor >>> 0);
    fecData.set(xorPayload, headerSize);

    return {
      data: fecData,
      baseSeq,
      protectedCount: group.length,
      protectionMask: mask,
    };
  }
}

/**
 * XOR-based FEC Decoder.
 * Stores received media packets and FEC packets, attempts recovery
 * when exactly one media packet in a group is missing.
 */
export class FecDecoder {
  private _mediaPackets: Map<number, MediaPacketEntry>;
  private _pendingFec: FecPacket[];
  private _maxBufferSize: number;

  stats: FecStats;

  constructor() {
    this._mediaPackets = new Map();
    this._pendingFec = [];
    this._maxBufferSize = 500;
    this.stats = {
      fecPacketsSent: 0,
      fecPacketsReceived: 0,
      packetsRecoveredByFec: 0,
      unrecoverableGroups: 0,
    };
  }

  /**
   * Register a received media packet.
   */
  addMediaPacket(seq: number, payload: Uint8Array, timestamp: number): void {
    this._mediaPackets.set(seq, {seq, payload, timestamp});
    if (this._mediaPackets.size > this._maxBufferSize) {
      this._pruneBuffer();
    }
  }

  /**
   * Process a received FEC packet. Returns recovered packets (if any).
   */
  addFecPacket(data: Uint8Array):
      Array<{seq: number; payload: Uint8Array; timestamp: number}> {
    const fec = this._parseFecPacket(data);
    if (!fec) return [];

    this.stats.fecPacketsReceived++;

    // Try immediate recovery
    const recovered = this._attemptRecovery(fec);
    if (recovered) return [recovered];

    // Store for later (a missing packet may arrive making recovery possible)
    this._pendingFec.push(fec);
    if (this._pendingFec.length > 50) {
      this._pendingFec.shift();
    }

    return [];
  }

  /**
   * Try to recover packets using stored FEC after a new media packet arrives.
   */
  tryRecovery():
      Array<{seq: number; payload: Uint8Array; timestamp: number}> {
    const recovered: Array<{seq: number; payload: Uint8Array;
                            timestamp: number}> = [];

    const remaining: FecPacket[] = [];
    for (const fec of this._pendingFec) {
      const result = this._attemptRecovery(fec);
      if (result) {
        recovered.push(result);
      } else {
        remaining.push(fec);
      }
    }
    this._pendingFec = remaining;

    return recovered;
  }

  private _attemptRecovery(fec: FecPacket):
      {seq: number; payload: Uint8Array; timestamp: number} | null {
    const baseSeq = fec.baseSeq;
    const mask = fec.protectionMask;

    // Find which packets are missing
    let missingSeq = -1;
    let missingCount = 0;

    for (let i = 0; i < 16; i++) {
      if (!(mask & (1 << i))) continue;
      const seq = (baseSeq + i) & 0xFFFF;
      if (!this._mediaPackets.has(seq)) {
        missingSeq = seq;
        missingCount++;
      }
    }

    // Can only recover if exactly one is missing
    if (missingCount !== 1) {
      if (missingCount > 1) {
        // Check if all protected packets are too old (unrecoverable)
        const oldest = (baseSeq + fec.protectedCount - 1) & 0xFFFF;
        const newest =
            this._mediaPackets.size > 0
              ? Math.max(...Array.from(this._mediaPackets.keys()))
              : 0;
        const diff = ((newest - oldest) & 0xFFFF);
        if (diff > 100) {
          this.stats.unrecoverableGroups++;
          return null;
        }
      }
      return null;
    }

    // Recover by XOR'ing FEC with all received protected packets
    const fecView = new DataView(
        fec.data.buffer, fec.data.byteOffset, fec.data.byteLength);
    const headerSize = 10;
    const fecPayload = fec.data.slice(headerSize);
    const lengthRecovery = fecView.getUint16(4);
    const tsRecovery = fecView.getUint32(6);

    let recoveredLength = lengthRecovery;
    let recoveredTimestamp = tsRecovery;
    const recoveredPayload = new Uint8Array(fecPayload.length);
    recoveredPayload.set(fecPayload);

    for (let i = 0; i < 16; i++) {
      if (!(mask & (1 << i))) continue;
      const seq = (baseSeq + i) & 0xFFFF;
      if (seq === missingSeq) continue;

      const pkt = this._mediaPackets.get(seq)!;
      // XOR payload
      for (let j = 0; j < pkt.payload.length; j++) {
        recoveredPayload[j] ^= pkt.payload[j];
      }
      recoveredLength ^= pkt.payload.length;
      recoveredTimestamp ^= pkt.timestamp;
    }

    this.stats.packetsRecoveredByFec++;

    // Trim to recovered length
    const finalPayload = recoveredPayload.slice(0, recoveredLength & 0xFFFF);

    // Store recovered packet for future FEC groups
    this._mediaPackets.set(missingSeq, {
      seq: missingSeq,
      payload: finalPayload,
      timestamp: recoveredTimestamp >>> 0,
    });

    return {
      seq: missingSeq,
      payload: finalPayload,
      timestamp: recoveredTimestamp >>> 0,
    };
  }

  private _parseFecPacket(data: Uint8Array): FecPacket | null {
    if (data.length < 10) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const baseSeq = view.getUint16(0);
    const mask = view.getUint16(2);

    let count = 0;
    for (let i = 0; i < 16; i++) {
      if (mask & (1 << i)) count++;
    }

    return {
      data,
      baseSeq,
      protectedCount: count,
      protectionMask: mask,
    };
  }

  private _pruneBuffer(): void {
    // Keep only the most recent packets
    const keys = Array.from(this._mediaPackets.keys());
    keys.sort((a, b) => {
      let diff = (a - b) & 0xFFFF;
      if (diff > 0x7FFF) diff -= 0x10000;
      return diff;
    });
    const toRemove = keys.slice(0, keys.length - this._maxBufferSize + 100);
    for (const key of toRemove) {
      this._mediaPackets.delete(key);
    }
  }
}
