# Testing the RtcTransport WebRTC Sample

## 1. Launch Chrome with RtcTransport enabled

The RtcTransport API is available in official Chrome builds (version 130+) behind
runtime flags. No custom build is required.

### Linux / macOS:
```bash
google-chrome \
  --enable-features=RTCRtpTransport \
  --enable-blink-features=RTCRtpTransport \
  --unsafely-treat-insecure-origin-as-secure=http://localhost:8080 \
  --user-data-dir=/tmp/rtc-test-profile
```

### Windows:
```cmd
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --enable-features=RTCRtpTransport ^
  --enable-blink-features=RTCRtpTransport ^
  --unsafely-treat-insecure-origin-as-secure=http://localhost:8080 ^
  --user-data-dir=%TEMP%\rtc-test-profile
```

### Flags explained:
| Flag | Purpose |
|------|---------|
| `--enable-features=RTCRtpTransport` | Enables the base::Feature at browser level |
| `--enable-blink-features=RTCRtpTransport` | Enables the Blink RuntimeEnabledFeature |
| `--unsafely-treat-insecure-origin-as-secure=http://localhost:8080` | Allows RtcTransport (SecureContext) over plain HTTP for local testing |
| `--user-data-dir=...` | Separate profile so flags don't affect your normal browser |

> **Note**: The PeerConnection client (`peer_connection.html`) does not require any
> special flags — it uses standard WebRTC APIs available in all modern browsers.

## 2. Start the signaling server

```bash
cd rtctransport-sample
npm install
npm run build
npm run start
```

Server runs on `http://localhost:8080`.

## 3. Test scenarios

### Scenario A: Two RtcTransport clients
1. Open Tab 1: `http://localhost:8080/`
2. Open Tab 2: `http://localhost:8080/`
3. Both join the same room (e.g., "test-room")
4. Click "Start Call" in either tab
5. Verify: video and audio flow between tabs

### Scenario B: RtcTransport ↔ Standard WebRTC (interop)
1. Open Tab 1: `http://localhost:8080/` (RtcTransport client — needs flags)
2. Open Tab 2: `http://localhost:8080/peer_connection.html` (standard RTCPeerConnection — no flags needed)
3. Both join the same room
4. Click "Start Call" in either tab
5. Verify: video and audio flow between tabs

### Scenario C: Codec selection
1. Start a call (Scenario A or B)
2. Before calling, select different video codecs (VP8, VP9, AV1, H.264)
3. Select different audio codecs (Opus, G.711, AAC)
4. Select congestion control algorithm (Simple / GCC)
5. Verify media flows with the selected codecs (check stats panel)

### Scenario D: Verify API availability (DevTools console)
```javascript
// Check RtcTransport is defined
console.log('RtcTransport available:', typeof RtcTransport !== 'undefined');

// Create a transport instance
const transport = new RtcTransport({
  name: 'test',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  iceControlling: true,
  wireProtocol: 'dtls-srtp'
});
console.log('Transport created:', transport);
```

### Scenario E: Error recovery verification
1. Start a call between two RtcTransport clients
2. Open DevTools Network tab → throttle to "3G" or add packet loss
3. Observe stats panel: "NACK sent" and "FEC recovered" counters should increase
4. Video should continue playing (possibly with lower quality due to keyframe requests)

## 4. Stats & Graphs

Both apps display real-time statistics in three sections:
- **Video**: Codec, frames sent/received, estimated QP
- **Audio**: Codec, packets sent/received, jitter buffer delay
- **Network**: CC target bitrate, actual bitrate, packet loss, jitter, NACK/FEC/PLI counts

Click "Show Graphs" to display time-series charts for bitrate, QP, loss, jitter,
resolution, and FPS (60-second rolling window, 1 sample/sec).

## 5. Troubleshooting

### "RtcTransport is not defined"
- Ensure both `--enable-features=RTCRtpTransport` and `--enable-blink-features=RTCRtpTransport` flags are passed
- Ensure you're using the profile specified by `--user-data-dir` (not your default profile)
- Ensure the page is served over HTTPS or localhost with the insecure-origin flag
- Verify Chrome version is 130+ (`chrome://version`)

### ICE connection fails
- Ensure STUN server is reachable (stun.l.google.com:19302)
- Check browser console for ICE candidate errors
- Verify both peers exchange candidates via signaling

### No video/audio
- Check microphone/camera permissions (browser should prompt)
- Verify `getUserMedia` succeeds in DevTools console
- Check the call state shows "connected"
- For H.264: requires Annex B format — if encoder fails, try VP8/VP9
- For HEVC: not supported for encoding on most platforms — will show error in log

### Transport not writable
- ICE connectivity check hasn't completed yet — wait for `onwritablechange` event
- DTLS handshake may still be in progress
- Check that remote DTLS fingerprint matches the remote peer's certificate

## 6. Development iteration

```bash
# Edit TypeScript source, then rebuild:
npm run build

# Restart server (picks up server.ts changes):
npm run build:server && npm run start

# Reload browser tabs — client JS changes take effect immediately after build
```

Type-checking without building:
```bash
npm run typecheck
```
