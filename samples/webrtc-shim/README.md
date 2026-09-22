# RtcTransport WebRTC Sample (`webrtc-shim`)

## Introduction

This project is a TypeScript WebRTC application built on the low-level
[`RtcTransport` browser API](https://w3c.github.io/webrtc-rtptransport/) (a W3C proposal that
exposes ICE + DTLS-SRTP as a raw packet pipe). On top of that pipe it implements a **full
RTP/RTCP media stack in JavaScript** — packetization, jitter buffering, pacing, congestion
control, and error recovery — the machinery a browser normally hides inside `RTCPeerConnection`.

To prove the stack is real, it is wrapped in an **`RTCPeerConnection`-shaped shim**
(`RtcPeerConnectionShim`) so a single **unified app** can run over one of two interchangeable
backends selected at load time with `?backend=proxy|native`:

- **`proxy`** *(default)* — the **WebRTC Proxy over RtcTransport**: our JS RTP/RTCP engine
  behind the shim. This is what the project demonstrates.
- **`native`** — the browser's real `RTCPeerConnection`, used as the reference/oracle the proxy
  is measured against.

Because both backends satisfy the same seam, the proxy interoperates with an ordinary WebRTC
peer: `proxy↔native` calls exchange audio and video.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Unified App (unified-app.ts) → served at /                     │
├──────────────────────────────────────────────────────────────────┤
│  Backend Seam (MediaBackend / RTCPeerConnectionLike)            │
│    ├─ Native backend  → window.RTCPeerConnection                │
│    └─ Proxy backend   → RtcPeerConnectionShim (below)           │
├──────────────────────────────────────────────────────────────────┤
│  Call State Machine │ Signaling │ SDP Builder/Parser             │
├──────────────────────────────────────────────────────────────────┤
│  Video/Audio Capture │ Multi-codec Packetizers │ Jitter Buffer   │
├──────────────────────────────────────────────────────────────────┤
│  Error Recovery (NACK │ PLI/FIR │ XOR FEC)                       │
├──────────────────────────────────────────────────────────────────┤
│  Pacer (Token-bucket │ Priority Queues │ Queue-driven Rate)      │
├──────────────────────────────────────────────────────────────────┤
│  Congestion Control (AIMD / GCC RFC 8698)                        │
├──────────────────────────────────────────────────────────────────┤
│  RTP/RTCP Stack (RFC 3550)                                       │
├──────────────────────────────────────────────────────────────────┤
│  RtcTransport Adapter (ICE + DTLS-SRTP)                          │
├──────────────────────────────────────────────────────────────────┤
│  Browser: RtcTransport API                                       │
└──────────────────────────────────────────────────────────────────┘
```

## Features

- **Unified app over a backend seam**: one app (`unified-app.ts`) coded only against a
  W3C-standard-shaped seam (`MediaBackend` / `RTCPeerConnectionLike`), runnable over the
  **native** `RTCPeerConnection` or the **proxy** shim via `?backend=native|proxy`.
- **WebRTC proxy over RtcTransport**: `RtcPeerConnectionShim` dresses the RtcTransport
  RTP/RTCP engine as an `RTCPeerConnection` (offer/answer, ICE, DTLS-SRTP, `ontrack`,
  `getStats`, renegotiation) and interoperates with native WebRTC peers.
- **In-app controls**: camera resolution, video codec, audio codec, and congestion-control
  algorithm are selectable in the UI and applied per call.
- **Multi-codec video**: VP8, VP9, H.264, HEVC, AV1 (with per-codec packetizer/depacketizer)
- **Multi-codec audio**: Opus, G.711 µ-law (PCMU), G.711 A-law (PCMA), AAC-LC
- **Congestion control**: AIMD and full GCC (RFC 8698) with delay-based + loss-based
  BWE; on the proxy backend it drives the video encoder's target bitrate from RTCP RR feedback.
- **Pacing**: Token-bucket pacer module with burst control, priority queues (audio > retransmit >
  video > FEC), and queue-driven rate opening (standalone module; not yet wired into the send path)
- **Error recovery**: NACK retransmission, PLI/FIR keyframe requests, and XOR-based FEC
  (RFC 5109) all wired into the proxy path (FEC is shim-to-shim only)
- **Jitter buffer**: Fixed-delay audio jitter buffer with reordering
- **Stats & graphs**: backend-agnostic numeric `getStats()` panel plus collapsible real-time
  graphs (send/recv bitrate, FPS, packet loss, jitter, frame size) over a 60s window
- **SDP builder/parser**: Structured SDP generation with per-codec fmtp, RTCP feedback,
  header extensions
- **Interoperability**: the same app calls native↔native, proxy↔proxy, and native↔proxy

## Prerequisites

1. **Node.js 18+** — for the build and the signaling/static server.

2. **Chrome with the RtcTransport API** — required only for the **proxy** backend, which is the
   default. `RtcTransport` is not shipped in stable Chrome, so you need a **custom Chromium
   build** that includes it, launched with the runtime flags:

   ```
   out\release_x64\chrome.exe ^
     --enable-features=RTCRtpTransport ^
     --enable-blink-features=RTCRtpTransport ^
     --unsafely-treat-insecure-origin-as-secure=http://localhost:8080 ^
     --user-data-dir=%TEMP%\rtc-test-profile
   ```

   The **native** backend (`?backend=native`) works in any modern Chrome (130+) with no flags —
   handy for testing the app or acting as the reference peer.

## Install

```bash
cd rtctransport-samples/webrtc-shim
npm install
npm run build:all      # builds BOTH the app (dist/unified.js) and server (dist/server.js)
```

> `npm run build` alone only bundles the app. The `start` script runs `dist/server.js`, so a
> fresh checkout must run `build:all` (or `start:dev`, which builds then serves) at least once.

## Start

```bash
npm run start          # serves http://localhost:8080  (signaling + static files)
# or, build + serve in one step:
npm run start:dev
# with full signaling logging (every offer/answer/candidate relayed):
npm run start:verbose
```

Open two tabs on `http://localhost:8080/` and pick a backend per tab:

- `http://localhost:8080/` or `?backend=proxy` — **WebRTC Proxy over RtcTransport** (default)
- `http://localhost:8080/?backend=native` — the same app on native WebRTC

Both join the same room (`test-room` by default); the **second** tab to join initiates the call.
The proxy backend requires the RtcTransport flags and custom Chrome build (see Prerequisites);
the native backend runs anywhere. See [Testing](#testing) for the full procedure.

### Signaling & logging

- **Server** logs `User joined` / `User gone` (with room and occupancy) and full-room join
  rejections. Verbose mode (`--verbose`, `-v`, or `VERBOSE=1`, e.g. `npm run start:verbose`)
  additionally logs every relayed message — offer/answer (SDP size), ICE candidates, room
  create/delete, and WebSocket open/close.
- **Client** logs each exchanged **offer/answer SDP** (summary + full SDP) and every **ICE
  candidate** (sent and received) to the on-screen log panel and the browser console.

## Build Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Bundle the unified app → `dist/unified.js` |
| `npm run build:server` | Bundle server TypeScript → `dist/server.js` |
| `npm run build:all` | Build the app **and** the server (use this first) |
| `npm run typecheck` | Type-check with `tsc --noEmit` |
| `npm test` | Build & run the error-recovery test suite (NACK/PLI/FIR/FEC) |
| `npm run start` | Run the signaling + static server (port 8080) |
| `npm run start:dev` | `build:all` then start the server |
| `npm run start:verbose` | Start the server with verbose signaling logging |
| `npm run watch` | Rebuild the app on change |

## Project Structure

```
rtctransport-samples/webrtc-shim/
├── index.html                    # Unified app UI (served at /)
├── server.ts                     # WebSocket signaling + static HTTP server
├── package.json
├── tsconfig.json
├── src/
│   ├── unified-app.ts            # Unified app (coded against the backend seam)
│   ├── call-state-machine.ts     # JSEP-inspired state machine
│   ├── signaling.ts              # WebSocket signaling client
│   ├── webrtc/                   # Backend seam + proxy shim
│   │   ├── types.ts              # MediaBackend / RTCPeerConnectionLike / CallPreferences
│   │   ├── index.ts              # Backend factory + ?backend= resolver
│   │   ├── native-backend.ts     # window.RTCPeerConnection backend
│   │   ├── proxy-backend.ts      # RtcTransport-shim backend
│   │   └── rtc-peer-connection-shim.ts  # RTCPeerConnection over RtcTransport
│   ├── rtp/
│   │   ├── rtp-packet.ts         # RTP parser/serializer (RFC 3550)
│   │   ├── rtcp-packet.ts        # RTCP SR/RR/BYE (RFC 3550 §6)
│   │   └── rtp-session.ts        # Session management (SSRC, seq, stats)
│   ├── codec/
│   │   ├── index.ts              # Codec registry (VIDEO_CODECS, AUDIO_CODECS)
│   │   ├── opus-packetizer.ts    # Opus RTP (RFC 7587)
│   │   ├── depacketizer.ts       # Base depacketizer interface
│   │   ├── vp8-packetizer.ts     # VP8 RTP (RFC 7741)
│   │   ├── vp9-packetizer.ts     # VP9 RTP
│   │   ├── h264-packetizer.ts    # H.264 RTP (RFC 6184, FU-A)
│   │   ├── hevc-packetizer.ts    # HEVC RTP (RFC 7798)
│   │   ├── av1-packetizer.ts     # AV1 RTP
│   │   ├── g711-packetizer.ts    # G.711 µ-law/A-law
│   │   └── aac-packetizer.ts     # AAC-LC (RFC 3640)
│   ├── cc/
│   │   ├── index.ts              # createCongestionController factory
│   │   ├── congestion-controller.ts  # Shared CC contract (interface + options)
│   │   ├── aimd/                 # AIMD algorithm (the "simple" reference)
│   │   │   ├── index.ts              # AimdCongestionController
│   │   │   ├── aimd-rate-control.ts  # AIMD increase/decrease loop
│   │   │   ├── overuse-detector.ts   # Delay overuse detection
│   │   │   └── bandwidth-estimator.ts  # Delay + loss bandwidth estimate
│   │   └── gcc/                  # Google Congestion Control (RFC 8698)
│   │       ├── index.ts                # GccCongestionController
│   │       ├── gcc-controller.ts       # Full GCC pipeline
│   │       ├── inter-arrival.ts        # Packet grouping (5ms burst)
│   │       ├── trendline-estimator.ts  # Linear regression delay detection
│   │       ├── aimd-rate-control.ts    # Hold/Increase/Decrease FSM
│   │       ├── loss-based-bwe.ts       # Loss-based bandwidth estimation
│   │       └── acknowledged-bitrate-estimator.ts
│   ├── transport/
│   │   ├── rtc-transport-adapter.ts  # RtcTransport API wrapper
│   │   └── pacer.ts              # Token-bucket pacer with priority queues
│   ├── media/
│   │   ├── video-capture.ts       # getUserMedia + WebCodecs encoder
│   │   ├── video-playback.ts      # WebCodecs decoder + canvas rendering
│   │   ├── audio-capture.ts       # Audio capture + encoding
│   │   ├── audio-playback.ts      # Web Audio API playback
│   │   └── jitter-buffer.ts       # Fixed-delay audio jitter buffer
│   ├── sdp/
│   │   ├── sdp-parser.ts         # SDP parsing (single + multi-section)
│   │   └── sdp-builder.ts        # Structured SDP builder (codecs, fmtp, RTCP-FB)
│   ├── types/
│   │   └── rtc-transport.d.ts    # Full W3C RtcTransport API type declarations
│   └── recovery/
│       ├── index.ts               # Recovery module exports
│       ├── nack-handler.ts        # NACK gap detection + retransmission (RFC 4585)
│       ├── keyframe-request.ts    # PLI/FIR keyframe requests (RFC 4585/5104)
│       └── fec.ts                 # XOR-based FEC encoder/decoder (RFC 5109)
├── test/
│   └── recovery.test.ts           # NACK/PLI/FIR/FEC unit + integration tests (npm test)
└── dist/                          # Built output (generated)
```

### Folder-by-folder guide

Each `src/` folder is one layer of the media stack. "Component types" lists the kind of exports
you find there (classes, interfaces/types, or pure functions).

| Folder / file | Functionality | Component types |
|---------------|---------------|-----------------|
| `unified-app.ts` | Application entry point. Drives capture, join/hangup, mute, camera on/off, renegotiation, the stats panel, and the graphs — coded **only** against the backend seam. | Top-level module (DOM wiring + async functions) |
| `call-state-machine.ts` | JSEP-inspired call lifecycle (`idle → offering/answering → connecting → connected → closed`). | State-machine class + state enums |
| `signaling.ts` | WebSocket signaling client: room join, offer/answer/candidate relay. | `SignalingChannel` class + message types |
| `webrtc/` | **Backend seam + proxy shim.** Defines the W3C-shaped seam and both implementations; `rtc-peer-connection-shim.ts` is the `RTCPeerConnection` re-implementation over RtcTransport. | Interfaces (`MediaBackend`, `RTCPeerConnectionLike`, `CallPreferences`, `BackendKind`), classes (`NativeBackend`, `ProxyBackend`, `RtcPeerConnectionShim`), factory (`createBackend`, `resolveBackendKind`) |
| `rtp/` | RTP/RTCP wire format and session state (SSRC, sequence numbers, timestamps, stats). | Packet classes/parsers (`RtpPacket`, `RtcpPacket`), `RtpSession`/`RtpSendStream` classes |
| `codec/` | Per-codec RTP packetizers/depacketizers plus a codec registry mapping names ↔ payload types ↔ WebCodecs ids. | Packetizer/depacketizer classes, `CodecInfo` types, registry + lookup functions |
| `cc/` | **Congestion Control** — bandwidth estimation. Mirrored `aimd/` and `gcc/` algorithms behind one contract; `index.ts` is the factory. | `CongestionController` interface, controller classes, estimators, `createCongestionController` factory |
| `transport/` | The RtcTransport API wrapper and the send-side pacer (token-bucket, priority queues). | `RtcTransportAdapter`, `Pacer` classes |
| `media/` | Capture and playback bridges to WebCodecs / Web Audio, plus the jitter buffer. | Capture/playback classes, `JitterBuffer` class |
| `sdp/` | SDP offer/answer generation and parsing (codecs, fmtp, RTCP-FB, header extensions, ICE/DTLS params). | `SdpBuilder`/`SdpParser` (functions + structured types) |
| `recovery/` | **Error recovery** — NACK retransmission, PLI/FIR keyframe requests, XOR FEC — all wired into the proxy shim and covered by `npm test`. | Handler classes (`NackHandler`, keyframe-request, FEC encoder/decoder) |
| `types/` | Ambient TypeScript declarations for the W3C `RtcTransport` API (not shipped in `lib.dom`). | `.d.ts` type declarations only |

The layering (top → bottom): **unified-app → backend seam → RTP/RTCP + codecs → pacer →
congestion control → RtcTransport adapter → browser RtcTransport**, with `media/`, `sdp/`,
and `recovery/` as cross-cutting helpers. This mirrors the ASCII diagram in
[Architecture](#architecture).

## Unified App & Backend Seam

The unified app is written **only** against a minimal, W3C-standard-shaped seam so the same
code path drives both transports:

- **`MediaBackend`** — produces media streams and peer connections. Two implementations:
  `NativeBackend` (delegates to `navigator.mediaDevices` + `window.RTCPeerConnection`) and
  `ProxyBackend` (produces `RtcPeerConnectionShim` instances).
- **`RTCPeerConnectionLike`** — the subset of `RTCPeerConnection` the app uses (`addTrack`,
  `createOffer/Answer`, `setLocal/RemoteDescription`, `addIceCandidate`, `ontrack`,
  `getStats`, lifecycle/state). A real `RTCPeerConnection` structurally satisfies it, so the
  native backend needs no wrapper — it is the conformance oracle the proxy is measured against.
- **`CallPreferences`** — plain primitives (video codec, audio codec, CC algorithm) passed to
  `createPeerConnection`. Engine types never cross the seam.

Backend selection is via `?backend=native|proxy` (default `proxy`).

### In-app controls

The settings row applies per call:

| Control | Native backend | Proxy backend |
|---------|----------------|---------------|
| **Camera resolution** | `getUserMedia` constraints | `getUserMedia` constraints (feeds the WebCodecs encoder) |
| **Video codec** | standard `setCodecPreferences` on the transceiver | orders the shim's supported-codec list (VP8/VP9/H.264/HEVC/AV1) |
| **Audio codec** | standard `setCodecPreferences` (Opus/G.711; AAC falls back to default) | Opus / PCMU / PCMA / AAC-LC; AAC option auto-disables when WebCodecs cannot encode it |
| **Congestion control** | browser-managed | selects the controller (AIMD/GCC) driving the encoder's target bitrate from RTCP RR |

### Stats & graphs

`getStats()` returns the same standard `outbound-rtp` / `inbound-rtp` / `transport` entries on
both backends, rendered as a numeric panel. A collapsible **Graphs** panel (collapsed by
default) plots send/recv bitrate, FPS, packet loss, jitter, and frame size over a 60-second
rolling window, computed from the same standard fields.

## Testing

### 1. Build and serve

```bash
cd rtctransport-samples/webrtc-shim
npm install
npm run build:all
npm run start          # serves http://localhost:8080
```

The server serves static files fresh from disk; only `server.ts` changes require a rebuild
(`npm run build:server`) and restart. App changes need `npm run build` (or `npm run watch`).

### 2. Launch the custom Chrome build with RtcTransport flags

The proxy backend needs the RtcTransport API, exposed only in the custom build with flags:

```
out\release_x64\chrome.exe ^
  --enable-features=RTCRtpTransport ^
  --enable-blink-features=RTCRtpTransport ^
  --unsafely-treat-insecure-origin-as-secure=http://localhost:8080 ^
  --user-data-dir=%TEMP%\rtc-test-profile
```

The native backend works in any modern Chrome; the flags are only required for `?backend=proxy`.

### 3. Run a call

The default path is **proxy↔proxy** (just open `http://localhost:8080/` in both tabs). To test
interop against native WebRTC:

1. Open `http://localhost:8080/?backend=native` in one tab (the reference peer).
2. Open `http://localhost:8080/` (proxy, default) in a second tab. Opening the proxy tab
   **second** makes it the offerer, which gives the shim clean SDP control.
3. Optionally pick a resolution / codec / CC algorithm in each tab before joining.
4. Click **Join & Call** in both. You should see local + remote video and hear audio both ways.

### 4. Exercise the controls

- **Mute mic** toggles the audio track (meters prove send/receive direction).
- **Camera off/on** renegotiates via `replaceTrack` + a fresh offer/answer round-trip.
- Expand **Graphs** to watch bitrate/FPS/loss/jitter live.

### Combinations to try

`native↔native`, `proxy↔proxy`, and `native↔proxy` — the same app drives all three.

### Automated tests & logging

- **Recovery test suite:** `npm test` bundles and runs `test/recovery.test.ts`, asserting NACK
  generate/parse + retransmit, PLI/FIR framing/callbacks/throttling, and XOR FEC single-loss
  recovery (including the shim's whole-RTP-packet round-trip). No browser required.
- **Signaling tracing:** run the server with `npm run start:verbose` to log every relayed
  offer/answer/candidate. In each browser tab, the exchanged SDPs and ICE candidates are
  printed to the on-screen log panel and the console — handy for diagnosing negotiation and
  the shim-to-shim `a=x-shim-fec` FEC handshake.

## WebRTC Proxy over RtcTransport — Roadmap

The proxy shim was built in phases; all are implemented and verified:

| Phase | Scope | Status |
|-------|-------|--------|
| **0** | Backend seam (`MediaBackend` / `RTCPeerConnectionLike`), native backend as oracle | ✅ |
| **1** | Outbound audio (Opus) over a proven RtcTransport interop path | ✅ |
| **2** | Bidirectional audio: inbound RTP reordered (jitter buffer), decoded, resynthesized via `MediaStreamTrackGenerator`, surfaced through `ontrack` | ✅ |
| **3** | Video + real codec negotiation: offer advertises supported codecs, answer adopts the remote payload type; WebCodecs encode/packetize/pace; inbound PLI → keyframe | ✅ |
| **4** | Spec-shaped `getStats()` (`outbound-rtp`/`inbound-rtp`/`transport`) readable identically on both backends | ✅ |
| **5** | Renegotiation + full compatibility: `replaceTrack`, camera on/off, stable DTLS role across renegotiations, per-track send pipelines | ✅ |

Remaining browser-side work (native `RtcTransport` spec extensions such as
`getPacketSentInfo()`, `onpendingpacketssentinfo`/`onpendingpacketsreceived`, and
`RtcPacketSentInfo`) is tracked under [Further Steps: Spec Gaps](#further-steps-spec-gaps).

## Congestion Control (CC) vs Rate Control (RC)

These are two distinct stages, and it helps to keep them separate:

- **Congestion Control (CC)** *estimates the available network bandwidth.* It
  consumes transport signals (per-packet send/ack timing, RTCP receiver-report
  loss) and produces a single **target send bitrate**. Lives in `src/cc/`.
- **Rate Control (RC)** *applies that target to the media encoder.* On the proxy
  backend the shim runs a periodic CC loop (`_startCcLoop`, every 1s in
  `rtc-peer-connection-shim.ts`) that reads `cc.getTargetBitrateBps()`, clamps it
  to the video min/max, and reconfigures the WebCodecs `VideoEncoder` bitrate.

So the flow is: **CC estimates bandwidth → RC drives the encoder to that bitrate.**

The **CC algorithm selected in the UI is the one that drives encoder RC** on the
proxy backend. On the native backend, congestion control and rate control are
both handled internally by the browser's built-in WebRTC (GCC) — the selector
and the JS `cc/` code are not involved.

The `cc/` folder keeps the two algorithms cleanly separated in mirrored
sub-folders, both implementing the shared `CongestionController` contract in
`cc/congestion-controller.ts`; `cc/index.ts` only exposes the
`createCongestionController` factory:

### AIMD (`cc/aimd/`)
The "simple" reference controller. A delay-based overuse detector plus a
loss-based estimate feed a classic **A**dditive **I**ncrease /
**M**ultiplicative **D**ecrease loop: in the NORMAL state the rate grows
additively (+8 kbps/s), and on overuse/loss it drops multiplicatively
(β=0.85), with a ~1 s cooldown between decreases to avoid oscillation.

### GCC (`cc/gcc/`, RFC 8698)
Full Google Congestion Control implementation matching the WebRTC native code:
- **InterArrivalDelta**: 5ms burst grouping, reordering detection
- **TrendlineEstimator**: Smoothed delay with linear regression, adaptive threshold
- **GccAimdRateControl**: Multiplicative increase near unknown capacity, additive near max
- **LossBasedBwe**: 2% low / 10% high thresholds, RTT backoff at 300ms
- **AcknowledgedBitrateEstimator**: Throughput from ACK feedback

> Note: both algorithms use an AIMD *rate-control step* internally, but they are
> separate classes — `cc/aimd/aimd-rate-control.ts` (`AimdRateControl`) for the
> simple controller and `cc/gcc/aimd-rate-control.ts` (`GccAimdRateControl`) as
> one stage inside GCC.

## Pacing

A token-bucket pacer modeled on WebRTC's `PacingController`
(`modules/pacing/pacing_controller.cc`) is implemented as a standalone module
(`src/transport/pacer.ts`, class `Pacer`). It provides:

- **Debt-based gating**: Media debt accumulates when packets are sent (proportional to
  packet size and inversely proportional to pacing rate). Debt drains over time.
- **Burst control**: Maximum 63KB burst per interval (`MAX_BURST_BYTES = 63_000`, matching
  WebRTC constants).
- **5-level priority queues**: Audio > Retransmission > Video > FEC > Padding.
- **Audio fast path**: Audio packets bypass the pacer when media debt < 1ms (unpaced, per WebRTC design).
- **Queue-driven rate boost**: When the queue backs up, the effective rate is boosted up to
  2.5× (`_pacingRateBps * 2.5`) to drain the backlog.
- **Rate input**: `setPacingRate(bps)` is intended to be driven from the CC target bitrate.

> **Status:** the pacer is a complete, unit-testable module but is **not yet wired into the
> proxy send path** — the current proxy applies congestion control at the encoder (see
> [CC vs RC](#congestion-control-cc-vs-rate-control-rc)) and sends packets directly. Wiring the
> pacer between packetization and `sendPackets()` is tracked under Further Steps.

## Error Recovery

The `recovery/` folder implements the mechanisms below, all now wired into the live proxy
send/receive path in `RtcPeerConnectionShim`. **NACK, PLI, and FIR** are standard RTCP and
interoperate with native WebRTC peers; **XOR FEC** uses a non-standard shim-to-shim format,
so it activates only when both peers are the shim (negotiated via an `a=x-shim-fec:<pt>` SDP
attribute that native peers ignore). All four are covered by the `npm test` suite.

| Mechanism | Description | Status in proxy path |
|-----------|-------------|----------------------|
| **PLI** (RFC 4585) | Picture Loss Indication — inbound PLI forces the encoder to emit a keyframe; the receiver sends a PLI until it gets its first keyframe. | ✅ wired |
| **FIR** (RFC 5104) | Full Intra Request — stronger keyframe request with sequence numbering; the receiver escalates from NACK to FIR on burst loss, and an inbound FIR forces a fresh keyframe. | ✅ wired |
| **NACK** (RFC 4585) | Detects sequence-number gaps and requests retransmission via RTCP RTPFB; sent packets are buffered and re-sent when a NACK arrives. | ✅ wired |
| **XOR FEC** (RFC 5109) | Groups of video packets protected by 1 FEC packet (~20% overhead); single-loss recovery via XOR. Shim-to-shim only (`a=x-shim-fec`). | ✅ wired (shim↔shim) |

Recovery counters (`nackCount`, `pliCount`, `firCount`, `retransmittedPacketsSent`,
`packetsRecoveredByNack`, `fecPacketsSent`/`fecPacketsReceived`, `packetsRecoveredByFec`) are
exposed through the shim's `getStats()`.

### Testing

Run the recovery unit/integration suite:

```bash
npm test
```

It bundles `test/recovery.test.ts` with esbuild and runs it under Node, asserting NACK
generate/parse + retransmit, PLI/FIR framing + keyframe callbacks + throttling, and FEC
single-loss recovery (including the shim's whole-RTP-packet protection round-trip).

## Standards Implemented

| RFC | Description |
|-----|-------------|
| [RFC 3550](https://tools.ietf.org/html/rfc3550) | RTP/RTCP base protocol |
| [RFC 3640](https://tools.ietf.org/html/rfc3640) | AAC-LC RTP Payload |
| [RFC 4585](https://tools.ietf.org/html/rfc4585) | RTCP Feedback (NACK, PLI) |
| [RFC 5104](https://tools.ietf.org/html/rfc5104) | Full Intra Request (FIR) |
| [RFC 5109](https://tools.ietf.org/html/rfc5109) | ULP Forward Error Correction |
| [RFC 6184](https://tools.ietf.org/html/rfc6184) | H.264 RTP Packetization (FU-A) |
| [RFC 7587](https://tools.ietf.org/html/rfc7587) | Opus in RTP |
| [RFC 7741](https://tools.ietf.org/html/rfc7741) | VP8 RTP Packetization |
| [RFC 7798](https://tools.ietf.org/html/rfc7798) | HEVC RTP Packetization |
| [RFC 8698](https://tools.ietf.org/html/rfc8698) | GCC Congestion Control |
| [RFC 8829](https://tools.ietf.org/html/rfc8829) | JSEP (concepts) |
| [W3C RtcTransport](https://w3c.github.io/webrtc-rtptransport/) | Transport API |

## RTP Payload Type Assignments

| PT | Codec |
|----|-------|
| 0 | G.711 µ-law (PCMU) |
| 8 | G.711 A-law (PCMA) |
| 35 | AV1 |
| 96 | VP8 |
| 97 | AAC-LC |
| 98 | VP9 |
| 102 | H.264 |
| 104 | HEVC |
| 111 | Opus |

## Chromium Implementation Details

### Architecture: Browser ↔ Application Boundary

The `RtcTransport` browser API is implemented in Chromium's Blink renderer at
`third_party/blink/renderer/modules/peerconnection/rtc_transport/`. The core networking
is handled by WebRTC's `DatagramConnectionInternal` at `third_party/webrtc/pc/`.

```
┌──────────────────────────────────────────────────────────────────────┐
│  JavaScript Application (this project)                               │
│  ┌─ sendPackets() ──────────── getReceivedPackets() ──────────────┐  │
└──┼────────────────────────────────────────────────────────────────┼──┘
   │                     Blink IDL Bindings                         │
┌──┼────────────────────────────────────────────────────────────────┼──┐
│  ▼  RtcTransport (Blink, main thread)                             ▲  │
│  │   • Queues packets in pending buffers until initialized        │  │
│  │   • Dispatches events: onicecandidate, onwritablechange,       │  │
│  │     onpendingpacketsreceived, onpendingpacketssentinfo         │  │
│  └─→ AsyncDatagramConnection (cross-thread adapter) ──────────────┘  │
│       • PostCrossThreadTask to move between main ↔ network thread    │
├──────────────────────────────────────────────────────────────────────┤
│  DatagramConnectionInternal (WebRTC, network thread)                 │
│  ┌── P2PTransportChannel (ICE) ──────────────────────────────────┐   │
│  │   • STUN/TURN, candidate gathering, connectivity checks       │   │
│  ├── DtlsTransportInternal ──────────────────────────────────────┤   │
│  │   • DTLS handshake, certificate verification                  │   │
│  ├── DtlsSrtpTransport (when wireProtocol = 'dtls-srtp') ────────┤   │
│  │   • SRTP key derivation from DTLS, encrypt/decrypt RTP/RTCP   │   │
│  └───────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### Wire Protocol Modes

The `DatagramConnection` supports two wire protocols:

| Mode | Config value | Encryption | Packet handling |
|------|-------------|------------|-----------------|
| **DTLS-SRTP** | `'dtls-srtp'` | SRTP for RTP/RTCP, DTLS for non-RTP | Demuxes RTP vs RTCP by payload type, applies SRTP encryption/decryption transparently |
| **DTLS** | `'dtls'` | All packets wrapped in DTLS | Raw byte-level, no protocol awareness |

This project uses **DTLS-SRTP mode** because it is compatible with standard WebRTC
peers. In this mode, the browser:
1. Detects whether a packet looks like RTP/RTCP (checks version bits and PT range)
2. If RTP/RTCP → routes through `DtlsSrtpTransport` for SRTP encryption
3. If not RTP/RTCP → wraps in a raw DTLS record

The application sends **unencrypted RTP/RTCP packets** via `sendPackets()`. SRTP
encryption (AES-128-CM + HMAC-SHA1) is handled transparently by the browser. Received
packets arrive already decrypted.

### Channel Establishment Sequence

```
 Offerer (iceControlling: true)          Answerer (iceControlling: false)
 ──────────────────────────────          ──────────────────────────────────
 1. new RtcTransport(config)             1. new RtcTransport(config)
    → generates local certificate            → generates local certificate
    → starts ICE candidate gathering         → starts ICE candidate gathering

 2. onicecandidate fires                 2. onicecandidate fires
    → extract iceUfrag, icePassword          → extract iceUfrag, icePassword
    → read fingerprint + algorithm           → read fingerprint + algorithm

 3. Build SDP offer with:               
    ice-ufrag, ice-pwd, fingerprint      
    → send via signaling ──────────────→ 4. Parse remote SDP
                                            → addRemoteCandidate() for each
                                            → setRemoteDtlsParameters({
                                                sslRole: 'client',
                                                fingerprint, algorithm
                                              })

                                         5. Build SDP answer
 6. Parse remote answer                     → send via signaling
    → addRemoteCandidate()          ←──────
    → setRemoteDtlsParameters({
        sslRole: 'server',
        fingerprint, algorithm
      })

 7. ICE connectivity checks complete (STUN binding requests)
 8. DTLS handshake completes (offerer = server, answerer = client)
 9. SRTP keys derived from DTLS master secret (RFC 5764)
10. onwritablechange fires → transport ready for sendPackets()
```

### DTLS and Key Exchange

The DTLS handshake is the mechanism for authenticated key agreement:

1. **Certificate generation**: Each `RtcTransport` instance generates a self-signed
   ECDSA certificate at construction time. The certificate fingerprint (SHA-256 by
   default) is exposed via `transport.fingerprint` and
   `transport.fingerprintDigestAlgorithm`.

2. **Fingerprint exchange via SDP**: Fingerprints are exchanged in the SDP offer/answer
   as `a=fingerprint:sha-256 XX:XX:...` lines. This is the trust anchor — each side
   verifies the remote certificate against the received fingerprint.

3. **DTLS roles**: The `sslRole` parameter in `setRemoteDtlsParameters()` determines
   which side initiates the DTLS handshake:
   - **`'server'`** = wait for ClientHello (offerer, `a=setup:actpass` in SDP)
   - **`'client'`** = send ClientHello (answerer, `a=setup:active` in SDP)

4. **SRTP key derivation**: After DTLS completes, SRTP master keys are extracted using
   the DTLS-SRTP extension (RFC 5764). The `DtlsSrtpTransport` then uses these keys
   for all subsequent RTP/RTCP encryption.

### ICE Credential Handling

ICE credentials (`ufrag` and `pwd`) are generated internally by the `P2PTransportChannel`:
- Random string of 4 characters for `ufrag`, 22 characters for `pwd`
- Exposed to JavaScript via the first `onicecandidate` event's `usernameFragment`
  and `password` fields
- Must be communicated to the remote side (we embed them in SDP as `a=ice-ufrag` / `a=ice-pwd`)
- Remote credentials are set implicitly when candidates arrive with matching ufrag/pwd
  (the Chromium implementation calls `SetRemoteIceParameters` internally)

### Packet Receive Model

The current Chromium implementation uses a **polling model** rather than event-driven
delivery for received packets:
- `onpendingpacketsreceived` fires to notify the app that packets are available
- App calls `getReceivedPackets()` to drain the buffer
- Our adapter polls every 5ms as a fallback (some Chrome versions don't fire the event)

The `onpendingpacketssentinfo` event notifies when send outcome data is available,
retrieved via `getPacketSentInfo()` (provides `send_time` and `bytes_sent` for
congestion control feedback).

## Further Steps: Spec Gaps

The current Chromium implementation is a **partial prototype**. Key features missing
for a complete W3C RtcTransport spec implementation:

| Missing Feature | Spec Reference | Impact |
|----------------|----------------|--------|
| **Scheduled send times** | `RtcPacketToSend.sendTime` | Cannot do precise pacing or probing at the transport layer |
| **Network route control** | `RtcNetworkRouteController`, `RtcManualIceController` | No programmatic control over ICE candidate selection |
| **ECN/L4S marking** | `RtcPacketReceived.ecnMarking` | Cannot implement L4S-aware congestion control |
| **Circuit breaker** | `ontransportstatus` event | No built-in safety against unresponsive CC |
| **Wire format negotiation** | `setFormat()`, `supportedFormats` | Currently hardcoded to DTLS-SRTP |
| **Worker support** | `[Exposed=Window,Worker]` | Cannot run packet processing off main thread |
| **Bring Your Own Buffer** | BYOB read/write | Extra copies on every packet |
| **Multiple network routes** | `sendPackets(packets, route)` | Cannot implement path redundancy or multihoming |
| **Feedback piggybacking** | `onfeedbacksent` | No protocol-level CC feedback from browser |
| **Error/overflow events** | `onerror` for buffer overflows | Silent packet loss on overflow |

### What would "full spec" unlock:

- **Sub-millisecond pacing** via `sendTime` (currently done with `setTimeout` in JS)
- **ICE candidate pair probing** for quality-aware route selection
- **Off-main-thread processing** in Workers for high-bitrate streams
- **Zero-copy packet handling** reducing GC pressure at high packet rates

### Application-side (JS stack) next steps

Independent of the browser spec, these modules exist but are **not yet wired into the live
`RtcPeerConnectionShim` send/receive path**:

- **Pacer integration** — insert `transport/pacer.ts` between packetization and
  `sendPackets()`, driven by the CC target bitrate.
- **Transport-cc / abs-send-time** — richer per-packet feedback for the CC once
  `getPacketSentInfo()` lands in the browser.

NACK retransmission, PLI/FIR keyframe requests, and XOR FEC are now wired into the shim (see
[Error Recovery](#error-recovery)).

## Use Cases Enabled by RtcTransport

RtcTransport opens use cases that are **not viable with standard WebRTC** due to the
opaque nature of `RTCPeerConnection`:

### 1. Custom ML-Based Audio Codecs
Train a neural audio codec (e.g., [Lyra](https://github.com/google/lyra),
[Encodec](https://github.com/facebookresearch/encodec)) in WASM/WebGPU,
packetize the output yourself, and implement codec-specific error concealment.
WebRTC only supports Opus/G.711 — you cannot inject a custom codec without
RtcTransport.

### 2. Custom Packetization for AR/VR Metadata
AR/VR applications require streaming large metadata (spatial anchors, mesh updates,
hand tracking) alongside video. With RtcTransport you can:
- Design custom packetization optimized for your metadata format
- Implement priority-based dropping (drop old spatial anchors, keep latest)
- Use application-specific FEC tuned to your data characteristics

### 3. Game Streaming with Per-Frame QP Control
Cloud gaming requires ultra-low latency rate control. With RtcTransport + WebCodecs:
- Set QP per-frame based on frame complexity and bandwidth estimate
- React to bandwidth changes within a single frame (not waiting for the next keyframe)
- Implement custom intra-refresh patterns instead of full IDRs

### 4. SFU Packet Forwarding (Selective Forwarding Unit)
Build a JavaScript-based SFU that:
- Receives RTP packets from one `RtcTransport`
- Inspects headers (without decrypting payload — in DTLS mode)
- Forwards to other `RtcTransport` connections with modified headers
- Implements simulcast layer switching at the packet level

### 5. Custom Congestion Control Algorithms
Research and deploy novel CC algorithms (e.g., [Copa](https://web.mit.edu/copa/),
[BBRv2](https://datatracker.ietf.org/doc/draft-cardwell-iccrg-bbr-congestion-control/),
deep-RL-based controllers) that are impossible with WebRTC's built-in GCC:
- Full access to per-packet send/receive timestamps
- `getPacketSentInfo()` provides exact network-level timing
- No interference from the browser's internal rate controller

### 6. Custom RTCP Messages (LRR, RPSI, SLI)
WebRTC implementations don't support advanced feedback like:
- **LRR** (Layer Refresh Request) for SVC layer switching
- **RPSI** (Reference Picture Selection Indication) for advanced error recovery
- **SLI** (Slice Loss Indication) for partial frame recovery
- **RTCP-XR** extended statistics

With RtcTransport, you construct and send any RTCP message format.

### 7. Low-Latency Live Streaming with P2P Fanout
Build a mesh/tree overlay network for live streaming:
- Each viewer receives from multiple peers (redundancy)
- Viewers re-stream to downstream peers (fanout)
- Application-level packet scheduling and prioritization
- Custom ABR (Adaptive Bitrate) logic per viewer connection

### 8. Protocol Research and Experimentation
RtcTransport is ideal for researching new real-time protocols:
- Test new congestion control signals (delay gradient, ECN, etc.)
- Experiment with novel FEC schemes (Reed-Solomon, fountain codes)
- Prototype new RTP extensions before standardizing
- Compare approaches in controlled A/B tests in production

## References

- [W3C RtcTransport Spec](https://w3c.github.io/webrtc-rtptransport/)
- [RtcTransport Explainer](https://github.com/w3c/webrtc-rtptransport/blob/main/explainer.md)
- [API Outline](https://github.com/w3c/webrtc-rtptransport/blob/main/api-outline.md)
- [WebRTC Extended Use Cases](https://www.w3.org/TR/webrtc-nv-use-cases/)
- [Chromium Source: RtcTransport](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/modules/peerconnection/rtc_transport/)
- [WebRTC Source: DatagramConnection](https://source.chromium.org/chromium/chromium/src/+/main:third_party/webrtc/pc/datagram_connection_internal.h)
