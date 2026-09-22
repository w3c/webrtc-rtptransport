// Audio Capture via getUserMedia
// Captures microphone audio and provides encoded Opus frames.

export interface AudioCaptureOptions {
  onFrame: (encodedFrame: Uint8Array) => void;
  sampleRate?: number;
  channelCount?: number;
  /** WebCodecs audio codec string (e.g. 'opus', 'mp4a.40.2' for AAC-LC) */
  codec?: string;
}

/**
 * Audio capture using MediaStreamTrackProcessor (Insertable Streams)
 * or MediaRecorder for Opus encoding.
 */
export class AudioCapture {
  onFrame: AudioCaptureOptions['onFrame'];
  sampleRate: number;
  channelCount: number;
  codec: string;
  stream: MediaStream | null;
  encoder: AudioEncoder | null;
  running: boolean;
  audioContext: AudioContext | null;

  constructor({
    onFrame,
    sampleRate = 48000,
    channelCount = 1,
    codec = 'opus',
  }: AudioCaptureOptions) {
    this.onFrame = onFrame;
    this.sampleRate = sampleRate;
    this.channelCount = channelCount;
    this.codec = codec;
    this.stream = null;
    this.encoder = null;
    this.running = false;
    this.audioContext = null;
  }

  /**
   * Start capturing audio.
   * Uses WebCodecs AudioEncoder if available, falls back to ScriptProcessor.
   */
  async start(): Promise<MediaStream> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: this.sampleRate,
        channelCount: this.channelCount,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.running = true;

    // Use WebCodecs AudioEncoder for Opus encoding
    if (typeof AudioEncoder !== 'undefined') {
      await this._startWithWebCodecs();
    } else {
      // Fallback: Use AudioContext + ScriptProcessor (lower quality)
      this._startWithAudioContext();
    }

    return this.stream;
  }

  /**
   * Stop capturing audio.
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

    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
  }

  /**
   * Get the raw MediaStream (for local preview).
   */
  getStream(): MediaStream | null {
    return this.stream;
  }

  async _startWithWebCodecs(): Promise<void> {
    if (!this.stream) {
      return;
    }

    const track = this.stream.getAudioTracks()[0];

    this.encoder = new AudioEncoder({
      output: (chunk: EncodedAudioChunk): void => {
        // Convert EncodedAudioChunk to Uint8Array
        const buffer = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buffer);
        this.onFrame(buffer);
      },
      error: (err: Error): void => {
        console.error('AudioEncoder error:', err);
      },
    });

    this.encoder.configure({
      codec: this.codec,
      sampleRate: this.sampleRate,
      numberOfChannels: this.channelCount,
      bitrate: 32000,
      ...(this.codec === 'opus' ? { opus: { frameDuration: 20000 } } : {}),
    });

    // Use MediaStreamTrackProcessor to get raw audio data
    if (typeof MediaStreamTrackProcessor !== 'undefined') {
      const processor = new MediaStreamTrackProcessor({track});
      const reader = (processor.readable as ReadableStream<AudioData>).getReader();

      const readLoop = async (): Promise<void> => {
        while (this.running) {
          const {value: frame, done} = await reader.read();
          if (done || !this.running) {
            break;
          }
          this.encoder?.encode(frame);
          frame.close();
        }
        reader.releaseLock();
      };

      void readLoop().catch((err: Error): void => {
        if (this.running) {
          console.error('Audio read loop error:', err);
        }
      });
    }
  }

  _startWithAudioContext(): void {
    if (!this.stream) {
      return;
    }

    this.audioContext = new AudioContext({sampleRate: this.sampleRate});
    const source = this.audioContext.createMediaStreamSource(this.stream);

    // Use AudioWorklet if available, otherwise ScriptProcessor
    const bufferSize = 960;  // 20ms at 48kHz
    const processor =
        this.audioContext.createScriptProcessor(bufferSize, 1, 1);

    processor.onaudioprocess = (event: AudioProcessingEvent): void => {
      if (!this.running) {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      // Convert Float32 PCM to 16-bit PCM
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        pcm16[i] = Math.max(-32768, Math.min(32767, Math.floor(input[i] * 32767)));
      }
      // In Phase 1 without WebCodecs, send raw PCM (lossy but functional for testing)
      this.onFrame(new Uint8Array(pcm16.buffer));
    };

    source.connect(processor);
    processor.connect(this.audioContext.destination);
  }
}
