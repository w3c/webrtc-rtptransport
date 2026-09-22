// Unified Call App
//
// A single A/V calling app written ONLY against the backend seam
// (MediaBackend / RTCPeerConnectionLike) and standard Web APIs. The transport
// is chosen at load time via `?backend=native|proxy` (defaults to proxy):
//   - proxy  → RtcPeerConnectionShim over RtcTransport (default)
//   - native → real RTCPeerConnection (reference/baseline)
//
// The exact same code path drives both backends. That is the end goal: one app,
// interchangeable WebRTC / WebRTC-proxy transports.

import { SignalingChannel } from './signaling';
import {
  createBackend,
  resolveBackendKind,
  type MediaBackend,
  type RTCPeerConnectionLike,
} from './webrtc/index';
import type { CallPreferences } from './webrtc/types';

// --- DOM ---
const localVideo = document.getElementById('localVideo') as HTMLVideoElement;
const remoteVideo = document.getElementById('remoteVideo') as HTMLVideoElement;
const roomInput = document.getElementById('room') as HTMLInputElement;
const resolutionSelect = document.getElementById('resolution') as HTMLSelectElement;
const videoCodecSelect = document.getElementById('videoCodec') as HTMLSelectElement;
const audioCodecSelect = document.getElementById('audioCodec') as HTMLSelectElement;
const ccAlgorithmSelect = document.getElementById('ccAlgorithm') as HTMLSelectElement;
const btnJoin = document.getElementById('btnJoin') as HTMLButtonElement;
const btnHangup = document.getElementById('btnHangup') as HTMLButtonElement;
const btnMute = document.getElementById('btnMute') as HTMLButtonElement;
const btnCamera = document.getElementById('btnCamera') as HTMLButtonElement;
const meterLocal = document.getElementById('meterLocal') as HTMLElement;
const meterRemote = document.getElementById('meterRemote') as HTMLElement;
const statsBody = document.getElementById('statsBody') as HTMLElement;
const backendLabelEl = document.getElementById('backendLabel') as HTMLElement;
const stateEl = document.getElementById('callState') as HTMLElement;
const logEl = document.getElementById('log') as HTMLElement;

const settingsSelects = [resolutionSelect, videoCodecSelect, audioCodecSelect, ccAlgorithmSelect];

// --- Capture resolutions (applied via getUserMedia; backend-agnostic) ---
const RESOLUTIONS: Record<string, { width: number; height: number }> = {
  qvga: { width: 320, height: 240 },
  vga: { width: 640, height: 480 },
  sd: { width: 854, height: 480 },
  hd: { width: 1280, height: 720 },
};

let prefs: CallPreferences = { videoCodec: 'vp8', audioCodec: 'opus', ccAlgorithm: 'gcc' };
let resolution = RESOLUTIONS.vga;

function readSettings(): void {
  resolution = RESOLUTIONS[resolutionSelect.value] ?? RESOLUTIONS.vga;
  prefs = {
    videoCodec: videoCodecSelect.value,
    audioCodec: audioCodecSelect.value,
    ccAlgorithm: (ccAlgorithmSelect.value as 'aimd' | 'gcc') || 'gcc',
  };
}

function setSettingsDisabled(disabled: boolean): void {
  for (const el of settingsSelects) el.disabled = disabled;
}

function log(msg: string): void {
  const time = new Date().toLocaleTimeString();
  logEl.textContent = `[${time}] ${msg}\n` + logEl.textContent;
  console.log('[unified]', msg);
}

/**
 * Log an SDP exchanged via the signaling server. A one-line summary goes to the
 * on-screen log; the full SDP is printed to the browser console (collapsed).
 */
function logSdp(direction: 'Sent' | 'Received', kind: 'offer' | 'answer', sdp: string): void {
  log(`${direction} ${kind} — SDP (${sdp.length} bytes):\n${sdp.trim()}`);
  console.groupCollapsed(`[unified] ${direction} ${kind} SDP (${sdp.length} bytes)`);
  console.log(sdp);
  console.groupEnd();
}

/** Log an ICE candidate exchanged via the signaling server. */
function logCandidate(direction: 'Sent' | 'Received', init: RTCIceCandidateInit): void {
  const cand = (init.candidate ?? '').trim();
  log(`${direction} ICE candidate: ${cand || '(end-of-candidates)'}`);
}

function setState(s: string): void {
  stateEl.textContent = s;
}

// --- Backend selection ---
const backendKind = resolveBackendKind();
const backend: MediaBackend = createBackend(backendKind);
backendLabelEl.textContent = backend.label;
document.title = `Unified Call — ${backend.label}`;

if (!backend.isAvailable()) {
  const reason = backend.unavailableReason() ?? 'Backend unavailable.';
  log(`Backend "${backend.label}" is unavailable: ${reason}`);
  setState('unavailable');
  btnJoin.disabled = true;
}

// --- AAC encode support probe ---
// AAC decode is broadly available, but AAC *encode* via WebCodecs is not
// guaranteed on all Chrome builds. Disable the option (and fall back to Opus)
// when the browser cannot encode AAC-LC, so users only pick working codecs.
void (async (): Promise<void> => {
  const aacOption =
      audioCodecSelect.querySelector('option[value="aac"]') as HTMLOptionElement | null;
  if (!aacOption) return;
  let supported = false;
  try {
    const AudioEncoderCtor = (globalThis as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder;
    if (AudioEncoderCtor?.isConfigSupported) {
      const res = await AudioEncoderCtor.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128000,
      });
      supported = res.supported === true;
    }
  } catch {
    supported = false;
  }
  if (!supported) {
    aacOption.disabled = true;
    aacOption.text = 'AAC-LC (not supported by this browser)';
    if (audioCodecSelect.value === 'aac') {
      audioCodecSelect.value = 'opus';
      readSettings();
    }
  }
})();

// --- Call state ---
let signaling: SignalingChannel | null = null;
let pc: RTCPeerConnectionLike | null = null;
let localStream: MediaStream | null = null;
let remoteStream: MediaStream | null = null;
let isInitiator = false;
let remoteDescriptionSet = false;
let videoSender: RTCRtpSender | null = null;
let cameraOn = true;
let renegotiating = false;
const pendingCandidates: RTCIceCandidateInit[] = [];

// --- Audio level metering (backend-agnostic proof of direction) ---
let meterCtx: AudioContext | null = null;
const meterHandles: Array<{ raf: number; source: MediaStreamAudioSourceNode }> = [];
let micMuted = false;

function attachMeter(stream: MediaStream, fill: HTMLElement): void {
  if (stream.getAudioTracks().length === 0) return;
  if (!meterCtx) meterCtx = new AudioContext();
  void meterCtx.resume();
  const source = meterCtx.createMediaStreamSource(stream);
  const analyser = meterCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  const handle = { raf: 0, source };
  const tick = (): void => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    const pct = Math.min(100, Math.round(rms * 300));
    fill.style.width = pct + '%';
    handle.raf = requestAnimationFrame(tick);
  };
  handle.raf = requestAnimationFrame(tick);
  meterHandles.push(handle);
}

function stopMeters(): void {
  for (const h of meterHandles) {
    cancelAnimationFrame(h.raf);
    try { h.source.disconnect(); } catch { /* ignore */ }
  }
  meterHandles.length = 0;
  meterLocal.style.width = '0%';
  meterRemote.style.width = '0%';
  if (meterCtx) { void meterCtx.close(); meterCtx = null; }
}

function toggleMute(): void {
  if (!localStream) return;
  micMuted = !micMuted;
  for (const t of localStream.getAudioTracks()) t.enabled = !micMuted;
  btnMute.textContent = micMuted ? 'Unmute mic' : 'Mute mic';
  log(micMuted ? 'Mic muted (sending silence).' : 'Mic unmuted.');
}

// --- Mid-call camera on/off via renegotiation (backend-agnostic) ---
async function toggleCamera(): Promise<void> {
  if (!pc || !videoSender || !localStream || renegotiating) return;
  btnCamera.disabled = true;
  try {
    if (cameraOn) {
      await videoSender.replaceTrack(null);
      for (const t of localStream.getVideoTracks()) { localStream.removeTrack(t); t.stop(); }
      localVideo.srcObject = localStream;
      cameraOn = false;
      btnCamera.textContent = 'Camera on';
      log('Camera off — renegotiating.');
    } else {
      const cam = await backend.getUserMedia({
        video: { width: { ideal: resolution.width }, height: { ideal: resolution.height } },
        audio: false,
      });
      const vtrack = cam.getVideoTracks()[0];
      await videoSender.replaceTrack(vtrack);
      localStream.addTrack(vtrack);
      localVideo.srcObject = localStream;
      cameraOn = true;
      btnCamera.textContent = 'Camera off';
      log('Camera on — renegotiating.');
    }
    await renegotiate();
  } catch (err) {
    log(`Camera toggle failed: ${(err as Error).message}`);
  } finally {
    btnCamera.disabled = false;
  }
}

async function renegotiate(): Promise<void> {
  if (!pc || !signaling) return;
  renegotiating = true;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.sendOffer(pc.localDescription!.sdp);
    logSdp('Sent', 'offer', pc.localDescription!.sdp);
    log('Renegotiation offer sent.');
  } catch (err) {
    log(`Renegotiation failed: ${(err as Error).message}`);
  } finally {
    renegotiating = false;
  }
}

// --- Stats polling (backend-agnostic: reads standard getStats()) ---
interface RtpSnapshot {
  packets: number;
  bytes: number;
  ts: number;
  bitrateKbps: number;
  packetsLost: number;
  framesEncoded: number;
  framesDecoded: number;
}
let statsTimer: number | null = null;
const statsPrev = new Map<string, RtpSnapshot>();

// --- Graph history buffers (60s rolling window, ~1 sample/s) ---
const GRAPH_LEN = 60;
const graphsPanel = document.getElementById('graphsPanel') as HTMLDetailsElement;
const graphCanvases = {
  sendBitrate: document.getElementById('graphSendBitrate') as HTMLCanvasElement,
  recvBitrate: document.getElementById('graphRecvBitrate') as HTMLCanvasElement,
  fps: document.getElementById('graphFps') as HTMLCanvasElement,
  loss: document.getElementById('graphLoss') as HTMLCanvasElement,
  jitter: document.getElementById('graphJitter') as HTMLCanvasElement,
  frameSize: document.getElementById('graphFrameSize') as HTMLCanvasElement,
};
const history = {
  sendBitrate: [] as number[],
  recvBitrate: [] as number[],
  fps: [] as number[],
  loss: [] as number[],
  jitter: [] as number[],
  frameSize: [] as number[],
};

function pushHistory(buf: number[], value: number): void {
  buf.push(value);
  if (buf.length > GRAPH_LEN) buf.shift();
}

function clearHistory(): void {
  for (const buf of Object.values(history)) buf.length = 0;
}

function drawGraph(
    canvas: HTMLCanvasElement, data: number[], unit: string, maxVal?: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.offsetWidth;
  const h = canvas.offsetHeight;
  if (w === 0 || h === 0) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  if (data.length < 2) {
    ctx.fillStyle = '#666';
    ctx.font = '11px system-ui';
    ctx.fillText('Waiting for data…', 8, h / 2);
    return;
  }

  const max = maxVal || Math.max(...data, 1);
  const step = w / (GRAPH_LEN - 1);

  ctx.strokeStyle = '#26262c';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (h - 20) * (i / 4) + 4;
    ctx.beginPath(); ctx.moveTo(28, y); ctx.lineTo(w, y); ctx.stroke();
  }

  ctx.strokeStyle = '#63b3ed';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const startIdx = Math.max(0, data.length - GRAPH_LEN);
  const len = data.length - startIdx;
  for (let i = 0; i < len; i++) {
    const x = 28 + i * step;
    const y = 4 + (h - 24) * (1 - data[startIdx + i] / max);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = '#8a8a92';
  ctx.font = '10px system-ui';
  ctx.fillText(`${Math.round(max)}${unit}`, 2, 12);

  ctx.fillStyle = '#e6e6e6';
  ctx.font = 'bold 11px system-ui';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(data[data.length - 1])}${unit}`, w - 4, 12);
  ctx.textAlign = 'left';
}

function drawGraphs(): void {
  if (!graphsPanel.open) return;
  drawGraph(graphCanvases.sendBitrate, history.sendBitrate, ' kbps');
  drawGraph(graphCanvases.recvBitrate, history.recvBitrate, ' kbps');
  drawGraph(graphCanvases.fps, history.fps, '', 60);
  drawGraph(graphCanvases.loss, history.loss, ' %', 10);
  drawGraph(graphCanvases.jitter, history.jitter, ' ms');
  drawGraph(graphCanvases.frameSize, history.frameSize, ' KB');
}

graphsPanel.addEventListener('toggle', () => { if (graphsPanel.open) drawGraphs(); });

function startStatsPolling(): void {
  if (statsTimer !== null) return;
  statsTimer = window.setInterval(() => void pollStats(), 1000);
}

function stopStatsPolling(): void {
  if (statsTimer !== null) { clearInterval(statsTimer); statsTimer = null; }
  statsPrev.clear();
  clearHistory();
  drawGraphs();
  statsBody.innerHTML = '<tr><td colspan="4">no data yet</td></tr>';
}

async function pollStats(): Promise<void> {
  if (!pc) return;
  let report: RTCStatsReport;
  try {
    report = await pc.getStats();
  } catch {
    return;
  }
  const rows: string[] = [];
  let sendBitrate = 0;
  let recvBitrate = 0;
  let recvFps = 0;
  let lossPct = 0;
  let jitterMs = 0;
  let sendFrameSizeKb = 0;
  report.forEach((s: Record<string, unknown>) => {
    const type = s.type as string;
    // Native send-side loss is reported by the remote peer via remote-inbound-rtp.
    if (type === 'remote-inbound-rtp') {
      if (typeof s.fractionLost === 'number') {
        lossPct = Math.max(lossPct, (s.fractionLost as number) * 100);
      }
      return;
    }
    if (type !== 'outbound-rtp' && type !== 'inbound-rtp') return;
    const kind = (s.kind ?? s.mediaType) as string;
    const dir = type === 'outbound-rtp' ? 'send' : 'recv';
    const label = `${kind} ${dir}`;
    const packets = (type === 'outbound-rtp' ? s.packetsSent : s.packetsReceived) as number ?? 0;
    const bytes = (type === 'outbound-rtp' ? s.bytesSent : s.bytesReceived) as number ?? 0;
    const packetsLost = (s.packetsLost as number) ?? 0;
    const framesEncoded = (s.framesEncoded as number) ?? 0;
    const framesDecoded = (s.framesDecoded as number) ?? 0;
    const now = performance.now();

    const prev = statsPrev.get(label);
    const dt = prev ? (now - prev.ts) / 1000 : 0;
    let bitrateKbps = prev?.bitrateKbps ?? 0;
    if (prev && dt > 0) {
      bitrateKbps = Math.round(((bytes - prev.bytes) * 8) / dt / 1000);
    }
    statsPrev.set(label, { packets, bytes, ts: now, bitrateKbps, packetsLost, framesEncoded, framesDecoded });

    // Collect graph series from cumulative counters via deltas (works on both
    // backends: native populates framesEncoded/framesDecoded/packetsLost, and
    // the proxy shim now emits the same fields).
    if (kind === 'video' && dir === 'send') {
      sendBitrate = bitrateKbps;
      if (prev && dt > 0) {
        const dFrames = framesEncoded - prev.framesEncoded;
        const dBytes = bytes - prev.bytes;
        if (dFrames > 0) {
          sendFrameSizeKb = (dBytes / dFrames) / 1024;
        } else {
          const fps = (s.framesPerSecond as number) ?? 0;
          if (fps > 0) sendFrameSizeKb = (dBytes / dt / fps) / 1024;
        }
      }
      if (typeof s.jitter === 'number') jitterMs = Math.max(jitterMs, (s.jitter as number) * 1000);
    } else if (kind === 'video' && dir === 'recv') {
      recvBitrate = bitrateKbps;
      if (prev && dt > 0 && framesDecoded > 0) {
        const dFrames = framesDecoded - prev.framesDecoded;
        if (dFrames >= 0) recvFps = dFrames / dt;
      }
      if (recvFps === 0 && typeof s.framesPerSecond === 'number') recvFps = s.framesPerSecond as number;
      if (typeof s.jitter === 'number') jitterMs = Math.max(jitterMs, (s.jitter as number) * 1000);
    }

    // Receive-path loss: per-interval fraction from cumulative packetsLost.
    if (dir === 'recv' && prev && dt > 0) {
      const dLost = packetsLost - prev.packetsLost;
      const dRecv = packets - prev.packets;
      if (dLost >= 0 && dLost + dRecv > 0) {
        lossPct = Math.max(lossPct, (dLost / (dLost + dRecv)) * 100);
      }
    }
    // Send-path loss reported by the remote (proxy exposes fractionLost on outbound-rtp).
    if (typeof s.fractionLost === 'number') {
      lossPct = Math.max(lossPct, (s.fractionLost as number) * 100);
    }

    rows.push(
      `<tr><td>${label}</td><td>${packets}</td>` +
      `<td>${(bytes / 1024).toFixed(1)} KiB</td><td>${bitrateKbps} kbps</td></tr>`);
  });
  statsBody.innerHTML = rows.length
    ? rows.join('')
    : '<tr><td colspan="4">no data yet</td></tr>';

  pushHistory(history.sendBitrate, sendBitrate);
  pushHistory(history.recvBitrate, recvBitrate);
  pushHistory(history.fps, recvFps);
  pushHistory(history.loss, Math.round(lossPct * 10) / 10);
  pushHistory(history.jitter, Math.round(jitterMs * 10) / 10);
  pushHistory(history.frameSize, Math.round(sendFrameSizeKb * 10) / 10);
  drawGraphs();
}

const SIGNALING_URL =
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

async function join(): Promise<void> {
  btnJoin.disabled = true;
  readSettings();
  setSettingsDisabled(true);
  const room = roomInput.value.trim() || 'test-room';

  try {
    localStream = await backend.getUserMedia({
      video: { width: { ideal: resolution.width }, height: { ideal: resolution.height } },
      audio: true,
    });
    localVideo.srcObject = localStream;
    attachMeter(localStream, meterLocal);
    micMuted = false;
    btnMute.textContent = 'Mute mic';
    btnMute.disabled = false;
    const vs = localStream.getVideoTracks()[0]?.getSettings();
    log(`Local media acquired (${localStream.getTracks().length} tracks` +
        `${vs?.width ? `, ${vs.width}×${vs.height}` : ''})`);
    log(`Prefs: video=${prefs.videoCodec}, audio=${prefs.audioCodec}, cc=${prefs.ccAlgorithm}`);
  } catch (err) {
    log(`getUserMedia failed: ${(err as Error).message}`);
    setState('error');
    btnJoin.disabled = false;
    setSettingsDisabled(false);
    return;
  }

  createPeerConnection();

  signaling = new SignalingChannel(SIGNALING_URL);
  wireSignaling(signaling);

  try {
    const myId = await signaling.connect(room);
    log(`Joined room "${room}" as ${myId}`);
    btnHangup.disabled = false;
    setState('waiting-for-peer');
  } catch (err) {
    log(`Signaling connect failed: ${(err as Error).message}`);
    setState('error');
    btnJoin.disabled = false;
  }
}

// Apply codec preference using the standard setCodecPreferences API. Only the
// native backend exposes getTransceivers; the proxy shim orders codecs itself.
function applyNativeCodecPreferences(conn: RTCPeerConnectionLike, p: CallPreferences): void {
  if (typeof conn.getTransceivers !== 'function') return;
  if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;

  const MIME: Record<string, string> = {
    vp8: 'video/vp8', vp9: 'video/vp9', h264: 'video/h264', hevc: 'video/h265', av1: 'video/av1',
    opus: 'audio/opus', pcmu: 'audio/pcmu', pcma: 'audio/pcma',
  };
  const caps: Record<string, RTCRtpCodec[]> = {
    video: RTCRtpSender.getCapabilities('video')?.codecs ?? [],
    audio: RTCRtpSender.getCapabilities('audio')?.codecs ?? [],
  };

  for (const tx of conn.getTransceivers()) {
    if (typeof tx.setCodecPreferences !== 'function') continue;
    const kind = tx.sender?.track?.kind ?? tx.receiver?.track?.kind;
    if (kind !== 'video' && kind !== 'audio') continue;
    const wantMime = MIME[kind === 'video' ? p.videoCodec : p.audioCodec];
    const list = caps[kind];
    if (!wantMime || list.length === 0) continue;
    const preferred = list.filter((c) => c.mimeType.toLowerCase() === wantMime);
    if (preferred.length === 0) continue;
    const rest = list.filter((c) => c.mimeType.toLowerCase() !== wantMime);
    try {
      tx.setCodecPreferences([...preferred, ...rest]);
    } catch (err) {
      log(`setCodecPreferences(${kind}) failed: ${(err as Error).message}`);
    }
  }
}

function createPeerConnection(): void {
  pc = backend.createPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  }, prefs);

  for (const track of localStream!.getTracks()) {
    const sender = pc.addTrack(track, localStream!);
    if (track.kind === 'video') videoSender = sender;
  }
  cameraOn = localStream!.getVideoTracks().length > 0;
  btnCamera.textContent = cameraOn ? 'Camera off' : 'Camera on';

  // Apply codec preferences the standard way on backends that expose
  // transceivers (native). The proxy shim orders codecs internally from prefs.
  applyNativeCodecPreferences(pc, prefs);

  pc.onicecandidate = (ev: RTCPeerConnectionIceEvent): void => {
    if (ev.candidate && signaling) {
      const init = ev.candidate.toJSON();
      logCandidate('Sent', init);
      signaling.sendIceCandidate(init);
    }
  };

  pc.ontrack = (ev: RTCTrackEvent): void => {
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }
    remoteStream.addTrack(ev.track);
    if (ev.track.kind === 'audio') attachMeter(remoteStream, meterRemote);
    log(`Remote track received: ${ev.track.kind}`);
  };

  pc.onconnectionstatechange = (): void => {
    log(`Connection state: ${pc!.connectionState}`);
    setState(pc!.connectionState);
    if (pc!.connectionState === 'connected') {
      startStatsPolling();
      btnCamera.disabled = false;
    }
  };

  pc.oniceconnectionstatechange = (): void => {
    log(`ICE state: ${pc!.iceConnectionState}`);
  };
}

function wireSignaling(sig: SignalingChannel): void {
  // The peer that finds an existing peer on join is the initiator (offerer).
  sig.onConnected = (_myId: string, peers: string[]): void => {
    if (peers.length > 0) {
      isInitiator = true;
      log('Existing peer found — acting as initiator.');
      void startNegotiation();
    }
  };

  sig.onPeerJoined = (peerId: string): void => {
    log(`Peer joined: ${peerId}`);
    // The already-present peer waits for the newcomer's offer.
  };

  sig.onPeerLeft = (peerId: string): void => {
    log(`Peer left: ${peerId}`);
    setState('peer-left');
  };

  sig.onOffer = async (sdp: string): Promise<void> => {
    if (!pc) return;
    log('Received offer.');
    logSdp('Received', 'offer', sdp);
    await pc.setRemoteDescription({ type: 'offer', sdp });
    remoteDescriptionSet = true;
    await flushCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signaling!.sendAnswer(pc.localDescription!.sdp);
    logSdp('Sent', 'answer', pc.localDescription!.sdp);
    log('Sent answer.');
  };

  sig.onAnswer = async (sdp: string): Promise<void> => {
    if (!pc) return;
    log('Received answer.');
    logSdp('Received', 'answer', sdp);
    await pc.setRemoteDescription({ type: 'answer', sdp });
    remoteDescriptionSet = true;
    await flushCandidates();
  };

  sig.onIceCandidate = async (candidate: unknown): Promise<void> => {
    if (!pc) return;
    const init = candidate as RTCIceCandidateInit;
    logCandidate('Received', init);
    if (!remoteDescriptionSet) {
      pendingCandidates.push(init);
      return;
    }
    try {
      await pc.addIceCandidate(init);
    } catch (err) {
      log(`addIceCandidate failed: ${(err as Error).message}`);
    }
  };

  sig.onError = (err: Error): void => {
    log(`Signaling error: ${err.message}`);
  };
}

async function startNegotiation(): Promise<void> {
  if (!pc || !signaling) return;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.sendOffer(pc.localDescription!.sdp);
    logSdp('Sent', 'offer', pc.localDescription!.sdp);
    log('Sent offer.');
    setState('negotiating');
  } catch (err) {
    log(`Negotiation failed: ${(err as Error).message}`);
    setState('error');
  }
}

async function flushCandidates(): Promise<void> {
  if (!pc) return;
  while (pendingCandidates.length > 0) {
    const c = pendingCandidates.shift()!;
    try {
      await pc.addIceCandidate(c);
    } catch (err) {
      log(`Buffered addIceCandidate failed: ${(err as Error).message}`);
    }
  }
}

function hangup(): void {
  stopMeters();
  stopStatsPolling();
  if (pc) { pc.close(); pc = null; }
  if (signaling) { signaling.disconnect(); signaling = null; }
  if (localStream) {
    for (const t of localStream.getTracks()) t.stop();
    localStream = null;
  }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  remoteStream = null;
  remoteDescriptionSet = false;
  isInitiator = false;
  micMuted = false;
  videoSender = null;
  cameraOn = true;
  renegotiating = false;
  btnMute.disabled = true;
  btnMute.textContent = 'Mute mic';
  btnCamera.disabled = true;
  btnCamera.textContent = 'Camera off';
  pendingCandidates.length = 0;
  btnHangup.disabled = true;
  btnJoin.disabled = !backend.isAvailable();
  setSettingsDisabled(false);
  setState('idle');
  log('Call ended.');
}

btnJoin.addEventListener('click', () => void join());
btnHangup.addEventListener('click', hangup);
btnMute.addEventListener('click', toggleMute);
btnCamera.addEventListener('click', () => void toggleCamera());

setState('idle');
log(`Backend: ${backend.label} (?backend=${backendKind})`);
