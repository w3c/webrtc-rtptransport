// Video Jitter Buffer
// Frame-level buffer that collects RTP packets into complete video frames.

export interface VideoPacket {
  sequenceNumber: number;
  timestamp: number;
  payload: Uint8Array;
  isStart: boolean;
  isEnd: boolean;
  isKeyframe: boolean;
}

export interface PendingFrame {
  timestamp: number;
  packets: Map<number, Uint8Array>;
  hasFirst: boolean;
  hasLast: boolean;
  firstSeq: number;
  lastSeq: number;
  insertTimeMs: number;
  isKeyframe: boolean;
}

export interface VideoJitterBufferStats {
  framesReceived: number;
  framesEmitted: number;
  framesDropped: number;
  incompleteFrames: number;
}

export interface VideoJitterBufferOptions {
  onFrameReady: (
    frame: Uint8Array,
    isKeyframe: boolean,
    timestamp: number,
  ) => void;
  maxFrames?: number;
  maxWaitMs?: number;
}

/**
 * Video jitter buffer - collects packets into complete frames.
 */
export class VideoJitterBuffer {
  onFrameReady: VideoJitterBufferOptions['onFrameReady'];
  maxFrames: number;
  maxWaitMs: number;
  frames: Map<number, PendingFrame>;
  lastEmittedTimestamp: number;
  timerId: number | null;
  stats: VideoJitterBufferStats;

  constructor({
    onFrameReady,
    maxFrames = 30,
    maxWaitMs = 200,
  }: VideoJitterBufferOptions) {
    this.onFrameReady = onFrameReady;
    this.maxFrames = maxFrames;
    this.maxWaitMs = maxWaitMs;

    this.frames = new Map();
    this.lastEmittedTimestamp = -1;
    this.timerId = null;

    this.stats = {
      framesReceived: 0,
      framesEmitted: 0,
      framesDropped: 0,
      incompleteFrames: 0,
    };
  }

  /**
   * Start the frame completion checker.
   */
  start(): void {
    this.timerId = setInterval((): void => this._checkTimeouts(), 10);
  }

  /**
   * Stop the buffer.
   */
  stop(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Insert a depacketized video packet.
   */
  insert(packet: VideoPacket): void {
    const {
      sequenceNumber,
      timestamp,
      payload,
      isStart,
      isEnd,
      isKeyframe,
    } = packet;

    if (!this.frames.has(timestamp)) {
      this.frames.set(timestamp, {
        timestamp,
        packets: new Map(),
        hasFirst: false,
        hasLast: false,
        firstSeq: sequenceNumber,
        lastSeq: sequenceNumber,
        insertTimeMs: performance.now(),
        isKeyframe: false,
      });
      this.stats.framesReceived++;
    }

    const frame = this.frames.get(timestamp);
    if (!frame) {
      return;
    }
    frame.packets.set(sequenceNumber, payload);

    if (isStart) {
      frame.hasFirst = true;
      frame.firstSeq = sequenceNumber;
    }
    if (isEnd) {
      frame.hasLast = true;
      frame.lastSeq = sequenceNumber;
    }
    if (isKeyframe) {
      frame.isKeyframe = true;
    }

    // Update seq range
    const seqDiff = this._seqDiff(sequenceNumber, frame.firstSeq);
    if (seqDiff < 0) {
      frame.firstSeq = sequenceNumber;
    }
    const seqDiff2 = this._seqDiff(sequenceNumber, frame.lastSeq);
    if (seqDiff2 > 0) {
      frame.lastSeq = sequenceNumber;
    }

    // Check if frame is complete
    if (this._isFrameComplete(frame)) {
      this._emitFrame(frame);
    }

    // Prune old frames
    this._prune();
  }

  /**
   * Get the number of missing packets for a frame.
   */
  getFrameCompleteness(timestamp: number):
      {missing: number, total: number} | null {
    const frame = this.frames.get(timestamp);
    if (!frame || !frame.hasFirst || !frame.hasLast) {
      return null;
    }

    const total = this._seqDiff(frame.lastSeq, frame.firstSeq) + 1;
    const received = frame.packets.size;
    return {missing: total - received, total};
  }

  _isFrameComplete(frame: PendingFrame): boolean {
    if (!frame.hasFirst || !frame.hasLast) {
      return false;
    }

    // Check if we have all packets from firstSeq to lastSeq
    const expected = this._seqDiff(frame.lastSeq, frame.firstSeq) + 1;
    return frame.packets.size >= expected;
  }

  _emitFrame(frame: PendingFrame): void {
    this.frames.delete(frame.timestamp);

    // Sort packets by sequence number and concatenate
    const sorted = [...frame.packets.entries()]
                       .sort(
                           (a: [number, Uint8Array],
                            b: [number, Uint8Array]): number =>
                               this._seqDiff(a[0], b[0]))
                       .map(([, data]: [number, Uint8Array]) => data);

    const totalSize =
        sorted.reduce((sum: number, data: Uint8Array): number => {
          return sum + data.length;
        }, 0);
    const assembled = new Uint8Array(totalSize);
    let offset = 0;
    for (const data of sorted) {
      assembled.set(data, offset);
      offset += data.length;
    }

    this.lastEmittedTimestamp = frame.timestamp;
    this.stats.framesEmitted++;
    this.onFrameReady(assembled, frame.isKeyframe, frame.timestamp);
  }

  _checkTimeouts(): void {
    const now = performance.now();
    for (const [timestamp, frame] of this.frames) {
      if (now - frame.insertTimeMs > this.maxWaitMs) {
        // Frame timed out - emit if partially complete, else drop
        if (frame.packets.size > 0 && frame.hasFirst) {
          this.stats.incompleteFrames++;
          // Don't emit incomplete frames (decoder can't handle them)
        }
        this.frames.delete(timestamp);
        this.stats.framesDropped++;
      }
    }
  }

  _prune(): void {
    while (this.frames.size > this.maxFrames) {
      const oldest = this.frames.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.frames.delete(oldest);
      this.stats.framesDropped++;
    }
  }

  _seqDiff(a: number, b: number): number {
    let diff = (a - b) & 0xFFFF;
    if (diff > 0x7FFF) {
      diff -= 0x10000;
    }
    return diff;
  }
}
