# Testing the RtcTransport WebRTC Sample

## 1. Build Chrome with the feature enabled

### Build command:
```bash
autoninja -C out/Default chrome
```

### Launch Chrome with RtcTransport enabled:
```bash
out/Default/chrome \
  --enable-features=RTCRtpTransport \
  --enable-blink-features=RTCRtpTransport \
  --unsafely-treat-insecure-origin-as-secure=http://localhost:8080 \
  --user-data-dir=/tmp/rtc-test-profile
```

On Windows:
```cmd
out\Default\chrome.exe ^
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

## 2. Start the signaling server

```bash
cd webrtc-sample
npm install
npm start
```

Server runs on `http://localhost:8080`.

## 3. Test scenarios

### Scenario A: Two RtcTransport clients (same implementation)
1. Open Tab 1: `http://localhost:8080/`
2. Open Tab 2: `http://localhost:8080/`
3. Both join the same room (e.g., "test-room")
4. Click "Start Call" in either tab
5. Verify: audio flows between tabs

### Scenario B: RtcTransport ↔ Standard WebRTC (interop)
1. Open Tab 1: `http://localhost:8080/` (RtcTransport client)
2. Open Tab 2: `http://localhost:8080/peer_connection.html` (standard RTCPeerConnection)
3. Both join the same room
4. Click "Start Call" in either tab
5. Verify: audio flows between tabs

### Scenario C: Verify API availability (DevTools console)
In a tab with the flag enabled, open DevTools (F12) and run:
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

// Verify new APIs
console.log('getPacketSentInfo:', typeof transport.getPacketSentInfo);
console.log('onpendingpacketssentinfo:', 'onpendingpacketssentinfo' in transport);
console.log('onpendingpacketsreceived:', 'onpendingpacketsreceived' in transport);
```

## 4. Run C++ unit tests

```bash
autoninja -C out/Default blink_unittests
out/Default/blink_unittests --gtest_filter="*RtcTransport*"
```

## 5. Troubleshooting

### "RtcTransport is not defined"
- Ensure both `--enable-features=RTCRtpTransport` and `--enable-blink-features=RTCRtpTransport` flags are passed
- Ensure the page is served over HTTPS or localhost with the insecure-origin flag
- Check `chrome://flags` to verify no conflicting settings

### ICE connection fails
- Ensure STUN server is reachable (stun.l.google.com:19302)
- Check browser console for ICE candidate errors
- Verify both peers exchange candidates via signaling

### No audio
- Check microphone permissions (browser should prompt)
- Verify `getUserMedia` succeeds in DevTools console
- Check the call state shows "connected"
- Look for WebCodecs AudioEncoder support (Chrome 94+)

### Transport not writable
- ICE connectivity check hasn't completed yet — wait for `onwritablechange` event
- DTLS handshake may still be in progress
- Check that remote DTLS fingerprint matches the remote peer's certificate

## 6. Development iteration

For quick iteration on the JS code only (no C++ rebuild needed):
```bash
# Just restart the signaling server
npm start

# Reload browser tabs - JS changes take effect immediately
```

For C++ spec changes, rebuild Chrome:
```bash
autoninja -C out/Default chrome
# Then relaunch with the flags above
```
