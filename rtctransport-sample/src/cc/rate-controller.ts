// Rate Controller
// Allocates the estimated bandwidth between audio and video streams.

export interface RateControllerOptions {
  audioMinBps?: number;
  audioMaxBps?: number;
  videoMinBps?: number;
}

export interface RateAllocation {
  total: number;
  audio: number;
  video: number;
}

/**
 * Rate controller that manages target bitrate allocation.
 */
export class RateController {
  audioMinBps: number;
  audioMaxBps: number;
  videoMinBps: number;
  totalBudgetBps: number;
  audioBitrateBps: number;
  videoBitrateBps: number;
  hasVideo: boolean;
  audioPriority: boolean;

  constructor({
    audioMinBps = 24000,
    audioMaxBps = 64000,
    videoMinBps = 100000,
  }: RateControllerOptions = {}) {
    this.audioMinBps = audioMinBps;
    this.audioMaxBps = audioMaxBps;
    this.videoMinBps = videoMinBps;

    this.totalBudgetBps = 300000;
    this.audioBitrateBps = 32000;
    this.videoBitrateBps = 268000;

    this.hasVideo = false;
    this.audioPriority = true;
  }

  setTotalBudget(totalBps: number): void {
    this.totalBudgetBps = totalBps;
    this._reallocate();
  }

  setVideoEnabled(enabled: boolean): void {
    this.hasVideo = enabled;
    this._reallocate();
  }

  getAudioBitrate(): number {
    return this.audioBitrateBps;
  }

  getVideoBitrate(): number {
    return this.videoBitrateBps;
  }

  getAllocation(): RateAllocation {
    return {
      total: this.totalBudgetBps,
      audio: this.audioBitrateBps,
      video: this.videoBitrateBps,
    };
  }

  private _reallocate(): void {
    let remaining = this.totalBudgetBps;

    this.audioBitrateBps =
        Math.min(this.audioMaxBps, Math.max(this.audioMinBps, remaining * 0.1));
    remaining -= this.audioBitrateBps;

    if (this.hasVideo) {
      this.videoBitrateBps = Math.max(this.videoMinBps, remaining);
    } else {
      this.videoBitrateBps = 0;
      this.audioBitrateBps = Math.min(this.audioMaxBps, this.totalBudgetBps);
    }
  }
}
