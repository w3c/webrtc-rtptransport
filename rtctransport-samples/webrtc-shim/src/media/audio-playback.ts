// Audio Playback via Web Audio API
// Decodes and plays received Opus audio frames.

export interface AudioPlaybackOptions {
  sampleRate?: number;
  channelCount?: number;
}

export interface AudioPlaybackStats {
  nextPlayTime: number;
  frameDuration: number;
}

/**
 * Audio playback using WebCodecs AudioDecoder or raw PCM via AudioContext.
 */
export class AudioPlayback {
  sampleRate: number;
  channelCount: number;
  audioContext: AudioContext | null;
  decoder: AudioDecoder | null;
  nextPlayTime: number;
  running: boolean;
  frameDuration: number;

  constructor(
      {sampleRate = 48000, channelCount = 1}: AudioPlaybackOptions = {}) {
    this.sampleRate = sampleRate;
    this.channelCount = channelCount;
    this.audioContext = null;
    this.decoder = null;
    this.nextPlayTime = 0;
    this.running = false;
    this.frameDuration = 0.02;  // 20ms
  }

  /**
   * Start the audio playback system.
   */
  async start(): Promise<void> {
    this.audioContext = new AudioContext({sampleRate: this.sampleRate});
    this.nextPlayTime = 0;
    this.running = true;

    // Use WebCodecs AudioDecoder if available
    if (typeof AudioDecoder !== 'undefined') {
      this.decoder = new AudioDecoder({
        output: (frame: AudioData): void => {
          this._playAudioData(frame);
          frame.close();
        },
        error: (err: Error): void => {
          console.error('AudioDecoder error:', err);
        },
      });

      this.decoder.configure({
        codec: 'opus',
        sampleRate: this.sampleRate,
        numberOfChannels: this.channelCount,
      });
    }
  }

  /**
   * Feed an encoded Opus frame for decoding and playback.
   */
  playFrame(opusFrame: Uint8Array, timestamp: number): void {
    if (!this.running) {
      return;
    }

    if (this.decoder) {
      // WebCodecs path
      const chunk = new EncodedAudioChunk({
        type: 'key',
        timestamp,  // microseconds
        data: opusFrame,
      });
      this.decoder.decode(chunk);
    } else {
      // Fallback: assume raw PCM Int16
      this._playRawPcm(opusFrame);
    }
  }

  /**
   * Stop playback.
   */
  stop(): void {
    this.running = false;
    if (this.decoder) {
      this.decoder.close();
      this.decoder = null;
    }
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
  }

  /**
   * Resume AudioContext (required after user interaction).
   */
  async resume(): Promise<void> {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  _playAudioData(audioData: AudioData): void {
    const audioContext = this.audioContext;
    if (!audioContext) {
      return;
    }

    const numberOfFrames = audioData.numberOfFrames;
    const buffer = audioContext.createBuffer(
        audioData.numberOfChannels,
        numberOfFrames,
        audioData.sampleRate);

    // Copy data from AudioData to AudioBuffer
    for (let ch = 0; ch < audioData.numberOfChannels; ch++) {
      const channelData = new Float32Array(numberOfFrames);
      audioData.copyTo(channelData, {planeIndex: ch, format: 'f32-planar'});
      buffer.copyToChannel(channelData, ch);
    }

    this._scheduleBuffer(buffer);
  }

  _playRawPcm(data: Uint8Array): void {
    const audioContext = this.audioContext;
    if (!audioContext) {
      return;
    }

    const pcm16 = new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    const samples = pcm16.length;
    const buffer = audioContext.createBuffer(1, samples, this.sampleRate);
    const channelData = buffer.getChannelData(0);

    for (let i = 0; i < samples; i++) {
      channelData[i] = pcm16[i] / 32768;
    }

    this._scheduleBuffer(buffer);
  }

  _scheduleBuffer(buffer: AudioBuffer): void {
    const audioContext = this.audioContext;
    if (!audioContext) {
      return;
    }

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    const now = audioContext.currentTime;
    if (this.nextPlayTime < now) {
      this.nextPlayTime = now + 0.01;  // 10ms buffer
    }

    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;
  }
}
