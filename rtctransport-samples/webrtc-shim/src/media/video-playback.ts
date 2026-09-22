// Video Playback - WebCodecs VideoDecoder + Canvas rendering

export interface VideoPlaybackOptions {
  target: HTMLCanvasElement | HTMLVideoElement;
  codec?: string;
}

/**
 * Video decoder and renderer using WebCodecs.
 */
export class VideoPlayback {
  target: HTMLCanvasElement | HTMLVideoElement;
  codec: string;
  decoder: VideoDecoder | null;
  running: boolean;
  ctx: CanvasRenderingContext2D | null;
  _offscreen: OffscreenCanvas | null;
  _offscreenCtx: OffscreenCanvasRenderingContext2D | null;

  constructor({target, codec = 'vp8'}: VideoPlaybackOptions) {
    this.target = target;
    this.codec = codec;
    this.decoder = null;
    this.running = false;
    this.ctx = null;
    this._offscreen = null;
    this._offscreenCtx = null;

    if (target instanceof HTMLCanvasElement) {
      this.ctx = target.getContext('2d');
    }
  }

  /**
   * Start the decoder.
   */
  async start(): Promise<void> {
    if (typeof VideoDecoder === 'undefined') {
      throw new Error('WebCodecs VideoDecoder not available');
    }

    const decoderConfig: VideoDecoderConfig = {
      codec: this.codec,
    };

    const support = await VideoDecoder.isConfigSupported(decoderConfig);
    if (!support.supported) {
      throw new Error(
        `Codec "${this.codec}" is not supported for decoding on this platform`);
    }

    this.running = true;
    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame): void => {
        this._renderFrame(frame);
        frame.close();
      },
      error: (err: Error): void => {
        console.error('VideoDecoder error:', err);
      },
    });

    this.decoder.configure(decoderConfig);
  }

  /**
   * Decode a video frame.
   */
  decode(data: Uint8Array, isKeyframe: boolean, timestamp: number): void {
    if (!this.decoder || !this.running) {
      return;
    }

    const chunk = new EncodedVideoChunk({
      type: isKeyframe ? 'key' : 'delta',
      timestamp,
      data,
    });

    this.decoder.decode(chunk);
  }

  /**
   * Stop the decoder.
   */
  stop(): void {
    this.running = false;
    if (this.decoder) {
      this.decoder.close();
      this.decoder = null;
    }
  }

  _renderFrame(frame: VideoFrame): void {
    if (this.ctx) {
      // Canvas rendering
      this.ctx.drawImage(frame, 0, 0, this.target.width, this.target.height);
    } else if (this.target instanceof HTMLVideoElement) {
      // For video element, we'd need to use MediaStreamTrackGenerator
      // This is a simplified approach using canvas offscreen
      if (!this._offscreen) {
        this._offscreen =
            new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
        this._offscreenCtx = this._offscreen.getContext('2d');
      }
      this._offscreenCtx!.drawImage(frame, 0, 0);
    }
  }
}
