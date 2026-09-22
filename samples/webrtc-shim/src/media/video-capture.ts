// Video Capture + WebCodecs Encoding
// Captures video from getUserMedia and encodes with VP8 via WebCodecs.

export interface VideoCaptureOptions {
  onFrame: (
    encodedFrame: Uint8Array,
    isKeyframe: boolean,
    timestamp: number,
  ) => void;
  /** Called with estimated QP value (0-51 scale) for each encoded frame. */
  onQp?: (qp: number) => void;
  width?: number;
  height?: number;
  frameRate?: number;
  bitrate?: number;
  /** WebCodecs codec string (e.g. 'vp8', 'vp09.00.10.08', 'avc1.42E01F') */
  codec?: string;
}

/**
 * Video capture and encoding using WebCodecs VideoEncoder.
 */
export class VideoCapture {
  onFrame: VideoCaptureOptions['onFrame'];
  onQp: VideoCaptureOptions['onQp'];
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
  codec: string;
  stream: MediaStream | null;
  encoder: VideoEncoder | null;
  running: boolean;
  frameCount: number;
  keyframeInterval: number;

  constructor({
    onFrame,
    onQp,
    width = 640,
    height = 480,
    frameRate = 30,
    bitrate = 500000,
    codec = 'vp8',
  }: VideoCaptureOptions) {
    this.onFrame = onFrame;
    this.onQp = onQp;
    this.width = width;
    this.height = height;
    this.codec = codec;
    this.frameRate = frameRate;
    this.bitrate = bitrate;

    this.stream = null;
    this.encoder = null;
    this.running = false;
    this.frameCount = 0;
    this.keyframeInterval = 60;  // Request keyframe every 60 frames (2s at 30fps)
  }

  /**
   * Start video capture and encoding.
   */
  async start(): Promise<MediaStream> {
    if (typeof VideoEncoder === 'undefined') {
      throw new Error('WebCodecs VideoEncoder not available');
    }

    // Check codec support before proceeding
    const isAvc = this.codec.startsWith('avc');
    const isHevc = this.codec.startsWith('hev') || this.codec.startsWith('hvc');

    const encoderConfig: VideoEncoderConfig = {
      codec: this.codec,
      width: this.width,
      height: this.height,
      bitrate: this.bitrate,
      framerate: this.frameRate,
      latencyMode: 'realtime',
      ...(isAvc ? { avc: { format: 'annexb' } } : {}),
      ...(isHevc ? { hevc: { format: 'annexb' } } : {}),
    };

    const support = await VideoEncoder.isConfigSupported(encoderConfig);
    if (!support.supported) {
      throw new Error(
        `Codec "${this.codec}" is not supported for encoding on this platform`);
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: {ideal: this.width},
        height: {ideal: this.height},
        frameRate: {ideal: this.frameRate},
      },
    });

    this.running = true;
    this.encoder = new VideoEncoder({
      output: (chunk: EncodedVideoChunk, metadata: unknown): void => {
        const buffer = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buffer);
        const isKeyframe = chunk.type === 'key';
        this.onFrame(buffer, isKeyframe, chunk.timestamp);

        if (this.onQp) {
          const targetBytes = this.bitrate / (8 * this.frameRate);
          const ratio = chunk.byteLength / Math.max(1, targetBytes);
          const estimatedQp = Math.max(1, Math.min(51,
            Math.round(30 - 15 * Math.log2(Math.max(0.01, ratio)))));
          this.onQp(estimatedQp);
        }
      },
      error: (err: Error): void => {
        console.error('VideoEncoder error:', err);
      },
    });

    this.encoder.configure(encoderConfig);

    // Use MediaStreamTrackProcessor for frame access
    const track = this.stream.getVideoTracks()[0];
    if (typeof MediaStreamTrackProcessor !== 'undefined') {
      const processor = new MediaStreamTrackProcessor({track});
      const reader =
          (processor.readable as ReadableStream<VideoFrame>).getReader();

      const readLoop = async (): Promise<void> => {
        while (this.running) {
          const {value: frame, done} = await reader.read();
          if (done || !this.running) {
            if (frame) {
              frame.close();
            }
            break;
          }

          const keyFrame = (this.frameCount % this.keyframeInterval) === 0;
          this.encoder?.encode(frame, {keyFrame});
          this.frameCount++;
          frame.close();
        }
        reader.releaseLock();
      };

      void readLoop().catch((err: Error): void => {
        if (this.running) {
          console.error('Video read loop error:', err);
        }
      });
    }

    return this.stream;
  }

  /**
   * Update encoder bitrate.
   */
  setBitrate(bitrate: number): void {
    this.bitrate = bitrate;
    if (this.encoder && this.encoder.state === 'configured') {
      // Reconfigure is needed to change bitrate in some implementations
      this.encoder.configure({
        codec: this.codec,
        width: this.width,
        height: this.height,
        bitrate,
        framerate: this.frameRate,
        latencyMode: 'realtime',
      });
    }
  }

  /**
   * Force a keyframe on next encode.
   */
  requestKeyframe(): void {
    this.frameCount = 0;  // Next frame will be keyframe
  }

  /**
   * Stop capture.
   */
  stop(): void {
    this.running = false;
    if (this.encoder) {
      this.encoder.close();
      this.encoder = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track: MediaStreamTrack): void => {
        track.stop();
      });
      this.stream = null;
    }
  }

  /**
   * Get the raw MediaStream.
   */
  getStream(): MediaStream | null {
    return this.stream;
  }
}
