// RtcPeerConnection Shim (Proxy backend)
//
// A W3C `RTCPeerConnection`-shaped facade backed by the RtcTransport RTP/RTCP
// JS engine (RtcTransportAdapter, RtpSession, packetizers, jitter buffer, and
// WebCodecs encode/decode).
//
// PHASE 1 — audio-only outbound (Opus) over a proven RtcTransport interop path.
// PHASE 2 — bidirectional audio: inbound RTP is reordered, decoded and
//   resynthesized into a MediaStreamTrack via MediaStreamTrackGenerator,
//   surfaced through `ontrack`.
// PHASE 3 (this file) — video + real codec negotiation:
//   - createOffer advertises the full supported codec lists (audio: Opus,
//     video: VP8 then H.264) with default payload types.
//   - setRemoteDescription intersects the peer's codecs against ours (respecting
//     our preference order) and adopts the *remote* payload types, so send
//     streams, packetizers and inbound PT matching are all dynamic rather than
//     hardcoded.
//   - Outbound video encodes the local track with WebCodecs, packetizes with the
//     negotiated codec's RTP format, and paces onto the transport. Inbound PLI
//     forces a keyframe.
//   - Inbound video depacketizes, gates on the first keyframe (requesting one
//     via PLI otherwise), decodes with WebCodecs and resynthesizes a video
//     MediaStreamTrack, surfaced through a second `ontrack`.
//
// Later phases fill in the rest:
//   Phase 4 — spec-shaped getStats()
//   Phase 5 — renegotiation + full compatibility

import type { RTCPeerConnectionLike, CallPreferences } from './types';
import {
  RtcTransportAdapter,
  type LocalTransportParams,
} from '../transport/rtc-transport-adapter';
import { RtpSession, type RtpSendStream } from '../rtp/rtp-session';
import { parseRtpPacket } from '../rtp/rtp-packet';
import { parseRtcpCompound } from '../rtp/rtcp-packet';
import { JitterBuffer } from '../media/jitter-buffer';
import { KeyframeRequestHandler } from '../recovery/keyframe-request';
import { NackHandler, parseNackPacket } from '../recovery/nack-handler';
import { FecEncoder, FecDecoder } from '../recovery/fec';
import {
  createCongestionController,
  type CongestionController,
  type CongestionControlAlgorithm,
} from '../cc/index';
import {
  AUDIO_CODECS,
  VIDEO_CODECS,
  type CodecInfo,
  Vp8Packetizer, Vp8Depacketizer,
  Vp9Packetizer, Vp9Depacketizer,
  H264Packetizer, H264Depacketizer,
  HevcPacketizer, HevcDepacketizer,
  Av1Packetizer, Av1Depacketizer,
  OpusPacketizer, OpusDepacketizer,
} from '../codec/index';
import {
  buildSdp,
  AUDIO_HEADER_EXTENSIONS,
  VIDEO_HEADER_EXTENSIONS,
  VIDEO_RTCP_FEEDBACK,
} from '../sdp/sdp-builder';
import {
  parseSdp,
  parseFullSdp,
  parseFingerprint,
  getLocalSetupRole,
  formatFingerprint,
  type ParsedMediaSection,
} from '../sdp/sdp-parser';

// Codecs we can send/receive, in default preference order. A per-instance list
// (reordered by the user's CallPreferences) is built in the constructor.
const DEFAULT_AUDIO: CodecInfo[] = [AUDIO_CODECS.opus];
const DEFAULT_VIDEO: CodecInfo[] = [
  VIDEO_CODECS.vp8, VIDEO_CODECS.vp9, VIDEO_CODECS.h264, VIDEO_CODECS.hevc, VIDEO_CODECS.av1,
];

/** Move the codec whose name matches `preferred` to the front of `list`. */
function orderByPreference(list: CodecInfo[], preferred?: string): CodecInfo[] {
  if (!preferred) return list.slice();
  const idx = list.findIndex((c) => c.name === preferred);
  if (idx <= 0) return list.slice();
  const copy = list.slice();
  const [chosen] = copy.splice(idx, 1);
  copy.unshift(chosen);
  return copy;
}

// 90 kHz / 30 fps video RTP timestamp increment.
const VIDEO_TS_INCREMENT = 3000;
const VIDEO_KEYFRAME_INTERVAL = 60;

// Error recovery tuning.
// Payload type carrying XOR FEC repair packets (shim-to-shim only).
const FEC_PAYLOAD_TYPE = 127;
// Media packets protected per FEC group (one repair packet each).
const FEC_GROUP_SIZE = 5;
// A forward sequence gap larger than this is treated as burst loss and
// escalated from NACK to a FIR keyframe request.
const FIR_GAP_THRESHOLD = 16;

// Video encoder target-bitrate bounds driven by congestion control.
const VIDEO_INITIAL_BPS = 800_000;
const VIDEO_MIN_BPS = 100_000;
const VIDEO_MAX_BPS = 2_500_000;
// How often the CC target is applied to the video encoder.
const CC_APPLY_INTERVAL_MS = 1000;

interface NegotiatedCodec {
  info: CodecInfo;
  pt: number;
}

type VideoPacketizerLike = {
  packetize(frame: Uint8Array, isKeyframe: boolean, tsIncrement: number): Uint8Array[];
};
type VideoDepacketizerLike = {
  depacketize(pkt: unknown): { frame: Uint8Array; timestamp: number; isKeyframe: boolean } | null;
};

function randomSsrc(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

/** Map an SDP video codec name (e.g. "VP8", "H265") to one of our CodecInfos. */
function matchVideoCodec(sdpName: string): CodecInfo | null {
  switch (sdpName.toUpperCase()) {
    case 'VP8': return VIDEO_CODECS.vp8;
    case 'VP9': return VIDEO_CODECS.vp9;
    case 'H264': return VIDEO_CODECS.h264;
    case 'H265':
    case 'HEVC': return VIDEO_CODECS.hevc;
    case 'AV1':
    case 'AV1X': return VIDEO_CODECS.av1;
    default: return null;
  }
}

/** Map an SDP audio codec name to one of our CodecInfos. */
function matchAudioCodec(sdpName: string): CodecInfo | null {
  switch (sdpName.toLowerCase()) {
    case 'opus': return AUDIO_CODECS.opus;
    case 'pcmu': return AUDIO_CODECS.pcmu;
    case 'pcma': return AUDIO_CODECS.pcma;
    default: return null;
  }
}

function createVideoPacketizer(name: string, stream: RtpSendStream): VideoPacketizerLike {
  switch (name) {
    case 'vp8': return new Vp8Packetizer(stream);
    case 'vp9': return new Vp9Packetizer(stream);
    case 'h264': return new H264Packetizer(stream);
    case 'hevc': return new HevcPacketizer(stream);
    case 'av1': return new Av1Packetizer(stream);
    default: return new Vp8Packetizer(stream);
  }
}

function createVideoDepacketizer(name: string): VideoDepacketizerLike {
  switch (name) {
    case 'vp8': return new Vp8Depacketizer();
    case 'vp9': return new Vp9Depacketizer();
    case 'h264': return new H264Depacketizer();
    case 'hevc': return new HevcDepacketizer();
    case 'av1': return new Av1Depacketizer();
    default: return new Vp8Depacketizer();
  }
}

/**
 * Split a compound RTCP buffer into its individual sub-packets, returning each
 * as a `{pt, fmt, data}` slice. Used to route NACK / PLI / FIR feedback.
 */
function splitRtcpCompound(buf: Uint8Array): Array<{ pt: number; fmt: number; data: Uint8Array }> {
  const out: Array<{ pt: number; fmt: number; data: Uint8Array }> = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const fmt = buf[off] & 0x1f;
    const pt = buf[off + 1];
    const words = (buf[off + 2] << 8) | buf[off + 3];
    const bytes = (words + 1) * 4;
    if (bytes <= 0 || off + bytes > buf.length) break;
    out.push({ pt, fmt, data: buf.subarray(off, off + bytes) });
    off += bytes;
  }
  return out;
}

export class RtcPeerConnectionShim extends EventTarget implements RTCPeerConnectionLike {
  // --- State (spec defaults) ---
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';

  // --- Event handler properties ---
  onicecandidate: ((this: RTCPeerConnectionLike, ev: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((this: RTCPeerConnectionLike, ev: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: ((this: RTCPeerConnectionLike, ev: Event) => void) | null = null;
  oniceconnectionstatechange: ((this: RTCPeerConnectionLike, ev: Event) => void) | null = null;
  onnegotiationneeded: ((this: RTCPeerConnectionLike, ev: Event) => void) | null = null;

  private readonly _config?: RTCConfiguration;

  // --- Engine / transport state ---
  private _transport: RtcTransportAdapter | null = null;
  private _localParams: LocalTransportParams | null = null;
  private _rtpSession: RtpSession | null = null;

  private _isOfferer = false;
  private _remoteIceUfrag: string | null = null;
  private _remoteIcePwd: string | null = null;
  private _remoteSections: ParsedMediaSection[] = [];
  private _writable = false;
  private _negotiationComplete = false;

  // --- Negotiated codecs ---
  private _negAudio: NegotiatedCodec | null = null;
  private _negVideo: NegotiatedCodec | null = null;

  // --- Local tracks / SSRCs ---
  private _localAudioTrack: MediaStreamTrack | null = null;
  private _localVideoTrack: MediaStreamTrack | null = null;
  private readonly _localAudioSsrc = randomSsrc();
  private readonly _localVideoSsrc = randomSsrc();

  // --- Outbound pipelines ---
  private _audioSendStarted = false;
  private _videoSendStarted = false;
  private _audioSender: RTCRtpSender | null = null;
  private _videoSender: RTCRtpSender | null = null;
  private _remoteDtlsApplied = false;
  private _localDtlsSetup: string | null = null;
  private _audioSendStream: RtpSendStream | null = null;
  private _audioPacketizer: OpusPacketizer | null = null;
  private _audioEncoder: AudioEncoder | null = null;
  private _videoSendStream: RtpSendStream | null = null;
  private _videoPacketizer: VideoPacketizerLike | null = null;
  private _videoEncoder: VideoEncoder | null = null;
  private _videoFrameCount = 0;
  private _forceVideoKeyframe = false;

  // --- Inbound audio ---
  private _audioDepacketizer: OpusDepacketizer | null = null;
  private _audioDecoder: AudioDecoder | null = null;
  private _jitterBuffer: JitterBuffer | null = null;
  private _audioGenerator: MediaStreamTrackGenerator | null = null;
  private _audioWriter: WritableStreamDefaultWriter<AudioData> | null = null;
  private _inboundAudioStarted = false;
  private _audioTsBaseMicros: number | null = null;
  private _lastAudioTsMicros = 0;

  // --- Inbound video ---
  private _videoDepacketizer: VideoDepacketizerLike | null = null;
  private _videoDecoder: VideoDecoder | null = null;
  private _videoGenerator: MediaStreamTrackGenerator | null = null;
  private _videoWriter: WritableStreamDefaultWriter<VideoFrame> | null = null;
  private _inboundVideoStarted = false;
  private _decoderGotKeyframe = false;
  private _videoKeyframeHandler: KeyframeRequestHandler | null = null;
  private _remoteVideoSsrc = 0;
  private _videoTsBaseMicros: number | null = null;
  private _lastVideoTsMicros = 0;

  // --- Error recovery (NACK / FIR / FEC) ---
  // A single NACK handler drives both directions: the send buffer answers
  // incoming NACKs (retransmission) and the receive-side gap tracker generates
  // outgoing NACKs. NACK and FIR are standard RTCP and interoperate with native
  // WebRTC; FEC is a shim-to-shim XOR scheme gated on `_fecEnabled`.
  private _videoNack: NackHandler | null = null;
  private _fecEnabled = false;
  private _fecPt = FEC_PAYLOAD_TYPE;
  private _videoFecEncoder: FecEncoder | null = null;
  private _videoFecDecoder: FecDecoder | null = null;
  private _fecSendStream: RtpSendStream | null = null;

  private _remoteStream: MediaStream = new MediaStream();

  // --- Stats counters (Phase 4) ---
  private _audioPacketsSent = 0;
  private _audioBytesSent = 0;
  private _videoPacketsSent = 0;
  private _videoBytesSent = 0;
  private _audioPacketsReceived = 0;
  private _audioBytesReceived = 0;
  private _videoPacketsReceived = 0;
  private _videoBytesReceived = 0;
  private _videoFramesEncoded = 0;
  private _videoFramesDecoded = 0;
  private _videoRecvPacketsLost = 0;
  private _videoRecvMaxSeq = -1;
  private _remoteAudioSsrc = 0;
  private readonly _startedAtMs = Date.now();

  // --- Preferences / congestion control ---
  private readonly _supportedAudio: CodecInfo[];
  private readonly _supportedVideo: CodecInfo[];
  private readonly _ccAlgorithm: CongestionControlAlgorithm;
  private _cc: CongestionController | null = null;
  private _ccTimer: number | null = null;
  private _lastFractionLost = 0;
  private _lastJitterMs = 0;
  private _videoTargetBps = VIDEO_INITIAL_BPS;
  private _videoEncoderConfig: VideoEncoderConfig | null = null;

  constructor(config?: RTCConfiguration, prefs?: CallPreferences) {
    super();
    this._config = config;
    this._supportedAudio = orderByPreference(DEFAULT_AUDIO, prefs?.audioCodec);
    this._supportedVideo = orderByPreference(DEFAULT_VIDEO, prefs?.videoCodec);
    this._ccAlgorithm = prefs?.ccAlgorithm ?? 'gcc';
    this._cc = createCongestionController(this._ccAlgorithm, {
      initialBps: VIDEO_INITIAL_BPS,
      minBps: VIDEO_MIN_BPS,
      maxBps: VIDEO_MAX_BPS,
    });
  }

  // --- Media ---
  addTrack(track: MediaStreamTrack, ..._streams: MediaStream[]): RTCRtpSender {
    if (track.kind === 'audio' && !this._localAudioTrack) {
      this._localAudioTrack = track;
      this._audioSender ??= this._makeSender('audio');
      this._maybeStartSending();
      return this._audioSender;
    } else if (track.kind === 'video' && !this._localVideoTrack) {
      this._localVideoTrack = track;
      this._videoSender ??= this._makeSender('video');
      this._maybeStartSending();
      return this._videoSender;
    }
    return { track } as unknown as RTCRtpSender;
  }
  getSenders(): RTCRtpSender[] {
    const senders: RTCRtpSender[] = [];
    if (this._audioSender) senders.push(this._audioSender);
    if (this._videoSender) senders.push(this._videoSender);
    return senders;
  }
  getReceivers(): RTCRtpReceiver[] {
    const receivers: RTCRtpReceiver[] = [];
    if (this._audioGenerator) receivers.push({ track: this._audioGenerator } as unknown as RTCRtpReceiver);
    if (this._videoGenerator) receivers.push({ track: this._videoGenerator } as unknown as RTCRtpReceiver);
    return receivers;
  }

  /**
   * Build a stable sender object exposing `replaceTrack`, so the app can pause
   * (replaceTrack(null)) and resume (replaceTrack(track)) a track mid-call and
   * then renegotiate — the same code path it uses against a native sender.
   */
  private _makeSender(kind: 'audio' | 'video'): RTCRtpSender {
    const shim = this;
    return {
      get track() {
        return kind === 'audio' ? shim._localAudioTrack : shim._localVideoTrack;
      },
      replaceTrack(t: MediaStreamTrack | null): Promise<void> {
        return shim._replaceTrack(kind, t);
      },
    } as unknown as RTCRtpSender;
  }

  private async _replaceTrack(kind: 'audio' | 'video', track: MediaStreamTrack | null): Promise<void> {
    if (kind === 'video') {
      if (track) {
        this._localVideoTrack = track;
        this._maybeStartSending();
      } else {
        this._videoSendStarted = false;
        if (this._videoEncoder) {
          try { this._videoEncoder.close(); } catch { /* already closed */ }
          this._videoEncoder = null;
        }
        this._localVideoTrack = null;
      }
    } else {
      if (track) {
        this._localAudioTrack = track;
        this._maybeStartSending();
      } else {
        this._audioSendStarted = false;
        if (this._audioEncoder) {
          try { this._audioEncoder.close(); } catch { /* already closed */ }
          this._audioEncoder = null;
        }
        this._localAudioTrack = null;
      }
    }
  }

  // --- Signaling / negotiation ---
  async createOffer(_options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this._isOfferer = true;
    await this._ensureTransport(true);
    // Initial offer advertises actpass; once the DTLS role is established it must
    // be kept stable across renegotiations, or the peer rejects the SDP with a
    // "Failed to set SSL role" error.
    const setup = this._localDtlsSetup ?? 'actpass';
    const sdp = this._buildSdp(setup, /* isOffer */ true);
    return { type: 'offer', sdp };
  }

  async createAnswer(_options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit> {
    const remoteSetup = this.remoteDescription
      ? parseSdp(this.remoteDescription.sdp).setup
      : 'actpass';
    // Reuse the established role on renegotiation; only derive it the first time.
    const localSetup = this._localDtlsSetup ?? getLocalSetupRole(remoteSetup);
    const sdp = this._buildSdp(localSetup, /* isOffer */ false);
    return { type: 'answer', sdp };
  }

  async setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void> {
    if (!description || !description.sdp) return;
    this.localDescription = this._toDescription(description.type ?? 'offer', description.sdp);
    this.signalingState = description.type === 'answer' ? 'stable' : 'have-local-offer';
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    const sdp = description.sdp ?? '';
    const remote = parseSdp(sdp);
    const full = parseFullSdp(sdp);
    this._remoteIceUfrag = remote.iceUfrag;
    this._remoteIcePwd = remote.icePwd;
    this._remoteSections = full.mediaSections;

    if (description.type === 'offer') {
      // We are the answerer — bring up the transport before applying params.
      this._isOfferer = false;
      await this._ensureTransport(false);
    }

    // Intersect codecs against ours, adopting the remote payload types.
    this._negotiateCodecs(full.mediaSections);

    // DTLS + ICE are established once; a renegotiation must not re-apply them
    // (the transport is already up). Trickle candidates still flow through
    // addIceCandidate.
    if (!this._remoteDtlsApplied) {
      const localSetup = getLocalSetupRole(remote.setup);
      this._localDtlsSetup = localSetup;
      this._transport!.setRemoteDtlsParameters({
        sslRole: localSetup === 'active' ? 'client' : 'server',
        fingerprintDigestAlgorithm: remote.fingerprintAlgorithm,
        fingerprint: parseFingerprint(remote.fingerprint).buffer as ArrayBuffer,
      });

      for (const candidate of remote.candidates) {
        this._transport!.addRemoteCandidate({
          address: candidate.address,
          port: candidate.port,
          usernameFragment: this._remoteIceUfrag,
          password: this._remoteIcePwd,
          type: candidate.type,
        });
      }
      this._remoteDtlsApplied = true;
    }

    this.remoteDescription = this._toDescription(description.type ?? 'offer', sdp);
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';

    this._negotiationComplete = true;
    this._maybeStartSending();
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void> {
    if (!candidate || !candidate.candidate) return;
    if (!this._transport || !this._remoteIceUfrag || !this._remoteIcePwd) return;
    const parsed = parseCandidateString(candidate.candidate);
    if (!parsed) return;
    this._transport.addRemoteCandidate({
      address: parsed.address,
      port: parsed.port,
      usernameFragment: this._remoteIceUfrag,
      password: this._remoteIcePwd,
      type: parsed.type,
    });
  }

  // --- Stats & lifecycle ---
  getStats(_selector?: MediaStreamTrack | null): Promise<RTCStatsReport> {
    // A spec-shaped RTCStatsReport. A JS Map satisfies the report's iteration
    // surface (forEach/get/values/entries), so the app can read the same
    // `outbound-rtp` / `inbound-rtp` / `transport` entries it reads natively.
    const report = new Map<string, unknown>();
    const timestamp = Date.now();

    if (this._negAudio && this._localAudioTrack) {
      report.set('outbound-rtp-audio', {
        type: 'outbound-rtp',
        id: 'outbound-rtp-audio',
        timestamp,
        kind: 'audio',
        mediaType: 'audio',
        ssrc: this._localAudioSsrc,
        packetsSent: this._audioPacketsSent,
        bytesSent: this._audioBytesSent,
      });
    }
    if (this._negVideo && this._localVideoTrack) {
      report.set('outbound-rtp-video', {
        type: 'outbound-rtp',
        id: 'outbound-rtp-video',
        timestamp,
        kind: 'video',
        mediaType: 'video',
        ssrc: this._localVideoSsrc,
        packetsSent: this._videoPacketsSent,
        bytesSent: this._videoBytesSent,
        framesEncoded: this._videoFramesEncoded,
        targetBitrate: this._videoTargetBps,
        fractionLost: this._lastFractionLost,
        jitter: this._lastJitterMs / 1000,
        ccAlgorithm: this._ccAlgorithm,
        nackCount: this._videoNack?.stats.nacksReceived ?? 0,
        retransmittedPacketsSent: this._videoNack?.stats.retransmissionsSent ?? 0,
        fecPacketsSent: this._videoFecEncoder?.stats.fecPacketsSent ?? 0,
        fecEnabled: this._fecEnabled,
      });
    }
    if (this._audioPacketsReceived > 0) {
      report.set('inbound-rtp-audio', {
        type: 'inbound-rtp',
        id: 'inbound-rtp-audio',
        timestamp,
        kind: 'audio',
        mediaType: 'audio',
        ssrc: this._remoteAudioSsrc,
        packetsReceived: this._audioPacketsReceived,
        bytesReceived: this._audioBytesReceived,
      });
    }
    if (this._videoPacketsReceived > 0) {
      report.set('inbound-rtp-video', {
        type: 'inbound-rtp',
        id: 'inbound-rtp-video',
        timestamp,
        kind: 'video',
        mediaType: 'video',
        ssrc: this._remoteVideoSsrc,
        packetsReceived: this._videoPacketsReceived,
        bytesReceived: this._videoBytesReceived,
        framesDecoded: this._videoFramesDecoded,
        packetsLost: this._videoRecvPacketsLost,
        nackCount: this._videoNack?.stats.nacksSent ?? 0,
        pliCount: this._videoKeyframeHandler?.stats.pliSent ?? 0,
        firCount: this._videoKeyframeHandler?.stats.firSent ?? 0,
        packetsRecoveredByNack: this._videoNack?.stats.packetsRecovered ?? 0,
        fecPacketsReceived: this._videoFecDecoder?.stats.fecPacketsReceived ?? 0,
        packetsRecoveredByFec: this._videoFecDecoder?.stats.packetsRecoveredByFec ?? 0,
      });
    }

    report.set('transport', {
      type: 'transport',
      id: 'transport',
      timestamp,
      bytesSent: this._audioBytesSent + this._videoBytesSent,
      bytesReceived: this._audioBytesReceived + this._videoBytesReceived,
      dtlsState: this._writable ? 'connected' : 'new',
      iceState: this.iceConnectionState,
      startedAtMs: this._startedAtMs,
      ccAlgorithm: this._ccAlgorithm,
      ccTargetBitrate: this._videoTargetBps,
      fractionLost: this._lastFractionLost,
      jitter: this._lastJitterMs / 1000,
    });

    return Promise.resolve(report as unknown as RTCStatsReport);
  }

  close(): void {
    this._audioSendStarted = false;
    this._videoSendStarted = false;
    this._inboundAudioStarted = false;
    this._inboundVideoStarted = false;
    this._stopCcLoop();

    for (const enc of [this._audioEncoder, this._videoEncoder]) {
      if (enc) { try { enc.close(); } catch { /* already closed */ } }
    }
    this._audioEncoder = null;
    this._videoEncoder = null;

    for (const dec of [this._audioDecoder, this._videoDecoder]) {
      if (dec) { try { dec.close(); } catch { /* already closed */ } }
    }
    this._audioDecoder = null;
    this._videoDecoder = null;

    if (this._jitterBuffer) { this._jitterBuffer.stop(); this._jitterBuffer = null; }

    for (const w of [this._audioWriter, this._videoWriter]) {
      if (w) { try { void w.close(); } catch { /* already closed */ } }
    }
    this._audioWriter = null;
    this._videoWriter = null;

    for (const g of [this._audioGenerator, this._videoGenerator]) {
      if (g) g.stop();
    }
    this._audioGenerator = null;
    this._videoGenerator = null;

    if (this._transport) { this._transport.close(); this._transport = null; }
    this._setConnectionState('closed');
    this.signalingState = 'closed';
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private async _ensureTransport(isOfferer: boolean): Promise<void> {
    if (this._transport) return;

    this._setConnectionState('connecting');
    this._setIceConnectionState('checking');

    const iceServers = (this._config?.iceServers ?? [])
      .map((s) => ({ urls: Array.isArray(s.urls) ? s.urls[0]! : s.urls! }));
    if (iceServers.length === 0) {
      iceServers.push({ urls: 'stun:stun.l.google.com:19302' });
    }

    this._transport = new RtcTransportAdapter({
      config: {
        name: 'proxy-transport',
        iceServers,
        iceControlling: isOfferer,
        wireProtocol: 'dtls-srtp',
      },
      onRtpReceived: (payload, receiveTime) => this._onRtpReceived(payload, receiveTime),
      onRtcpReceived: (payload) => this._onRtcpReceived(payload),
      onIceCandidate: (candidate) => this._emitIceCandidate(candidate),
      onWritable: () => this._onWritable(),
    });

    this._localParams = await this._transport.initialize();
    this._rtpSession = new RtpSession();
  }

  /**
   * Pick the agreed audio + video codec for each remote media section using our
   * preference order, adopting the *remote* payload type so both directions use
   * the same PT (Chrome echoes the offerer's PTs; an answerer must adopt them).
   */
  private _negotiateCodecs(sections: ParsedMediaSection[]): void {
    for (const section of sections) {
      if (section.type === 'audio' && !this._negAudio) {
        for (const pref of this._supportedAudio) {
          const remote = section.codecs.find(
            (c) => matchAudioCodec(c.codec) === pref);
          if (remote) { this._negAudio = { info: pref, pt: remote.payloadType }; break; }
        }
      } else if (section.type === 'video' && !this._negVideo) {
        for (const pref of this._supportedVideo) {
          const remote = section.codecs.find(
            (c) => matchVideoCodec(c.codec) === pref);
          if (remote) { this._negVideo = { info: pref, pt: remote.payloadType }; break; }
        }
        // Enable shim-to-shim FEC only when the peer also advertised it.
        if (section.fecPayloadType !== undefined) {
          this._fecEnabled = true;
          this._fecPt = section.fecPayloadType;
        }
      }
    }
  }

  private _buildSdp(setup: string, isOffer: boolean): string {
    const p = this._localParams!;
    const media = [];

    // Audio section.
    const audioCodecs = isOffer
      ? this._supportedAudio
      : (this._negAudio ? [withPt(this._negAudio)] : this._supportedAudio);
    media.push({
      type: 'audio' as const,
      mid: this._midFor('audio', '0'),
      direction: 'sendrecv' as const,
      ssrc: this._localAudioSsrc,
      codecs: audioCodecs,
      headerExtensions: AUDIO_HEADER_EXTENSIONS,
    });

    // Video section: always offer it; on answer, include it only if the remote
    // offered video and we negotiated a codec (keeps m-line sets aligned).
    const remoteHasVideo = this._remoteSections.some((s) => s.type === 'video');
    if (isOffer || (remoteHasVideo && this._negVideo)) {
      const videoCodecs = isOffer
        ? this._supportedVideo
        : [withPt(this._negVideo!)];
      media.push({
        type: 'video' as const,
        mid: this._midFor('video', '1'),
        direction: 'sendrecv' as const,
        ssrc: this._localVideoSsrc,
        codecs: videoCodecs,
        rtcpFeedback: VIDEO_RTCP_FEEDBACK,
        headerExtensions: VIDEO_HEADER_EXTENSIONS,
        fecPayloadType: this._fecPt,
      });
    }

    return buildSdp({
      session: {
        iceUfrag: p.iceUfrag,
        icePwd: p.icePassword,
        fingerprint: formatFingerprint(p.fingerprint),
        fingerprintAlgorithm: p.fingerprintAlgorithm,
        setup,
      },
      media,
    });
  }

  /** Mirror the remote section's mid when answering, else use a default. */
  private _midFor(type: 'audio' | 'video', fallback: string): string {
    const section = this._remoteSections.find((s) => s.type === type);
    return section?.mid ?? fallback;
  }

  private _emitIceCandidate(candidate: RtcTransportIceCandidate): void {
    const candidateStr =
      `candidate:1 1 udp 2130706431 ${candidate.address} ${candidate.port} ` +
      `typ ${candidate.type} generation 0 ufrag ${candidate.usernameFragment}`;
    const iceCandidate = new RTCIceCandidate({
      candidate: candidateStr,
      sdpMLineIndex: 0,
      sdpMid: this._midFor('audio', '0'),
      usernameFragment: candidate.usernameFragment,
    });
    const event = new RTCPeerConnectionIceEvent('icecandidate', { candidate: iceCandidate });
    this.onicecandidate?.call(this, event);
    this.dispatchEvent(event);
  }

  private _onWritable(): void {
    this._writable = true;
    this._setIceConnectionState('connected');
    this._setConnectionState('connected');
    this._maybeStartSending();
  }

  /**
   * Periodically apply the congestion controller's target bitrate to the video
   * encoder. This closes the rate-control loop: RTCP RR fraction-lost feeds the
   * controller (`_onRtcpReceived`), the controller lowers/raises its estimate,
   * and the encoder is reconfigured to match.
   */
  private _startCcLoop(): void {
    if (this._ccTimer !== null || !this._cc) return;
    this._ccTimer = setInterval(() => {
      if (!this._cc || !this._videoEncoder || !this._videoEncoderConfig) return;
      const target = Math.max(
        VIDEO_MIN_BPS, Math.min(VIDEO_MAX_BPS, Math.round(this._cc.getTargetBitrateBps())));
      // Only reconfigure on a meaningful change to avoid encoder churn.
      if (Math.abs(target - this._videoTargetBps) < 25_000) return;
      this._videoTargetBps = target;
      this._videoEncoderConfig = { ...this._videoEncoderConfig, bitrate: target };
      try {
        this._videoEncoder.configure(this._videoEncoderConfig);
      } catch (err) {
        console.warn('[proxy] encoder reconfigure failed:', (err as Error).message);
      }
    }, CC_APPLY_INTERVAL_MS) as unknown as number;
  }

  private _stopCcLoop(): void {
    if (this._ccTimer !== null) { clearInterval(this._ccTimer); this._ccTimer = null; }
  }

  /**
   * Lazily create the video NACK handler (both directions) and, when FEC was
   * negotiated shim-to-shim, the FEC encoder/decoder plus a dedicated repair
   * send stream on its own SSRC.
   */
  private _ensureRecovery(): void {
    if (!this._videoNack) {
      this._videoNack = new NackHandler({
        senderSsrc: this._localVideoSsrc,
        mediaSsrc: this._remoteVideoSsrc,
      });
    }
    if (this._fecEnabled && !this._videoFecEncoder) {
      this._videoFecEncoder = new FecEncoder({
        groupSize: FEC_GROUP_SIZE,
        fecPayloadType: this._fecPt,
      });
      this._videoFecDecoder = new FecDecoder();
      this._fecSendStream = this._rtpSession!.createSendStream({
        ssrc: (this._localVideoSsrc + 1) >>> 0,
        payloadType: this._fecPt,
        clockRate: 90000,
      });
    }
  }

  private _onRtcpReceived(payload: Uint8Array): void {
    // Route transport-feedback sub-packets: PLI/FIR force a fresh keyframe from
    // our encoder; NACK triggers retransmission of buffered packets.
    for (const sub of splitRtcpCompound(payload)) {
      if (sub.pt === 206 && (sub.fmt === 1 || sub.fmt === 4)) {
        // PLI (FMT=1) or FIR (FMT=4).
        this._forceVideoKeyframe = true;
      } else if (sub.pt === 205 && sub.fmt === 1 && this._videoNack) {
        // Generic NACK — resend any buffered packets we still hold.
        const retransmits = this._videoNack.handleIncomingNack(sub.data);
        for (const rtx of retransmits) this._transport?.send(rtx);
      }
    }
    // Receiver Reports carry the peer's view of the loss/jitter it sees from us.
    // Feed fraction-lost to the congestion controller (closed-loop rate control)
    // and record loss/jitter for stats + graphs.
    let packets;
    try {
      packets = parseRtcpCompound(payload);
    } catch {
      return;
    }
    const now = Date.now();
    for (const pkt of packets) {
      if (pkt.type !== 'RR' && pkt.type !== 'SR') continue;
      for (const block of pkt.reportBlocks) {
        const fractionLost = block.fractionLost / 256;
        this._lastFractionLost = fractionLost;
        // RFC 3550 interarrival jitter is in RTP timestamp units (video 90 kHz).
        this._lastJitterMs = block.jitter / 90;
        this._cc?.onRtcpFeedback(0, fractionLost, now);
      }
    }
  }

  /** Start outbound pipelines once the transport is writable and codecs agreed. */
  private _maybeStartSending(): void {
    if (!this._writable || !this._negotiationComplete || !this._rtpSession) return;

    if (this._localAudioTrack && this._negAudio && !this._audioSendStarted) {
      this._audioSendStarted = true;
      this._startSendingAudio();
    }
    if (this._localVideoTrack && this._negVideo && !this._videoSendStarted) {
      this._videoSendStarted = true;
      void this._startSendingVideo();
    }
  }

  private _startSendingAudio(): void {
    if (typeof AudioEncoder === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') {
      this._audioSendStarted = false;
      return;
    }
    const track = this._localAudioTrack!;
    const neg = this._negAudio!;

    // Reuse the send stream/packetizer across pause/resume so sequence numbers
    // and the SSRC stay continuous for the receiver.
    if (!this._audioSendStream) {
      this._audioSendStream = this._rtpSession!.createSendStream({
        payloadType: neg.pt,
        clockRate: neg.info.clockRate,
        ssrc: this._localAudioSsrc,
      });
      this._audioPacketizer = new OpusPacketizer(this._audioSendStream);
    }

    this._audioEncoder = new AudioEncoder({
      output: (chunk: EncodedAudioChunk) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        const packet = this._audioPacketizer!.packetize(buf);
        this._audioPacketsSent++;
        this._audioBytesSent += packet.length;
        this._transport?.send(packet);
      },
      error: (err: Error) => console.error('[proxy] AudioEncoder error:', err),
    });
    this._audioEncoder.configure({
      codec: 'opus',
      sampleRate: neg.info.clockRate,
      numberOfChannels: 1,
      bitrate: 32000,
      opus: { frameDuration: 20000 },
    });

    const processor = new MediaStreamTrackProcessor({ track });
    const reader = (processor.readable as ReadableStream<AudioData>).getReader();
    const pump = async (): Promise<void> => {
      while (this._audioSendStarted && this._localAudioTrack === track) {
        const { value: frame, done } = await reader.read();
        if (done || !this._audioSendStarted) { if (frame) frame.close(); break; }
        try { this._audioEncoder?.encode(frame); } finally { frame.close(); }
      }
      reader.releaseLock();
    };
    void pump().catch((err: Error) => {
      if (this._audioSendStarted) console.error('[proxy] audio pump error:', err);
    });
  }

  private async _startSendingVideo(): Promise<void> {
    if (typeof VideoEncoder === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') {
      this._videoSendStarted = false;
      return;
    }
    const track = this._localVideoTrack!;
    const neg = this._negVideo!;
    const settings = track.getSettings();
    const width = settings.width ?? 640;
    const height = settings.height ?? 480;
    const frameRate = settings.frameRate ?? 30;
    const codec = neg.info.webCodecsId ?? 'vp8';
    const isAvc = codec.startsWith('avc');
    const isHevc = codec.startsWith('hev') || codec.startsWith('hvc');

    const encoderConfig: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate: this._videoTargetBps,
      framerate: frameRate,
      latencyMode: 'realtime',
      ...(isAvc ? { avc: { format: 'annexb' } } : {}),
      ...(isHevc ? { hevc: { format: 'annexb' } } : {}),
    };
    this._videoEncoderConfig = encoderConfig;

    try {
      const support = await VideoEncoder.isConfigSupported(encoderConfig);
      if (!support.supported) {
        console.warn(`[proxy] video codec ${codec} unsupported for encoding; skipping video send`);
        this._videoSendStarted = false;
        return;
      }
    } catch {
      this._videoSendStarted = false;
      return;
    }

    if (!this._videoSendStream) {
      this._videoSendStream = this._rtpSession!.createSendStream({
        payloadType: neg.pt,
        clockRate: neg.info.clockRate,
        ssrc: this._localVideoSsrc,
      });
      this._videoPacketizer = createVideoPacketizer(neg.info.name, this._videoSendStream);
    }

    // Force the first frame after (re)start to be a keyframe so the peer's
    // decoder can lock on without waiting for the periodic keyframe.
    this._videoFrameCount = 0;
    this._forceVideoKeyframe = true;

    this._videoEncoder = new VideoEncoder({
      output: (chunk: EncodedVideoChunk) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        const isKeyframe = chunk.type === 'key';
        const packets = this._videoPacketizer!.packetize(buf, isKeyframe, VIDEO_TS_INCREMENT);
        this._ensureRecovery();
        for (const pkt of packets) {
          this._videoPacketsSent++;
          this._videoBytesSent += pkt.length;
          // Buffer for NACK-driven retransmission, keyed by RTP sequence number.
          const seq = (pkt[2] << 8) | pkt[3];
          this._videoNack?.bufferSentPacket(seq, pkt);
          this._transport?.send(pkt);
          // Protect the whole serialized RTP packet with XOR FEC (shim peers).
          if (this._fecEnabled && this._videoFecEncoder && this._fecSendStream) {
            const fec = this._videoFecEncoder.addPacket(seq, pkt, 0);
            if (fec) {
              const fecPkt = this._fecSendStream.createPacket(fec.data, 0, false);
              this._transport?.send(fecPkt);
            }
          }
        }
      },
      error: (err: Error) => console.error('[proxy] VideoEncoder error:', err),
    });
    this._videoEncoder.configure(encoderConfig);
    this._startCcLoop();

    const processor = new MediaStreamTrackProcessor({ track });
    const reader = (processor.readable as ReadableStream<VideoFrame>).getReader();
    const pump = async (): Promise<void> => {
      while (this._videoSendStarted && this._localVideoTrack === track) {
        const { value: frame, done } = await reader.read();
        if (done || !this._videoSendStarted) { if (frame) frame.close(); break; }
        try {
          const keyFrame =
            this._forceVideoKeyframe || (this._videoFrameCount % VIDEO_KEYFRAME_INTERVAL) === 0;
          this._forceVideoKeyframe = false;
          this._videoEncoder?.encode(frame, { keyFrame });
          this._videoFrameCount++;
          this._videoFramesEncoded++;
        } finally {
          frame.close();
        }
      }
      reader.releaseLock();
    };
    void pump().catch((err: Error) => {
      if (this._videoSendStarted) console.error('[proxy] video pump error:', err);
    });
  }

  private _onRtpReceived(payload: Uint8Array, receiveTime: number): void {
    let packet;
    try {
      packet = parseRtpPacket(payload);
    } catch {
      return;
    }
    const pt = packet.header.payloadType;

    if (this._fecEnabled && pt === this._fecPt) {
      // XOR FEC repair packet: try to recover a lost media packet.
      this._ensureRecovery();
      const recovered = this._videoFecDecoder?.addFecPacket(packet.payload) ?? [];
      this._handleRecoveredVideo(recovered);
      return;
    }

    if (this._negAudio && pt === this._negAudio.pt) {
      this._audioPacketsReceived++;
      this._audioBytesReceived += payload.length;
      this._remoteAudioSsrc = packet.header.ssrc;
      this._ensureInboundAudio();
      const opusFrame = this._audioDepacketizer!.depacketize(packet.payload);
      this._jitterBuffer!.insert({
        sequenceNumber: packet.header.sequenceNumber,
        timestamp: packet.header.timestamp,
        payload: opusFrame,
        receiveTime,
      });
    } else if (this._negVideo && pt === this._negVideo.pt) {
      this._videoPacketsReceived++;
      this._videoBytesReceived += payload.length;
      // Register the whole serialized packet with the FEC decoder so a later
      // repair packet can reconstruct it, then attempt recovery of any group
      // this packet just completed.
      if (this._fecEnabled && this._videoFecDecoder) {
        this._videoFecDecoder.addMediaPacket(packet.header.sequenceNumber, payload, 0);
        this._handleRecoveredVideo(this._videoFecDecoder.tryRecovery());
      }
      this._onVideoRtp(packet);
    }
  }

  /**
   * Re-inject FEC-recovered video packets as if they had arrived off the wire.
   */
  private _handleRecoveredVideo(
      recovered: Array<{ seq: number; payload: Uint8Array; timestamp: number }>): void {
    for (const r of recovered) {
      let pkt;
      try {
        pkt = parseRtpPacket(r.payload);
      } catch {
        continue;
      }
      if (this._negVideo && pkt.header.payloadType === this._negVideo.pt) {
        this._videoPacketsReceived++;
        this._videoBytesReceived += r.payload.length;
        this._onVideoRtp(pkt);
      }
    }
  }

  private _onVideoRtp(packet: ReturnType<typeof parseRtpPacket>): void {
    this._ensureInboundVideo();
    this._ensureRecovery();
    this._remoteVideoSsrc = packet.header.ssrc;
    if (this._videoKeyframeHandler) this._videoKeyframeHandler.mediaSsrc = packet.header.ssrc;
    if (this._videoNack) this._videoNack.mediaSsrc = packet.header.ssrc;

    const seq = packet.header.sequenceNumber;
    const gap = this._trackVideoLoss(seq);

    // NACK: on a detected gap, ask the sender to retransmit the missing seqs.
    if (this._videoNack && this._videoNack.onPacketReceived(seq)) {
      const nack = this._videoNack.generateNack();
      if (nack && this._transport) this._transport.send(nack);
    }
    // FIR: a large burst loss is unlikely to be repaired by NACK/FEC, so
    // escalate to a full-intra request (stronger than PLI).
    if (gap > FIR_GAP_THRESHOLD && this._videoKeyframeHandler && this._transport) {
      const fir = this._videoKeyframeHandler.generateFir();
      if (fir) this._transport.send(fir);
    }

    const result = this._videoDepacketizer!.depacketize(packet);
    if (!result) return;

    if (!this._decoderGotKeyframe) {
      if (!result.isKeyframe) {
        const pli = this._videoKeyframeHandler?.generatePli();
        if (pli && this._transport) this._transport.send(pli);
        return;
      }
      this._decoderGotKeyframe = true;
    }
    this._decodeInboundVideo(result.frame, result.isKeyframe, result.timestamp);
  }

  /**
   * Estimate receive-side packet loss from RTP sequence-number gaps (16-bit
   * wrapping). Forward jumps add the skipped count; a later-arriving packet
   * that fills a gap decrements the running estimate. Returns the number of
   * packets skipped by this arrival (0 for in-order/duplicate/reordered).
   */
  private _trackVideoLoss(seq: number): number {
    if (this._videoRecvMaxSeq < 0) {
      this._videoRecvMaxSeq = seq;
      return 0;
    }
    const diff = (seq - this._videoRecvMaxSeq) & 0xffff;
    if (diff === 0) return 0;                  // duplicate
    if (diff < 0x8000) {
      this._videoRecvPacketsLost += diff - 1;  // forward jump: (diff-1) missing
      this._videoRecvMaxSeq = seq;
      return diff - 1;
    }
    // Reordered / late packet arriving after a gap was counted.
    this._videoRecvPacketsLost = Math.max(0, this._videoRecvPacketsLost - 1);
    return 0;
  }

  private _ensureInboundAudio(): void {
    if (this._inboundAudioStarted) return;
    if (typeof MediaStreamTrackGenerator === 'undefined' || typeof AudioDecoder === 'undefined') {
      return;
    }
    this._inboundAudioStarted = true;
    const neg = this._negAudio!;

    this._audioGenerator = new MediaStreamTrackGenerator({ kind: 'audio' });
    this._audioWriter = this._audioGenerator.writable.getWriter();
    this._audioDepacketizer = new OpusDepacketizer();

    this._audioDecoder = new AudioDecoder({
      output: (audioData: AudioData) => {
        void this._audioWriter?.write(audioData).catch(() => audioData.close());
      },
      error: (err: Error) => console.error('[proxy] AudioDecoder error:', err),
    });
    this._audioDecoder.configure({
      codec: 'opus',
      sampleRate: neg.info.clockRate,
      numberOfChannels: 1,
    });

    this._jitterBuffer = new JitterBuffer({
      delayMs: 60,
      clockRate: neg.info.clockRate,
      onPlayoutReady: (buffered) => this._decodeInboundAudio(buffered.payload, buffered.timestamp),
    });
    this._jitterBuffer.start();

    this._emitTrack(this._audioGenerator);
  }

  private _ensureInboundVideo(): void {
    if (this._inboundVideoStarted) return;
    if (typeof MediaStreamTrackGenerator === 'undefined' || typeof VideoDecoder === 'undefined') {
      return;
    }
    this._inboundVideoStarted = true;
    const neg = this._negVideo!;

    this._videoGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
    this._videoWriter = this._videoGenerator.writable.getWriter();
    this._videoDepacketizer = createVideoDepacketizer(neg.info.name);
    this._videoKeyframeHandler = new KeyframeRequestHandler({
      senderSsrc: this._localVideoSsrc,
      mediaSsrc: this._remoteVideoSsrc,
    });

    this._videoDecoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        this._videoFramesDecoded++;
        void this._videoWriter?.write(frame).catch(() => frame.close());
      },
      error: (err: Error) => console.error('[proxy] VideoDecoder error:', err),
    });
    this._videoDecoder.configure({ codec: neg.info.webCodecsId ?? 'vp8' });

    this._emitTrack(this._videoGenerator);
  }

  private _decodeInboundAudio(opusFrame: Uint8Array, rtpTimestamp: number): void {
    if (!this._audioDecoder) return;
    const clock = this._negAudio!.info.clockRate;
    if (this._audioTsBaseMicros === null) {
      this._audioTsBaseMicros = (rtpTimestamp / clock) * 1e6;
    }
    let tsMicros = (rtpTimestamp / clock) * 1e6 - this._audioTsBaseMicros;
    if (tsMicros < this._lastAudioTsMicros) tsMicros = this._lastAudioTsMicros;
    this._lastAudioTsMicros = tsMicros;

    this._audioDecoder.decode(new EncodedAudioChunk({
      type: 'key',
      timestamp: Math.round(tsMicros),
      data: opusFrame,
    }));
  }

  private _decodeInboundVideo(frame: Uint8Array, isKeyframe: boolean, rtpTimestamp: number): void {
    if (!this._videoDecoder) return;
    const clock = this._negVideo!.info.clockRate;
    if (this._videoTsBaseMicros === null) {
      this._videoTsBaseMicros = (rtpTimestamp / clock) * 1e6;
    }
    let tsMicros = (rtpTimestamp / clock) * 1e6 - this._videoTsBaseMicros;
    if (tsMicros < this._lastVideoTsMicros) tsMicros = this._lastVideoTsMicros;
    this._lastVideoTsMicros = tsMicros;

    this._videoDecoder.decode(new EncodedVideoChunk({
      type: isKeyframe ? 'key' : 'delta',
      timestamp: Math.round(tsMicros),
      data: frame,
    }));
  }

  /** Surface a synthesized inbound track through `ontrack`. */
  private _emitTrack(track: MediaStreamTrack): void {
    this._remoteStream.addTrack(track);
    const ev = new Event('track');
    Object.assign(ev, {
      track,
      streams: [this._remoteStream],
      receiver: { track },
    });
    this.ontrack?.call(this, ev as unknown as RTCTrackEvent);
    this.dispatchEvent(ev);
  }

  private _setConnectionState(state: RTCPeerConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    const ev = new Event('connectionstatechange');
    this.onconnectionstatechange?.call(this, ev);
    this.dispatchEvent(ev);
  }

  private _setIceConnectionState(state: RTCIceConnectionState): void {
    if (this.iceConnectionState === state) return;
    this.iceConnectionState = state;
    const ev = new Event('iceconnectionstatechange');
    this.oniceconnectionstatechange?.call(this, ev);
    this.dispatchEvent(ev);
  }

  private _toDescription(type: RTCSdpType, sdp: string): RTCSessionDescription {
    return {
      type,
      sdp,
      toJSON() { return { type, sdp }; },
    } as unknown as RTCSessionDescription;
  }
}

/** Clone a CodecInfo overriding its payload type with the negotiated one. */
function withPt(neg: NegotiatedCodec): CodecInfo {
  return { ...neg.info, payloadType: neg.pt };
}

interface ParsedCandidate {
  address: string;
  port: number;
  type: string;
}

function parseCandidateString(candidateStr: string): ParsedCandidate | null {
  const s = candidateStr.startsWith('candidate:') ? candidateStr : `candidate:${candidateStr}`;
  const parts = s.split(' ');
  if (parts.length < 8) return null;
  const address = parts[4];
  const port = parseInt(parts[5], 10);
  const type = parts[7];
  if (!address || Number.isNaN(port)) return null;
  return { address, port, type };
}
