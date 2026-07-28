# RtcTransport WebRTC Sample

A TypeScript-based WebRTC application implementing a full RTP/RTCP media stack on top of the
low-level `RtcTransport` browser API ([W3C spec](https://w3c.github.io/webrtc-rtptransport/)).

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Application (main.ts)                                            │
├──────────────────────────────────────────────────────────────────┤
│  Call State Machine │ Signaling │ SDP Builder/Parser              │
├──────────────────────────────────────────────────────────────────┤
│  Video/Audio Capture │ Multi-codec Packetizers │ Enhanced Pacer   │
├──────────────────────────────────────────────────────────────────┤
│  Congestion Control (Simple AIMD / GCC RFC 8698)                 │
├──────────────────────────────────────────────────────────────────┤
│  RTP/RTCP Stack │ NACK/PLI/FIR │ Transport-CC │ RTX              │
├──────────────────────────────────────────────────────────────────┤
│  RtcTransport Adapter (ICE + DTLS-SRTP)                          │
├──────────────────────────────────────────────────────────────────┤
│  Browser: RtcTransport API                                        │
└──────────────────────────────────────────────────────────────────┘
```

## Features

- **Multi-codec video**: VP8, VP9, H.264, HEVC, AV1 (with per-codec packetizer/depacketizer)
- **Multi-codec audio**: Opus, G.711 µ-law (PCMU), G.711 A-law (PCMA)
- **Congestion control**: Simple AIMD and full GCC (RFC 8698) with delay-based + loss-based BWE
- **Error recovery**: NACK, RTX retransmission, PLI/FIR keyframe requests
- **Adaptive jitter buffer**: NetEQ-inspired audio buffering
- **Stats & graphs**: Real-time bitrate, QP, jitter, packet loss graphs (inspired by webrtc-internals)
- **Interoperability**: Communicates with standard RTCPeerConnection peers

## Prerequisites

1. **Chrome with RtcTransport flag enabled:**
   ```
   chrome --enable-features=RTCRtpTransport \
          --enable-blink-features=RTCRtpTransport \
          --unsafely-treat-insecure-origin-as-secure=http://localhost:8080
   ```

2. **Node.js 18+** for build and signaling server

## Quick Start

```bash
cd rtctransport-sample
npm install
npm run build
npm run start
```

Then open:
- `http://localhost:8080/` — RtcTransport client
- `http://localhost:8080/peer_connection.html` — Standard RTCPeerConnection peer

Both join the same room ("test-room" by default), then either side initiates the call.

## Build Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Bundle client TypeScript → `dist/main.js` |
| `npm run build:server` | Bundle server TypeScript → `dist/server.js` |
| `npm run typecheck` | Type-check with `tsc --noEmit` |
| `npm run start` | Run the server (port 8080) |

## Project Structure

```
rtctransport-sample/
├── index.html                    # RtcTransport client UI
├── peer_connection.html          # Standard RTCPeerConnection peer
├── server.ts                     # WebSocket signaling + static HTTP server
├── package.json
├── tsconfig.json
├── src/
│   ├── main.ts                   # Application entry point
│   ├── call-state-machine.ts     # JSEP-inspired state machine
│   ├── signaling.ts              # WebSocket signaling client
│   ├── types/
│   │   ├── rtc-transport.d.ts    # Full W3C RtcTransport spec types
│   │   └── global.d.ts           # Browser API type declarations
│   ├── rtp/
│   │   ├── rtp-packet.ts         # RTP parser/serializer (RFC 3550)
│   │   ├── rtcp-packet.ts        # RTCP SR/RR/SDES (RFC 3550 §6)
│   │   ├── rtcp-feedback.ts      # NACK, PLI, FIR (RFC 4585)
│   │   ├── transport-cc.ts       # Transport-wide CC feedback (RFC 8888)
│   │   ├── header-extensions.ts  # RTP header extensions (RFC 5285)
│   │   ├── rtp-session.ts        # Session management (SSRC, seq, stats)
│   │   └── rtx.ts               # Retransmission (RFC 4588)
│   ├── codec/
│   │   ├── index.ts              # Codec registry (VIDEO_CODECS, AUDIO_CODECS)
│   │   ├── vp8-packetizer.ts / vp8-depacketizer.ts
│   │   ├── vp9-packetizer.ts / vp9-depacketizer.ts
│   │   ├── h264-packetizer.ts / h264-depacketizer.ts
│   │   ├── hevc-packetizer.ts / hevc-depacketizer.ts
│   │   ├── av1-packetizer.ts / av1-depacketizer.ts
│   │   ├── opus-packetizer.ts / opus-depacketizer.ts
│   │   └── g711-codec.ts        # G.711 µ-law/A-law
│   ├── cc/
│   │   ├── index.ts              # CongestionController interface + factory
│   │   ├── bandwidth-estimator.ts  # Simple AIMD controller
│   │   └── gcc/
│   │       ├── gcc-controller.ts       # Full GCC pipeline
│   │       ├── inter-arrival.ts        # Packet grouping (5ms burst)
│   │       ├── trendline-estimator.ts  # Linear regression delay detection
│   │       ├── aimd-rate-control.ts    # Hold/Increase/Decrease FSM
│   │       ├── loss-based-bwe.ts       # Loss-based bandwidth estimation
│   │       └── acknowledged-bitrate-estimator.ts
│   ├── transport/
│   │   ├── rtc-transport-adapter.ts  # RtcTransport API wrapper
│   │   └── enhanced-pacer.ts         # Token-bucket pacer with probing
│   ├── media/
│   │   ├── video-capture.ts       # getUserMedia + WebCodecs encoder
│   │   ├── video-playback.ts      # WebCodecs decoder + canvas rendering
│   │   ├── audio-capture.ts       # Audio capture + encoding
│   │   ├── audio-playback.ts      # Web Audio API playback
│   │   ├── jitter-buffer.ts       # Fixed-delay jitter buffer
│   │   ├── adaptive-jitter-buffer.ts  # NetEQ-inspired adaptive buffer
│   │   └── video-jitter-buffer.ts # Frame-level video jitter buffer
│   ├── sdp/
│   │   ├── sdp-builder.ts        # SDP offer/answer construction
│   │   └── sdp-parser.ts         # SDP parsing
│   └── recovery/
│       ├── nack-handler.ts        # NACK-based retransmission requests
│       ├── rtx-handler.ts         # RTX retransmission sender
│       └── pli-handler.ts         # PLI/FIR keyframe requests
└── dist/                          # Built output (generated)
```

## Congestion Control

Two algorithms are available, selectable in the UI:

### Simple AIMD
Additive increase (5% per RTT) / multiplicative decrease (β=0.85 on loss/overuse).

### GCC (RFC 8698)
Full Google Congestion Control implementation matching the WebRTC native code:
- **InterArrivalDelta**: 5ms burst grouping, reordering detection
- **TrendlineEstimator**: Smoothed delay with linear regression, adaptive threshold
- **AimdRateControl**: Multiplicative increase near unknown capacity, additive near max
- **LossBasedBwe**: 2% low / 10% high thresholds, RTT backoff at 300ms
- **AcknowledgedBitrateEstimator**: Throughput from ACK feedback

## Standards Implemented

| RFC | Description |
|-----|-------------|
| [RFC 3550](https://tools.ietf.org/html/rfc3550) | RTP/RTCP base protocol |
| [RFC 4585](https://tools.ietf.org/html/rfc4585) | RTCP Feedback (NACK, PLI, FIR) |
| [RFC 4588](https://tools.ietf.org/html/rfc4588) | RTP Retransmission (RTX) |
| [RFC 5285](https://tools.ietf.org/html/rfc5285) | RTP Header Extensions |
| [RFC 6184](https://tools.ietf.org/html/rfc6184) | H.264 RTP Packetization |
| [RFC 6464](https://tools.ietf.org/html/rfc6464) | Audio Level Indication |
| [RFC 7587](https://tools.ietf.org/html/rfc7587) | Opus in RTP |
| [RFC 7741](https://tools.ietf.org/html/rfc7741) | VP8 RTP Packetization |
| [RFC 8698](https://tools.ietf.org/html/rfc8698) | GCC Congestion Control |
| [RFC 8829](https://tools.ietf.org/html/rfc8829) | JSEP (concepts) |
| [RFC 8888](https://tools.ietf.org/html/rfc8888) | Transport-wide CC Feedback |
| [W3C RtcTransport](https://w3c.github.io/webrtc-rtptransport/) | Transport API |

## RTP Payload Type Assignments

| PT | Codec |
|----|-------|
| 0 | G.711 µ-law (PCMU) |
| 8 | G.711 A-law (PCMA) |
| 35 | AV1 |
| 96 | VP8 |
| 98 | VP9 |
| 102 | H.264 |
| 104 | HEVC |
| 111 | Opus |
