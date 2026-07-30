// Main Application Entry Point
// Audio + Video call using RtcTransport with selectable codecs via WebCodecs.

import { SignalingChannel } from './signaling';
import { CallStateMachine } from './call-state-machine';
import { RtcTransportAdapter } from './transport/rtc-transport-adapter';
import { RtpSession } from './rtp/rtp-session';
import { parseRtpPacket } from './rtp/rtp-packet';
import { parseRtcpCompound } from './rtp/rtcp-packet';
import {
  VIDEO_CODECS, AUDIO_CODECS, getSdpRtpmap,
  type VideoCodecName, type AudioCodecName, type CodecInfo,
  Vp8Packetizer, Vp8Depacketizer,
  Vp9Packetizer, Vp9Depacketizer,
  H264Packetizer, H264Depacketizer,
  HevcPacketizer, HevcDepacketizer,
  Av1Packetizer, Av1Depacketizer,
  OpusPacketizer, OpusDepacketizer,
  G711Packetizer, G711Depacketizer,
  AacPacketizer, AacDepacketizer,
} from './codec/index';
import { VideoCapture } from './media/video-capture';
import { VideoPlayback } from './media/video-playback';
import { AudioCapture } from './media/audio-capture';
import { AudioPlayback } from './media/audio-playback';
import { JitterBuffer } from './media/jitter-buffer';
import { parseSdp, parseFingerprint, getLocalSetupRole, formatFingerprint } from './sdp/sdp-parser';
import {
  createCongestionController,
  type CongestionController,
  type CongestionControlAlgorithm,
} from './cc/index';
import {
  NackHandler,
  KeyframeRequestHandler,
  FecEncoder,
  FecDecoder,
  parseNackPacket,
  isPliOrFir,
} from './recovery/index';
import type { RtpSendStream } from './rtp/rtp-session';

// UI elements
const roomInput = document.getElementById('roomInput') as HTMLInputElement;
const btnJoin = document.getElementById('btnJoin') as HTMLButtonElement;
const btnCall = document.getElementById('btnCall') as HTMLButtonElement;
const btnHangup = document.getElementById('btnHangup') as HTMLButtonElement;
const callStateEl = document.getElementById('callState') as HTMLElement;
const statsEl = document.getElementById('stats') as HTMLElement;
const logEl = document.getElementById('log') as HTMLElement;
const localVideo = document.getElementById('localVideo') as HTMLVideoElement;
const remoteVideo = document.getElementById('remoteVideo') as HTMLCanvasElement;
const videoCodecSelect = document.getElementById('videoCodec') as HTMLSelectElement;
const audioCodecSelect = document.getElementById('audioCodec') as HTMLSelectElement;
const resolutionSelect = document.getElementById('resolution') as HTMLSelectElement;
const btnToggleGraphs = document.getElementById('btnToggleGraphs') as HTMLButtonElement;
const graphsPanel = document.getElementById('graphsPanel') as HTMLElement;
const graphBitrate = document.getElementById('graphBitrate') as HTMLCanvasElement;
const graphQp = document.getElementById('graphQp') as HTMLCanvasElement;
const graphLoss = document.getElementById('graphLoss') as HTMLCanvasElement;
const graphJitter = document.getElementById('graphJitter') as HTMLCanvasElement;
const graphResolution = document.getElementById('graphResolution') as HTMLCanvasElement;
const graphFps = document.getElementById('graphFps') as HTMLCanvasElement;
const ccAlgorithmSelect = document.getElementById('ccAlgorithm') as HTMLSelectElement;

// Resolution presets
const RESOLUTIONS: Record<string, {width: number; height: number}> = {
  'qvga': {width: 320, height: 240},
  'vga': {width: 640, height: 480},
  'sd': {width: 854, height: 480},
  'hd': {width: 1280, height: 720},
};

// State
let signaling: SignalingChannel | null = null;
let callState: CallStateMachine | null = null;
let transport: RtcTransportAdapter | null = null;
let rtpSession: RtpSession | null = null;
// Video — packetizer/depacketizer are generic interfaces
let videoSendStream: RtpSendStream | null = null;
let videoPacketizer: {packetize(frame: Uint8Array, isKeyframe: boolean, tsIncrement: number): Uint8Array[]} | null = null;
let videoDepacketizer: {depacketize(pkt: any): {frame: Uint8Array; timestamp: number; isKeyframe: boolean} | null} | null = null;
let videoCapture: VideoCapture | null = null;
let videoPlayback: VideoPlayback | null = null;
// Audio
let audioSendStream: RtpSendStream | null = null;
let audioPacketizer: {packetize(frame: Uint8Array): Uint8Array} | null = null;
let audioDepacketizer: {depacketize(payload: Uint8Array): Uint8Array} | null = null;
let audioCapture: AudioCapture | null = null;
let audioPlayback: AudioPlayback | null = null;
let jitterBuffer: JitterBuffer | null = null;
// Active codec info
let activeVideoCodec: CodecInfo = VIDEO_CODECS.vp8;
let activeAudioCodec: CodecInfo = AUDIO_CODECS.opus;
let activeResolution = {width: 640, height: 480};
let activeCcAlgorithm: CongestionControlAlgorithm = 'simple';
let congestionController: CongestionController | null = null;
// Error recovery
let videoNackHandler: NackHandler | null = null;
let videoKeyframeHandler: KeyframeRequestHandler | null = null;
let videoFecEncoder: FecEncoder | null = null;
let videoFecDecoder: FecDecoder | null = null;
let nackTimer: number | null = null;
// Stats
let rtcpTimer: number | null = null;
let statsTimer: number | null = null;
let framesSent = 0;
let framesReceived = 0;
let packetsSent = 0;
let packetsReceived = 0;
let bytesSent = 0;
let bytesReceived = 0;
let audioPacketsSent = 0;
let audioPacketsReceived = 0;
let remoteIceUfrag: string | null = null;
let remoteIcePwd: string | null = null;
// Graph data (last 60 seconds)
let bitrateHistory: number[] = [];
let qpHistory: number[] = [];
let lossHistory: number[] = [];
let jitterHistory: number[] = [];
let resolutionHistory: number[] = [];
let fpsHistory: number[] = [];
let lastBytesReceived = 0;
let lastPacketsReceived = 0;
let lastPacketsLost = 0;
let lastQp = 0; // estimated QP from encoder output (frame size ratio)

// SSRCs
const LOCAL_VIDEO_SSRC = (Math.random() * 0xFFFFFFFF) >>> 0;
const LOCAL_AUDIO_SSRC = (Math.random() * 0xFFFFFFFF) >>> 0;

// Logging
const LOG_VERBOSE = false;

type LogLevel = 'info' | 'debug' | 'warn' | 'error' | 'success';

function log(message: string, level: LogLevel = 'info'): void {
  if (level === 'debug' && !LOG_VERBOSE) return;
  const entry = document.createElement('div');
  if (level === 'warn') entry.className = 'log-warn';
  else if (level === 'error') entry.className = 'log-error';
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[RtcT] ${message}`);
}

function updateCallState(state: string): void {
  callStateEl.textContent = state;
  callStateEl.className = `state ${state === 'connected' ? 'state-connected' : state === 'idle' || state === 'closed' ? 'state-idle' : 'state-connecting'}`;
}

// Initialize call state machine
function initCallState(): void {
  callState = new CallStateMachine({
    onStateChange: (newState, oldState) => {
      log(`Call state: ${oldState} → ${newState}`);
      updateCallState(newState);
      btnHangup.disabled = (newState === 'idle' || newState === 'closed');
      btnCall.disabled = (newState !== 'idle');
      // Disable settings during active call
      const inCall = newState !== 'idle' && newState !== 'closed';
      for (const id of ['videoCodec', 'audioCodec', 'ccAlgorithm', 'resolution']) {
        const el = document.getElementById(id) as HTMLSelectElement | null;
        if (el) el.disabled = inCall;
      }
    },
  });
}

// Build audio+video SDP offer/answer using selected codecs
interface BuildSdpParams {
  iceUfrag: string;
  icePwd: string;
  fingerprint: string;
  fingerprintAlgorithm: string;
  setup: string;
  audioSsrc: number;
  videoSsrc: number;
  videoCodec: CodecInfo;
  audioCodec: CodecInfo;
}

function buildSdpFmtp(codec: CodecInfo): string | null {
  if (codec.name === 'opus') {
    return `a=fmtp:${codec.payloadType} minptime=10;useinbandfec=1`;
  }
  if (codec.name === 'h264') {
    return `a=fmtp:${codec.payloadType} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42E01F`;
  }
  if (codec.name === 'aac') {
    return `a=fmtp:${codec.payloadType} streamtype=5;profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=1190`;
  }
  return null;
}

function buildSdp(params: BuildSdpParams): string {
  const {
    iceUfrag, icePwd, fingerprint, fingerprintAlgorithm, setup,
    audioSsrc, videoSsrc, videoCodec, audioCodec,
  } = params;

  const sessionId = Math.floor(Date.now() / 1000).toString();
  const lines: string[] = [
    'v=0',
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'a=msid-semantic: WMS local',
    // Audio m= section (mid=0)
    `m=audio 9 UDP/TLS/RTP/SAVPF ${audioCodec.payloadType}`,
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    `a=ice-ufrag:${iceUfrag}`,
    `a=ice-pwd:${icePwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:${fingerprintAlgorithm} ${fingerprint}`,
    `a=setup:${setup}`,
    'a=mid:0',
    'a=sendrecv',
    'a=rtcp-mux',
    `a=rtpmap:${getSdpRtpmap(audioCodec)}`,
  ];

  const audioFmtp = buildSdpFmtp(audioCodec);
  if (audioFmtp) lines.push(audioFmtp);

  lines.push(
    `a=ssrc:${audioSsrc} cname:rtctransport`,
    `a=ssrc:${audioSsrc} msid:local audio0`,
    // Video m= section (mid=1)
    `m=video 9 UDP/TLS/RTP/SAVPF ${videoCodec.payloadType}`,
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    `a=ice-ufrag:${iceUfrag}`,
    `a=ice-pwd:${icePwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:${fingerprintAlgorithm} ${fingerprint}`,
    `a=setup:${setup}`,
    'a=mid:1',
    'a=sendrecv',
    'a=rtcp-mux',
    'a=rtcp-rsize',
    `a=rtcp-fb:${videoCodec.payloadType} nack`,
    `a=rtcp-fb:${videoCodec.payloadType} nack pli`,
    `a=rtcp-fb:${videoCodec.payloadType} ccm fir`,
    `a=rtpmap:${getSdpRtpmap(videoCodec)}`,
  );

  const videoFmtp = buildSdpFmtp(videoCodec);
  if (videoFmtp) lines.push(videoFmtp);

  lines.push(
    `a=ssrc:${videoSsrc} cname:rtctransport`,
    `a=ssrc:${videoSsrc} msid:local video0`,
  );

  return lines.join('\r\n') + '\r\n';
}

interface ParsedCandidate {
  address: string;
  port: number;
  type: string;
}

function parseIceCandidateString(candidateStr: string): ParsedCandidate | null {
  if (!candidateStr || !candidateStr.startsWith('candidate:')) return null;
  const parts = candidateStr.split(' ');
  if (parts.length < 8) return null;

  const address = parts[4];
  const port = parseInt(parts[5], 10);
  const type = parts[7];

  return { address, port, type };
}

function addRemoteIceCandidate(candidate: { candidate?: string } | string): void {
  if (!transport || !remoteIceUfrag || !remoteIcePwd) {
    log(`Cannot add ICE candidate: transport=${!!transport}, ufrag=${!!remoteIceUfrag}`, 'warn');
    return;
  }

  const candidateStr = typeof candidate === 'string' ? candidate : (candidate.candidate || '');
  if (!candidateStr) return;

  const parsed = parseIceCandidateString(candidateStr);
  if (!parsed) {
    log(`Failed to parse ICE candidate: ${candidateStr.substring(0, 60)}`, 'warn');
    return;
  }

  try {
    transport.addRemoteCandidate({
      address: parsed.address,
      port: parsed.port,
      usernameFragment: remoteIceUfrag,
      password: remoteIcePwd,
      type: parsed.type,
    });
    log(`Added remote ICE candidate: ${parsed.address}:${parsed.port} (${parsed.type})`);
  } catch (err) {
    log(`Failed to add ICE candidate: ${(err as Error).message}`, 'error');
  }
}

// Create video packetizer/depacketizer for the selected codec
function createVideoPacketizer(stream: RtpSendStream, codec: VideoCodecName) {
  switch (codec) {
    case 'vp8': return new Vp8Packetizer(stream);
    case 'vp9': return new Vp9Packetizer(stream);
    case 'h264': return new H264Packetizer(stream);
    case 'hevc': return new HevcPacketizer(stream);
    case 'av1': return new Av1Packetizer(stream);
  }
}

function createVideoDepacketizer(codec: VideoCodecName) {
  switch (codec) {
    case 'vp8': return new Vp8Depacketizer();
    case 'vp9': return new Vp9Depacketizer();
    case 'h264': return new H264Depacketizer();
    case 'hevc': return new HevcDepacketizer();
    case 'av1': return new Av1Depacketizer();
  }
}

function createAudioPacketizer(stream: RtpSendStream, _codec: AudioCodecName) {
  switch (_codec) {
    case 'opus': return new OpusPacketizer(stream);
    case 'pcmu':
    case 'pcma': return new G711Packetizer(stream);
    case 'aac': return new AacPacketizer(stream);
  }
}

function createAudioDepacketizer(_codec: AudioCodecName) {
  switch (_codec) {
    case 'opus': return new OpusDepacketizer();
    case 'pcmu':
    case 'pcma': return new G711Depacketizer();
    case 'aac': return new AacDepacketizer();
  }
}

// Initialize RTP session for audio + video with selected codecs
function initRtpPipeline(): void {
  rtpSession = new RtpSession();

  videoSendStream = rtpSession.createSendStream({
    payloadType: activeVideoCodec.payloadType,
    clockRate: activeVideoCodec.clockRate,
    ssrc: LOCAL_VIDEO_SSRC,
  });
  videoPacketizer = createVideoPacketizer(videoSendStream, activeVideoCodec.name as VideoCodecName);
  videoDepacketizer = createVideoDepacketizer(activeVideoCodec.name as VideoCodecName);

  audioSendStream = rtpSession.createSendStream({
    payloadType: activeAudioCodec.payloadType,
    clockRate: activeAudioCodec.clockRate,
    ssrc: LOCAL_AUDIO_SSRC,
  });
  audioPacketizer = createAudioPacketizer(audioSendStream, activeAudioCodec.name as AudioCodecName);
  audioDepacketizer = createAudioDepacketizer(activeAudioCodec.name as AudioCodecName);

  // Initialize congestion controller
  congestionController = createCongestionController(activeCcAlgorithm, {
    initialBps: 300000,
    minBps: 30000,
    maxBps: 2000000,
  });
  log(`Congestion control: ${activeCcAlgorithm.toUpperCase()}`);
}

// Handle received RTP packets (audio + video)
let decoderGotKeyframe = false;

function onRtpReceived(data: Uint8Array, receiveTime: number): void {
  try {
    const rtpPacket = parseRtpPacket(data);
    packetsReceived++;
    bytesReceived += data.length;
    if (packetsReceived <= 3 || packetsReceived % 100 === 0) {
      log(`RTP recv #${packetsReceived}: ssrc=${rtpPacket.header.ssrc}, seq=${rtpPacket.header.sequenceNumber}, pt=${rtpPacket.header.payloadType}, len=${data.length}`, 'debug');
    }

    const pt = rtpPacket.header.payloadType;

    if (pt === activeVideoCodec.payloadType) {
      const seq = rtpPacket.header.sequenceNumber;

      // NACK: detect gaps and request retransmission
      if (videoNackHandler) {
        if (videoNackHandler.mediaSsrc === 0) {
          videoNackHandler.mediaSsrc = rtpPacket.header.ssrc;
        }
        videoNackHandler.onPacketReceived(seq);
      }
      // Update keyframe handler's mediaSsrc
      if (videoKeyframeHandler && videoKeyframeHandler.mediaSsrc === 0) {
        videoKeyframeHandler.mediaSsrc = rtpPacket.header.ssrc;
      }
      // FEC: register media packet for potential recovery
      if (videoFecDecoder) {
        videoFecDecoder.addMediaPacket(
            seq, rtpPacket.payload, rtpPacket.header.timestamp);
        // Try recovery with newly arrived packet
        const recovered = videoFecDecoder.tryRecovery();
        for (const pkt of recovered) {
          log(`FEC recovered seq=${pkt.seq}`, 'debug');
        }
      }

      const receiveStream = rtpSession!.getOrCreateReceiveStream(
        rtpPacket.header.ssrc,
        activeVideoCodec.clockRate
      );
      receiveStream.processPacket(rtpPacket.header, receiveTime);

      const result = videoDepacketizer!.depacketize(rtpPacket);
      if (result) {
        if (!decoderGotKeyframe) {
          if (!result.isKeyframe) {
            // No keyframe yet — request one
            if (videoKeyframeHandler) {
              const pli = videoKeyframeHandler.generatePli();
              if (pli && transport) transport.send(pli);
            }
            return;
          }
          decoderGotKeyframe = true;
          log(`First video keyframe received! ts=${result.timestamp}, size=${result.frame.length}`);
        }
        framesReceived++;
        if (framesReceived <= 5 || framesReceived % 30 === 0) {
          log(`Decoded video frame #${framesReceived}: keyframe=${result.isKeyframe}, size=${result.frame.length}`, 'debug');
        }
        videoPlayback!.decode(result.frame, result.isKeyframe, result.timestamp);
      }
    } else if (pt === activeAudioCodec.payloadType) {
      audioPacketsReceived++;
      const receiveStream = rtpSession!.getOrCreateReceiveStream(
        rtpPacket.header.ssrc,
        activeAudioCodec.clockRate
      );
      receiveStream.processPacket(rtpPacket.header, receiveTime);

      const audioFrame = audioDepacketizer!.depacketize(rtpPacket.payload);
      jitterBuffer!.insert({
        sequenceNumber: rtpPacket.header.sequenceNumber,
        timestamp: rtpPacket.header.timestamp,
        payload: audioFrame,
        receiveTime,
      });
    }
  } catch (err) {
    if (packetsReceived <= 5) {
      log(`RTP parse error: ${(err as Error).message}`, 'error');
    }
  }
}

// Handle received RTCP packets
function onRtcpReceived(data: Uint8Array, _receiveTime: number): void {
  try {
    // Check for NACK (PT=205, FMT=1)
    if (data.length >= 12 && data[1] === 205 && (data[0] & 0x1F) === 1) {
      if (videoNackHandler) {
        const retransmits = videoNackHandler.handleIncomingNack(data);
        for (const pkt of retransmits) {
          transport!.send(pkt);
        }
        if (retransmits.length > 0) {
          log(`Retransmitted ${retransmits.length} packets (NACK)`, 'debug');
        }
      }
      return;
    }

    // Check for PLI/FIR (PT=206)
    if (data.length >= 12 && isPliOrFir(data)) {
      if (videoKeyframeHandler) {
        videoKeyframeHandler.handleIncoming(data);
        // Force keyframe from encoder
        if (videoCapture) {
          videoCapture.requestKeyframe();
        }
        log('Keyframe requested by remote (PLI/FIR)', 'debug');
      }
      return;
    }

    const packets = parseRtcpCompound(data);
    for (const pkt of packets) {
      if (pkt.type === 'SR') {
        const receiveStream = rtpSession!.receiveStreams.get(pkt.ssrc);
        if (receiveStream) {
          receiveStream.processSenderReport(
            pkt.senderInfo.ntpTimestampMsw,
            pkt.senderInfo.ntpTimestampLsw
          );
        }
      }
      // Feed receiver reports to CC (fraction lost)
      if (pkt.type === 'RR' && congestionController) {
        for (const block of (pkt as any).reportBlocks || []) {
          congestionController.onRtcpFeedback(
            0, // RTT not directly available from RR
            block.fractionLost || 0,
            performance.now()
          );
        }
      }
    }
  } catch (err) {
    log(`RTCP parse error: ${(err as Error).message}`, 'error');
  }
}

// Send RTCP receiver reports periodically
function startRtcpReporting(): void {
  rtcpTimer = window.setInterval(() => {
    if (!transport || callState!.state !== 'connected') return;
    const rr = rtpSession!.createReceiverReport();
    if (rr) transport.send(rr);
  }, 5000);

  // Initialize error recovery handlers
  initRecovery();
}

function initRecovery(): void {
  // NACK handler (video only — audio uses jitter buffer concealment)
  videoNackHandler = new NackHandler({
    senderSsrc: LOCAL_VIDEO_SSRC,
    mediaSsrc: 0, // Will be updated on first received video packet
    nackRetransmitIntervalMs: 50,
    maxRetransmits: 10,
  });

  // PLI/FIR handler
  videoKeyframeHandler = new KeyframeRequestHandler({
    senderSsrc: LOCAL_VIDEO_SSRC,
    mediaSsrc: 0, // Updated on first received video packet
    minIntervalMs: 1000,
    onKeyframeRequested: () => {
      if (videoCapture) videoCapture.requestKeyframe();
    },
  });

  // FEC encoder (protect every 5 video packets with 1 FEC packet = ~20% overhead)
  videoFecEncoder = new FecEncoder({groupSize: 5});
  videoFecDecoder = new FecDecoder();

  // NACK send timer — periodically send pending NACKs
  nackTimer = window.setInterval(() => {
    if (!transport || !videoNackHandler ||
        callState!.state !== 'connected') return;
    const nack = videoNackHandler.generateNack();
    if (nack) {
      transport.send(nack);
      log(`Sent NACK for ${videoNackHandler.getPendingNackCount()} packets`, 'debug');
    }
  }, 20);
}

// Initialize transport
async function initTransport(isOfferer: boolean): Promise<ReturnType<RtcTransportAdapter['initialize']> extends Promise<infer T> ? T : never> {
  transport = new RtcTransportAdapter({
    config: {
      name: 'av-transport',
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      iceControlling: isOfferer,
      wireProtocol: 'dtls-srtp',
    },
    onRtpReceived,
    onRtcpReceived,
    onIceCandidate: (candidate) => {
      log(`Local ICE candidate: ${candidate.address}:${candidate.port} (${candidate.type})`);
      const candidateStr = `candidate:1 1 udp 2130706431 ${candidate.address} ${candidate.port} typ ${candidate.type} generation 0 ufrag ${candidate.usernameFragment}`;
      signaling!.sendIceCandidate({
        candidate: candidateStr,
        sdpMLineIndex: 0,
        sdpMid: '0',
        usernameFragment: candidate.usernameFragment,
      });
    },
    onWritable: () => {
      log('Transport writable!', 'success');
      if (callState!.state === 'connecting') {
        callState!.transition('connected');
        startRtcpReporting();
      }
    },
  });

  const localParams = await transport.initialize();
  return localParams;
}

// Read selected codecs and resolution from UI
function readUiSettings(): void {
  activeVideoCodec = VIDEO_CODECS[videoCodecSelect.value as VideoCodecName] || VIDEO_CODECS.vp8;
  activeAudioCodec = AUDIO_CODECS[audioCodecSelect.value as AudioCodecName] || AUDIO_CODECS.opus;
  activeResolution = RESOLUTIONS[resolutionSelect.value] || RESOLUTIONS.vga;
  activeCcAlgorithm = (ccAlgorithmSelect?.value as CongestionControlAlgorithm) || 'simple';
}

// Create and send offer
async function createOffer(): Promise<void> {
  readUiSettings();
  callState!.transition('offering');

  const localParams = await initTransport(true);
  log(`Transport initialized: ufrag=${localParams.iceUfrag}, fp=${localParams.fingerprintAlgorithm}`);
  initRtpPipeline();

  const offer = buildSdp({
    iceUfrag: localParams.iceUfrag,
    icePwd: localParams.icePassword,
    fingerprint: formatFingerprint(localParams.fingerprint),
    fingerprintAlgorithm: localParams.fingerprintAlgorithm,
    setup: 'actpass',
    audioSsrc: LOCAL_AUDIO_SSRC,
    videoSsrc: LOCAL_VIDEO_SSRC,
    videoCodec: activeVideoCodec,
    audioCodec: activeAudioCodec,
  });

  log(`SDP offer built (${offer.length} bytes), video=${activeVideoCodec.name}, audio=${activeAudioCodec.name}`);
  console.log('[RtcT] Offer SDP:\n' + offer);
  signaling!.sendOffer(offer);
  log('Sent SDP offer');
}

// Handle received offer
async function handleOffer(sdp: string): Promise<void> {
  readUiSettings();
  callState!.transition('answering');

  log(`Received offer (${sdp.length} bytes)`);
  console.log('[RtcT] Remote Offer SDP:\n' + sdp);
  const remoteSdp = parseSdp(sdp);
  remoteIceUfrag = remoteSdp.iceUfrag;
  remoteIcePwd = remoteSdp.icePwd;
  log(`Remote ICE: ufrag=${remoteIceUfrag}, pwd=${remoteIcePwd ? remoteIcePwd.substring(0, 8) + '...' : 'null'}`);
  log(`Remote DTLS: fp=${remoteSdp.fingerprintAlgorithm}, setup=${remoteSdp.setup}`);

  const localParams = await initTransport(false);
  initRtpPipeline();

  const remoteFingerprint = parseFingerprint(remoteSdp.fingerprint);
  const localSetup = getLocalSetupRole(remoteSdp.setup);
  transport!.setRemoteDtlsParameters({
    sslRole: localSetup === 'active' ? 'client' : 'server',
    fingerprintDigestAlgorithm: remoteSdp.fingerprintAlgorithm,
    fingerprint: remoteFingerprint.buffer as ArrayBuffer,
  });

  for (const candidate of remoteSdp.candidates) {
    transport!.addRemoteCandidate({
      address: candidate.address,
      port: candidate.port,
      usernameFragment: remoteIceUfrag,
      password: remoteIcePwd,
      type: candidate.type,
    });
  }

  const answer = buildSdp({
    iceUfrag: localParams.iceUfrag,
    icePwd: localParams.icePassword,
    fingerprint: formatFingerprint(localParams.fingerprint),
    fingerprintAlgorithm: localParams.fingerprintAlgorithm,
    setup: localSetup,
    audioSsrc: LOCAL_AUDIO_SSRC,
    videoSsrc: LOCAL_VIDEO_SSRC,
    videoCodec: activeVideoCodec,
    audioCodec: activeAudioCodec,
  });

  console.log('[RtcT] Answer SDP:\n' + answer);
  signaling!.sendAnswer(answer);
  log('Sent SDP answer');

  callState!.transition('connecting');
  await startMediaCapture();
}

// Handle received answer
async function handleAnswer(sdp: string): Promise<void> {
  log(`Received answer (${sdp.length} bytes)`);
  console.log('[RtcT] Remote Answer SDP:\n' + sdp);
  const remoteSdp = parseSdp(sdp);
  remoteIceUfrag = remoteSdp.iceUfrag;
  remoteIcePwd = remoteSdp.icePwd;
  log(`Remote ICE: ufrag=${remoteIceUfrag}, pwd=${remoteIcePwd ? remoteIcePwd.substring(0, 8) + '...' : 'null'}`);
  log(`Remote DTLS: fp=${remoteSdp.fingerprintAlgorithm}, setup=${remoteSdp.setup}, candidates=${remoteSdp.candidates.length}`);

  const remoteFingerprint = parseFingerprint(remoteSdp.fingerprint);
  const localSetup = getLocalSetupRole(remoteSdp.setup);
  transport!.setRemoteDtlsParameters({
    sslRole: localSetup === 'active' ? 'client' : 'server',
    fingerprintDigestAlgorithm: remoteSdp.fingerprintAlgorithm,
    fingerprint: remoteFingerprint.buffer as ArrayBuffer,
  });

  for (const candidate of remoteSdp.candidates) {
    transport!.addRemoteCandidate({
      address: candidate.address,
      port: candidate.port,
      usernameFragment: remoteIceUfrag,
      password: remoteIcePwd,
      type: candidate.type,
    });
  }

  callState!.transition('connecting');
  await startMediaCapture();
}

// Start audio + video capture and sending
async function startMediaCapture(): Promise<void> {
  const TIMESTAMP_INCREMENT = activeVideoCodec.clockRate / 30;

  // --- Video ---
  try {
    videoCapture = new VideoCapture({
      width: activeResolution.width,
      height: activeResolution.height,
      frameRate: 30,
      bitrate: 500000,
    codec: activeVideoCodec.webCodecsId || 'vp8',
    onQp: (qp: number) => { lastQp = qp; },
    onFrame: (encodedFrame: Uint8Array, isKeyframe: boolean, _timestamp: number) => {
      if (callState!.state !== 'connected') return;
      const rtpPackets = videoPacketizer!.packetize(encodedFrame, isKeyframe, TIMESTAMP_INCREMENT);
      const nowMs = performance.now();
      for (const pkt of rtpPackets) {
        transport!.send(pkt);
        bytesSent += pkt.length;
        const seqNum = (pkt[2] << 8) | pkt[3];
        // Buffer for NACK retransmission
        if (videoNackHandler) {
          videoNackHandler.bufferSentPacket(seqNum, pkt);
        }
        // Feed FEC encoder
        if (videoFecEncoder) {
          const fecPacket = videoFecEncoder.addPacket(
              seqNum, pkt.slice(12), _timestamp);
          if (fecPacket) {
            transport!.send(fecPacket.data);
          }
        }
        // Feed CC with sent packet info
        if (congestionController) {
          congestionController.onPacketSent(pkt.length, nowMs, seqNum);
        }
      }
      // Flush FEC on keyframes for clean recovery boundaries
      if (isKeyframe && videoFecEncoder) {
        const flushed = videoFecEncoder.flush();
        if (flushed) transport!.send(flushed.data);
      }
      framesSent++;
      packetsSent += rtpPackets.length;
      if (framesSent <= 5 || framesSent % 30 === 0) {
        log(`Sent frame #${framesSent}: keyframe=${isKeyframe}, size=${encodedFrame.length}, pkts=${rtpPackets.length}`, 'debug');
      }
    },
  });

  const stream = await videoCapture.start();
  localVideo.srcObject = stream;

  const canvas = remoteVideo;
  videoPlayback = new VideoPlayback({
    target: canvas,
    codec: activeVideoCodec.webCodecsId || 'vp8',
  });
  await videoPlayback.start();

  log(`Video capture started (${activeVideoCodec.name.toUpperCase()}, ${activeResolution.width}×${activeResolution.height})`, 'success');
  } catch (err) {
    log(`Video codec "${activeVideoCodec.name}" not supported: ${(err as Error).message}`, 'error');
    videoCapture = null;
    videoPlayback = null;
  }

  // --- Audio ---
  audioPlayback = new AudioPlayback({ sampleRate: activeAudioCodec.clockRate });
  await audioPlayback.start();

  jitterBuffer = new JitterBuffer({
    delayMs: 60,
    clockRate: activeAudioCodec.clockRate,
    onPlayoutReady: (packet) => {
      const audioFrame = audioDepacketizer!.depacketize(packet.payload);
      audioPlayback!.playFrame(audioFrame, packet.timestamp);
    },
  });
  jitterBuffer.start();

  // Audio capture (may fail on devbox without audio devices - that's OK)
  try {
    audioCapture = new AudioCapture({
      codec: activeAudioCodec.webCodecsId || 'opus',
      onFrame: (encodedFrame: Uint8Array) => {
        if (callState!.state !== 'connected') return;
        const rtpPacket = audioPacketizer!.packetize(encodedFrame);
        transport!.send(rtpPacket);
        audioPacketsSent++;
      },
    });
    await audioCapture.start();
    log('Audio capture started', 'success');
  } catch (err) {
    log(`Audio capture unavailable: ${(err as Error).message} (video-only mode)`, 'warn');
    audioCapture = null;
  }
}

// Hang up
function hangup(): void {
  callState!.close();

  if (rtcpTimer) { clearInterval(rtcpTimer); rtcpTimer = null; }
  if (nackTimer) { clearInterval(nackTimer); nackTimer = null; }
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  congestionController = null;
  videoNackHandler = null;
  videoKeyframeHandler = null;
  videoFecEncoder = null;
  videoFecDecoder = null;
  if (videoCapture) { videoCapture.stop(); videoCapture = null; }
  if (videoPlayback) { videoPlayback.stop(); videoPlayback = null; }
  if (audioCapture) { audioCapture.stop(); audioCapture = null; }
  if (audioPlayback) { audioPlayback.stop(); audioPlayback = null; }
  if (jitterBuffer) { jitterBuffer.stop(); jitterBuffer = null; }
  if (transport) { transport.close(); transport = null; }

  localVideo.srcObject = null;
  decoderGotKeyframe = false;
  // Reset stats
  framesSent = 0; framesReceived = 0;
  packetsSent = 0; packetsReceived = 0;
  bytesSent = 0; bytesReceived = 0;
  audioPacketsSent = 0; audioPacketsReceived = 0;
  bitrateHistory = []; qpHistory = []; lossHistory = []; jitterHistory = [];
  resolutionHistory = []; fpsHistory = [];
  lastBytesReceived = 0; lastPacketsReceived = 0; lastPacketsLost = 0; lastQp = 0;
  statsEl.innerHTML = '';
  log('Call ended');
}

// Graph drawing
function drawGraph(canvas: HTMLCanvasElement, dataPoints: number[], label: string, unit: string, maxVal?: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.offsetWidth;
  const h = canvas.offsetHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  if (dataPoints.length < 2) {
    ctx.fillStyle = '#aaa';
    ctx.font = '11px system-ui';
    ctx.fillText('Waiting for data...', 10, h / 2);
    return;
  }

  const max = maxVal || Math.max(...dataPoints, 1);
  const step = w / 59;

  // Grid
  ctx.strokeStyle = '#eee';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (h - 20) * (i / 4) + 4;
    ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Line
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const len = Math.min(dataPoints.length, 60);
  const startIdx = Math.max(0, dataPoints.length - 60);
  for (let i = 0; i < len; i++) {
    const x = 30 + i * step;
    const y = 4 + (h - 24) * (1 - dataPoints[startIdx + i] / max);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Labels
  ctx.fillStyle = '#888';
  ctx.font = '10px system-ui';
  ctx.fillText(label, 2, 12);
  ctx.fillText(`${Math.round(max)}${unit}`, 2, h - 4);

  ctx.fillStyle = '#222';
  ctx.font = 'bold 11px system-ui';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(dataPoints[dataPoints.length - 1])}${unit}`, w - 4, 12);
  ctx.textAlign = 'left';
}

// Stats display
function updateStats(): void {
  if (!callState || callState.state !== 'connected') {
    statsEl.innerHTML = '';
    return;
  }

  // Compute bitrate
  const newBytes = bytesReceived - lastBytesReceived;
  const bitrateKbps = (newBytes * 8) / 1000;
  lastBytesReceived = bytesReceived;

  // Estimate loss from receive streams
  let totalLost = 0;
  let totalJitterMs = 0;
  let streamCount = 0;
  if (rtpSession) {
    for (const rs of rtpSession.receiveStreams.values()) {
      totalLost += (rs as any).packetsLost || 0;
      // jitter is in RTP clock rate units (RFC 3550 A.8)
      // Convert to ms: jitter / clockRate * 1000
      const clockRate = (rs as any).clockRate || 90000;
      const jitterRtpUnits = (rs as any).jitter || 0;
      totalJitterMs += (jitterRtpUnits / clockRate) * 1000;
      streamCount++;
    }
  }
  const lossRate = lastPacketsReceived > 0
    ? Math.max(0, ((totalLost - lastPacketsLost) / Math.max(1, packetsReceived - lastPacketsReceived)) * 100)
    : 0;
  lastPacketsReceived = packetsReceived;
  lastPacketsLost = totalLost;
  const jitterMs = streamCount > 0 ? totalJitterMs / streamCount : 0;

  // Update history
  bitrateHistory.push(bitrateKbps);
  qpHistory.push(lastQp);
  lossHistory.push(lossRate);
  jitterHistory.push(jitterMs);
  const currentResKpx = (activeResolution.width * activeResolution.height) / 1000;
  resolutionHistory.push(currentResKpx);
  if (bitrateHistory.length > 60) bitrateHistory.shift();
  if (qpHistory.length > 60) qpHistory.shift();
  if (lossHistory.length > 60) lossHistory.shift();
  if (jitterHistory.length > 60) jitterHistory.shift();
  if (resolutionHistory.length > 60) resolutionHistory.shift();

  const fps = framesReceived > 0 ? Math.round(framesReceived / ((Date.now() - (window as any).__callStartTime || Date.now()) / 1000)) : 0;
  if (!(window as any).__callStartTime) (window as any).__callStartTime = Date.now();
  fpsHistory.push(fps);
  if (fpsHistory.length > 60) fpsHistory.shift();

  // CC target bitrate
  const ccTargetKbps = congestionController
    ? Math.round(congestionController.getTargetBitrateBps() / 1000)
    : 0;
  const ccLabel = activeCcAlgorithm === 'gcc' ? 'GCC' : 'Simple';

  statsEl.innerHTML = `
    <div class="stats-sections">
      <div>
        <h3 class="stats-section-title">Video</h3>
        <div class="stats-grid">
          <div class="stat-item"><span class="stat-label">Codec</span><span class="stat-value">${activeVideoCodec.name.toUpperCase()}</span></div>
          <div class="stat-item"><span class="stat-label">Resolution</span><span class="stat-value">${activeResolution.width}×${activeResolution.height}</span></div>
          <div class="stat-item"><span class="stat-label">FPS</span><span class="stat-value">${fps}</span></div>
          <div class="stat-item"><span class="stat-label">Frames</span><span class="stat-value">${framesSent}↑ ${framesReceived}↓</span></div>
          <div class="stat-item"><span class="stat-label">QP (est)</span><span class="stat-value">${lastQp}</span></div>
        </div>
      </div>
      <div>
        <h3 class="stats-section-title">Audio</h3>
        <div class="stats-grid">
          <div class="stat-item"><span class="stat-label">Codec</span><span class="stat-value">${activeAudioCodec.name.toUpperCase()}</span></div>
          <div class="stat-item"><span class="stat-label">Pkts sent</span><span class="stat-value">${audioPacketsSent}</span></div>
          <div class="stat-item"><span class="stat-label">Pkts recv</span><span class="stat-value">${audioPacketsReceived}</span></div>
        </div>
      </div>
      <div>
        <h3 class="stats-section-title">Network</h3>
        <div class="stats-grid">
          <div class="stat-item"><span class="stat-label">CC (${ccLabel})</span><span class="stat-value">${ccTargetKbps} kbps</span></div>
          <div class="stat-item"><span class="stat-label">Bitrate</span><span class="stat-value">${Math.round(bitrateKbps)} kbps</span></div>
          <div class="stat-item"><span class="stat-label">Pkts sent</span><span class="stat-value">${packetsSent}</span></div>
          <div class="stat-item"><span class="stat-label">Pkts recv</span><span class="stat-value">${packetsReceived}</span></div>
          <div class="stat-item"><span class="stat-label">Loss</span><span class="stat-value">${lossRate.toFixed(1)}%</span></div>
          <div class="stat-item"><span class="stat-label">Jitter</span><span class="stat-value">${jitterMs.toFixed(1)} ms</span></div>
          <div class="stat-item"><span class="stat-label">NACK sent</span><span class="stat-value">${videoNackHandler?.stats.nacksSent ?? 0}</span></div>
          <div class="stat-item"><span class="stat-label">FEC recovered</span><span class="stat-value">${videoFecDecoder?.stats.packetsRecoveredByFec ?? 0}</span></div>
          <div class="stat-item"><span class="stat-label">PLI sent</span><span class="stat-value">${videoKeyframeHandler?.stats.pliSent ?? 0}</span></div>
        </div>
      </div>
    </div>
  `;

  // Update graphs if visible
  if (graphsPanel.classList.contains('visible')) {
    drawGraph(graphBitrate, bitrateHistory, 'Bitrate', ' kbps');
    drawGraph(graphQp, qpHistory, 'QP', '', 51);
    drawGraph(graphLoss, lossHistory, 'Loss', '%', 10);
    drawGraph(graphJitter, jitterHistory, 'Jitter', ' ms');
    drawGraph(graphResolution, resolutionHistory, 'Resolution', ' kpx');
    drawGraph(graphFps, fpsHistory, 'FPS', '', 60);
  }
}

// UI Event handlers
btnJoin.addEventListener('click', async () => {
  const room = roomInput.value.trim();
  if (!room) return;

  const wsUrl = `ws://${window.location.host}`;
  signaling = new SignalingChannel(wsUrl);

  signaling.onOffer = handleOffer;
  signaling.onAnswer = handleAnswer;
  signaling.onIceCandidate = (candidate) => {
    addRemoteIceCandidate(candidate as { candidate?: string } | string);
  };
  signaling.onPeerJoined = (peerId: string) => {
    log(`Peer joined: ${peerId}`);
  };
  signaling.onPeerLeft = () => {
    log('Peer left', 'warn');
    if (callState!.state !== 'idle' && callState!.state !== 'closed') {
      hangup();
    }
  };

  try {
    const peerId = await signaling.connect(room);
    log(`Joined room "${room}" as ${peerId}`, 'success');
    initCallState();
    btnCall.disabled = false;
    btnJoin.disabled = true;
    roomInput.disabled = true;
  } catch (err) {
    log(`Failed to join: ${(err as Error).message}`, 'error');
  }
});

btnCall.addEventListener('click', async () => {
  if (!signaling || !signaling.remotePeerId) {
    log('No remote peer in room yet', 'warn');
    return;
  }
  try {
    await createOffer();
  } catch (err) {
    log(`Call failed: ${(err as Error).message}`, 'error');
  }
});

btnHangup.addEventListener('click', () => {
  hangup();
  const statsPanel = document.getElementById('statsPanel') as HTMLElement;
  if (statsPanel) statsPanel.hidden = true;
  initCallState();
  // Re-enable Call if still connected and peer is available
  btnCall.disabled = !(signaling && signaling.remotePeerId);
  btnJoin.disabled = true; // still joined
  // Re-enable settings
  (document.getElementById('videoCodec') as HTMLSelectElement).disabled = false;
  (document.getElementById('audioCodec') as HTMLSelectElement).disabled = false;
  (document.getElementById('ccAlgorithm') as HTMLSelectElement).disabled = false;
  (document.getElementById('resolution') as HTMLSelectElement).disabled = false;
});

// Graphs toggle
btnToggleGraphs.addEventListener('click', () => {
  graphsPanel.classList.toggle('visible');
  btnToggleGraphs.textContent = graphsPanel.classList.contains('visible') ? 'Hide Graphs' : 'Show Graphs';
});

// Stats update timer — also show/hide the stats panel
setInterval(() => {
  const statsPanel = document.getElementById('statsPanel') as HTMLElement;
  if (statsPanel) {
    statsPanel.hidden = !(callState && callState.state === 'connected');
  }
  updateStats();
}, 1000);

log('Application loaded. RtcTransport Client ready.');
