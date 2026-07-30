# RtcTransport WebRTC Sample

A TypeScript-based WebRTC application implementing a full RTP/RTCP media stack on top of the
low-level `RtcTransport` browser API ([W3C spec](https://w3c.github.io/webrtc-rtptransport/)).

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Application (main.ts)                                           │
├──────────────────────────────────────────────────────────────────┤
│  Call State Machine │ Signaling │ SDP Parser                     │
├──────────────────────────────────────────────────────────────────┤
│  Video/Audio Capture │ Multi-codec Packetizers │ Jitter Buffer   │
├──────────────────────────────────────────────────────────────────┤
│  Error Recovery (NACK │ PLI/FIR │ XOR FEC)                       │
├──────────────────────────────────────────────────────────────────┤
│  Congestion Control (Simple AIMD / GCC RFC 8698)                 │
├──────────────────────────────────────────────────────────────────┤
│  RTP/RTCP Stack (RFC 3550)                                       │
├──────────────────────────────────────────────────────────────────┤
│  RtcTransport Adapter (ICE + DTLS-SRTP)                          │
├──────────────────────────────────────────────────────────────────┤
│  Browser: RtcTransport API                                       │
└──────────────────────────────────────────────────────────────────┘
```

## Features

- **Multi-codec video**: VP8, VP9, H.264, HEVC, AV1 (with per-codec packetizer/depacketizer)
- **Multi-codec audio**: Opus, G.711 µ-law (PCMU), G.711 A-law (PCMA), AAC-LC
- **Congestion control**: Simple AIMD and full GCC (RFC 8698) with delay-based + loss-based BWE
- **Error recovery**: NACK retransmission, PLI/FIR keyframe requests, XOR-based FEC (RFC 5109)
- **Jitter buffer**: Fixed-delay audio jitter buffer with reordering
- **Stats & graphs**: Real-time bitrate, QP, jitter, packet loss, resolution, FPS graphs
- **Interoperability**: Communicates with standard RTCPeerConnection peers

## Prerequisites

1. **Chrome** (official build, version 130+) with RtcTransport flag enabled:
   ```
   chrome --enable-features=RTCRtpTransport \
          --enable-blink-features=RTCRtpTransport \
          --unsafely-treat-insecure-origin-as-secure=http://localhost:8080 \
          --user-data-dir=/tmp/rtc-test-profile
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
│   │   └── global.d.ts           # Browser API type declarations
│   ├── rtp/
│   │   ├── rtp-packet.ts         # RTP parser/serializer (RFC 3550)
│   │   ├── rtcp-packet.ts        # RTCP SR/RR/BYE (RFC 3550 §6)
│   │   └── rtp-session.ts        # Session management (SSRC, seq, stats)
│   ├── codec/
│   │   ├── index.ts              # Codec registry (VIDEO_CODECS, AUDIO_CODECS)
│   │   ├── packetizer.ts         # Opus packetizer/depacketizer
│   │   ├── depacketizer.ts       # Base depacketizer interface
│   │   ├── vp8-packetizer.ts     # VP8 RTP (RFC 7741)
│   │   ├── vp9-packetizer.ts     # VP9 RTP
│   │   ├── h264-packetizer.ts    # H.264 RTP (RFC 6184, FU-A)
│   │   ├── hevc-packetizer.ts    # HEVC RTP (RFC 7798)
│   │   ├── av1-packetizer.ts     # AV1 RTP
│   │   ├── g711-packetizer.ts    # G.711 µ-law/A-law
│   │   └── aac-packetizer.ts     # AAC-LC (RFC 3640)
│   ├── cc/
│   │   ├── index.ts              # CongestionController interface + factory
│   │   ├── aimd.ts               # AIMD rate control (shared)
│   │   ├── overuse-detector.ts   # Delay overuse detection
│   │   ├── bandwidth-estimator.ts  # Simple AIMD controller
│   │   └── gcc/
│   │       ├── gcc-controller.ts       # Full GCC pipeline
│   │       ├── inter-arrival.ts        # Packet grouping (5ms burst)
│   │       ├── trendline-estimator.ts  # Linear regression delay detection
│   │       ├── aimd-rate-control.ts    # Hold/Increase/Decrease FSM
│   │       ├── loss-based-bwe.ts       # Loss-based bandwidth estimation
│   │       └── acknowledged-bitrate-estimator.ts
│   ├── transport/
│   │   └── rtc-transport-adapter.ts  # RtcTransport API wrapper
│   ├── media/
│   │   ├── video-capture.ts       # getUserMedia + WebCodecs encoder
│   │   ├── video-playback.ts      # WebCodecs decoder + canvas rendering
│   │   ├── audio-capture.ts       # Audio capture + encoding
│   │   ├── audio-playback.ts      # Web Audio API playback
│   │   └── jitter-buffer.ts       # Fixed-delay audio jitter buffer
│   ├── sdp/
│   │   └── sdp-parser.ts         # SDP parsing + fingerprint utility
│   └── recovery/
│       ├── index.ts               # Recovery module exports
│       ├── nack-handler.ts        # NACK gap detection + retransmission (RFC 4585)
│       ├── keyframe-request.ts    # PLI/FIR keyframe requests (RFC 4585/5104)
│       └── fec.ts                 # XOR-based FEC encoder/decoder (RFC 5109)
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

## Error Recovery

| Mechanism | Description |
|-----------|-------------|
| **NACK** (RFC 4585) | Detects sequence number gaps, requests retransmission via RTCP RTPFB. Sent packets buffered (500 packets) for retransmit. |
| **PLI** (RFC 4585) | Picture Loss Indication — requests keyframe when decoder cannot recover. Throttled to 1/sec. |
| **FIR** (RFC 5104) | Full Intra Request — stronger keyframe request with sequence numbering. |
| **XOR FEC** (RFC 5109) | Groups of 5 video packets protected by 1 FEC packet (~20% overhead). Single-loss recovery via XOR. |

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
   │                     Blink IDL Bindings                          │
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
