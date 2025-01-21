# Custom Packetization Use Case

## Extended use cases

Custom packetization/depacketization enables the following WebRTC Extended Use Cases: 

- [Section 2.3](https://www.w3.org/TR/webrtc-nv-use-cases/#videoconferencing*): Video Conferencing with a Central Server
- [Section 3.2.1](https://www.w3.org/TR/webrtc-nv-use-cases/#game-streaming): Game streaming
- [Section 3.2.2](https://www.w3.org/TR/webrtc-nv-use-cases/#auction): Low latency Broadcast with Fanout
- [Section 3.5](https://www.w3.org/TR/webrtc-nv-use-cases/#vr*): Virtual Reality Gaming

## Detailed description

In this use case, packetization of encoded video or audio frames is handled by the application, as is depacketization. The encoded video or audio frames to be packetized can be constructed using WebCodecs or WASM.  The codecs to be packetized/depacketized can be supported natively within WebRTC (e.g. Opus, VP8, H.264, etc.) or they could be codecs supported natively within WebCodecs (e.g. AAC) but not within WebRTC, or they could be codecs implemented in WASM but not supported natively in either WebRTC or WebCodecs (e.g. Lyra or Satin). 

Custom packetization/depacketization enables applications to do things such as:
- Encode with a custom (WASM) codec, packetize and send
- Observe incoming packets
- Receive packets using a custom jitter buffer implementation
- Use WebCodecs for encode or decode, implement packetization/depacketization, a custom jitter buffer, and custom FEC
- Obtain a bandwidth estimate from RTCRtpTransport, do bitrate allocation, and set bitrates of RTCRtpSenders

## API requirements

Enable applications to do custom packetization/depacketization by enabling them to:

- Send RTP packets for a particular RTCRtpSender with an RTP timestamp and RTP payload chosen by the application.
- Receive RTP packets for a particular RTCRtpReceiver and prevent the browser from further processing them.
- Know what bitrates the browser has already allocate to send.
- Know what bitrate can be sent in addition to what the browser has already allocated to send.
- Cause the browser to allocate less to send, leaving more bitrate available to the application to send.

Complexities of sending and receiving RTP other than these requirements are still handled by the User Agent - in
particular Pacing of sent packets on the wire, inclusion of padding to support bandwidth probing, and RTP Sequence
Numbering taking into account such padding. 

## Examples

### Example 1: Send customized RTP header extension (audio level)

```javascript
const [pc, rtpSender] = await customPeerConnectionWithRtpSender();
const levelGenerator = new CustomAudioLevelCalculator();
const rtpPacketSender = await rtpSender.replacePacketSender();
rtpPacketSender.onpacketizedrtp = () => {
  const rtpPacket = rtpPacketSender.readPacketizedRtp();
  const audioLevelExtension = levelGenerator.generate(rtpPacket)
  rtpPacket.headerExtensions.push(audioLevelExtension);
  rtpPacketSender.sendRtp(rtpPacket);
};
```

### Example 2: Send custom RTP header extension

```javascript
// TODO: Negotiate headerExtensionCalculator.uri in SDP
const [pc, rtpSender] = await customPeerConnectionWithRtpSender();
const headerExtensionGenerator = new CustomHeaderExtensionGenerator();
const rtpPacketSender = await rtpSender.replacePacketSender();
rtpPacketSender.onpacketizedrtp = () => {
  for (const rtpPacket of rtpPacketSender.readPacketizedRtp()) {
    rtpPacket.setHeaderExtension({
      uri: headerExtensionGenerator.uri,
      value: headerExtensionGenerator.generate(rtpPacket),
    });
    rtpPacketSender.sendRtp(rtpPacket)
  }
};
```

### Example 3: Receive custom RTP header extension

```javascript
// TODO: Negotiate headerExtensionProcessor.uri in SDP
const [pc, rtpReceiver] = await customPeerConnectionWithRtpReceiver();
const headerExtensionProcessor = new CustomHeaderExtensionProcessor();
const rtpPacketReceiver = await videoRtpReceiver.replacePacketReceiver();
rtpPacketReceiver.onreceivedrtp = () => {
  for (const rtpPacket of rtpPacketReceiver.readReceivedRtp()) {
    for (const headerExtension of rtpPacket.headerExtensions) {
      if (headerExtension.uri == headerExtensionProcessor.uri) {
        headerExtensionProcessor.process(headerExtension.value);
      }
    }
    rtpPacketReceiver.receiveRtp(rtpPacket);
  }
}
```

### Example 4: Send and packetize with custom codec (WASM)

```javascript
const [pc, rtpSender] = await customPeerConnectionWithRtpSender();
const source = new CustomSource();
const encoder = new CustomEncoder();
const packetizer = new CustomPacketizer();
const rtpPacketSender = await rtpSender.replacePacketSender();
for await (const rawFame in source.frames()) {
  encoder.setTargetBitrate(rtpPacketSender.allocatedBandwidth);
  const encodedFrame = encoder.encode(rawFrame);
  const rtpPackets = packetizer.packetize(encodedFrame);
  for (const rtpPacket of rtpPackets) {
    rtpPacketSender.sendRtp(rtpPackets);
  }
}
```

### Example 5: Receive with custom codec (WASM) and jitter buffer

```javascript
const [pc, rtpReceiver] = await customPeerConnectionWithRtpReceiver();
const jitterBuffer = new CustomJitterBuffer();
const renderer = new CustomRenderer();
const rtpPacketReceiver = await rtpReceiver.replacePacketReceiver();
rtpPacketReceiver.onreceivedrtp = () => {
  const rtpPackets = rtpPacketReceiver.readReceivedRtp();
  jitterBuffer.injectRtpPackets(rtpPackets);
}
for await (decodedFrame in jitterBuffer.decodedFrames()) {
  renderer.render(decodedFrame)
}
```

### Example 6: Receive audio with custom codec (WASM) and existing jitter buffer

```javascript
const [pc, rtpReceiver] = await customPeerConnectionWithRtpReceiver();
const depacketizer = new CustomDepacketizer();
const decoder = new CustomDecoder();
const packetizer = new CustomL16Packetizer();
const rtpPacketReceiver = await rtpReceiver.replacePacketReceiver();
rtpPacketReceiver.onrtpreceived = () => {
  const rtpPackets = rtpPacketReceiver.readReceivedRtp();
  const encodedFrames = depacketizer.depacketize(rtpPackets);
  const decodedFrames = decoder.decode(encodedFrames);
  for (rtpPackets of packetizer.toL16(decodedFrames)) {
    rtpPacketReceiver.receiveRtp(rtpPackets);
  }
}
```

### Example 7: Send and packetize with WebCodecs

```javascript
const [pc, rtpSender] = await customPeerConnectionWithRtpSender();
const source = new CustomSource();
const packetizer = new CustomPacketizer();
const rtpPacketSender = await rtpSender.replacePacketSender();
const encoder = new VideoEncoder({
  output: (chunk) => {
    let rtpPackets = packetizer.packetize(chunk);
    for packet in rtpPackets {
      rtpPacketSender.sendRtp(rtpPackets);
    }
  },
  ...
});
for await (const rawFrame of source.frames()) {
  encoder.configure({
    ...
    latencyMode: "realtime",
    tuning: {
      bitrate: rtpPacketSender.allocatedBandwidth;
      ...
    }
  });
  encoder.encode(rawFrame);
}
```

### Example 8: Receive with custom codec (WASM) and jitter buffer

```javascript
const [pc, rtpReceiver] = await customPeerConnectionWithRtpReceiver();
const jitterBuffer = new CustomJitterBuffer();
const renderer = new CustomRenderer();
const rtpPacketReceiver = await rtpReceiver.replacePacketReceiver();
const decoder = new VideoDecoder({
  output: (chunk) => {
    renderer.render(chunk);
  },
  ...
  
});
rtpPacketReceiver.onrtpreceived = () => {
  const rtpPackets = rtpPacketReceiver.readReceivedRtp();
  jitterBuffer.injectRtpPackets(rtpPackets);
}
for await (encodedFrame in jitterBuffer.encodedFrames()) {
  decoder.decode(endcodedFrame)
}
```

### Example 9: Receive audio with custom codec (WASM) and existing jitter buffer

```javascript
const [pc, rtpReceiver] = await customPeerConnectionWithRtpReceiver();
const depacketizer = new CustomDepacketizer();
const packetizer = new CustomL16Packetizer();
const rtpPacketReceiver = await rtpReceiver.replacePacketReceiver();
const decoder = new AudioDecoder({
  output: (chunk) => {
    const rtpPackets = packetizer.toL16(chunk);
    for packet in rtpPackets {
      rtpRecieveStream.receiveRtp(rtpPackets);
    }
  },
  ...
});
rtpPacketReceiver.onrtpreceived = () => {
  const rtp = rtpPacketReceiver.readReceivedRtp();
  const encodedFrames = depacketizer.depacketize(rtp);
  decoder.decode(encodedFrames);
}
```

### Example 10: Send custom FEC

```javascript
// TODO: Negotiate headerExtensionCalculator.uri in SDP
const [pc, rtpSender] = await customPeerConnectionWithRtpSender();
const fecGenerator = new CustomFecGenerator();
const rtpPacketSender = await rtpSender.replacePacketSender();
rtpPacketSender.onpacketizedrtp = () => {
  const rtpPackets = rtpPacketSender.readPacketizedRtp();
  const fecPackets = fecGenerator.generate(rtpPackets)
  for (const fecPacket of fecPackets) {
    rtpPacketSender.sendRtp(fecPacket)
  }
};
```


### Example 11: Receive custom FEC

```javascript
// TODO: Negotiate headerExtensionProcessor.uri in SDP
const [pc, rtpReceiver] = await customPeerConnectionWithRtpReceiver();
const fecProcessor = new CustomFecProcessor();
const rtpPacketReceiver = await videoRtpReceiver.replacePacketReceiver();
rtpPacketReceiver.onreceivedrtp = () => {
  const fecPackets = rtpPacketSender.readPacketizedRtp();
  const rtpPackets = fecProcessor.process(fecPackets)
  for (const rtpPacket of rtpPackets) {
    rtpPacketReceiver.receiveRtp(rtpPacket);
  }
}
```


### Example 12: Custom bitrate allocation
```javascript
const [pc, rtpTransport] = await setupPeerConnectionWithRtpSender();
setInterval(() => {
  for (const [rtpSender, bitrate] of allocateBitrates(rtpTransport.bandwidthEstimate)) {  // Custom
    const parameters = rtpSender.getParameters();
    parameters.encodings[0].maxBitrate = bitrate;
    rtpSender.setParameters(parameters);  
  }
}, 1000);
```

### Example 13: Receive with BYOB
```javascript
const [pc, videoRtpReceiver] = await setupPeerConnectionWithRtpReceiver();  // Custom
const rtpPacketReceiver = await videoRtpReceiver.replacePacketReceiver();  // Custom
rtpPacketReceiver.onrtpreceived = () => {
  const videoRtpPackets = rtpPacketReceiver.readReceivedRtp(10);
  for (const videoRtpPacket of videoRtpPackets) {
    const destArrayBufferView = allocateFromBufferPool(videoRtpPacket.payloadByteLength); // Custom memory management
    destArrayBufferView.set(videoRtpPacket.payload);
    depacketizeIntoJitterBuffer(videoRtpPacket.sequenceNumber, videoRtpPacket.marker, destArrayBufferView);  // Custom
  }
};
```

### Example 14: Packetize with BYOB
```javascript
const [pc, videoRtpSender] = await setupPeerConnectionWithRtpSender();  // Custom
const rtpPacketSender = await videoRtpSender.replacePacketSender();

// Simplified illustration of packetization using views into an existing ArrayBuffer.
// NOTE: Only an illustration, not at all like an actual packetization algorithm!
const packetByteLen = 1000;
function packetizeEncodedFrame(frameArrayBuffer) {
  for (let byteIdx = 0; byteIdx < frameArrayBuffer.size; byteIdx += packetByteLen) {
    let packetPayloadView = new Uint8Array(frameArrayBuffer, byteIdx, packetByteLen);
    rtpPacketSender.sendRtp({payload: packetPayloadView, makePacketMetadata().../* Custom */});
  }
}
```


## Example 15: Receive with BYOP (Bring Your Own Packets)
```javascript
const dstPackets = [];
for (let i = 0; i < kBatchNumPackets; ++i) {
  dstPackets.push(new RTCRtpPacket());  // Dummy until written to.
}

const [pc, videoRtpReceiver] = await setupPeerConnectionWithRtpReceiver();  // Custom
const rtpPacketReceiver = await videoRtpReceiver.replacePacketReceiver();  // Custom
rtpPacketReceiver.onrtpreceived = () => {
  const packetsReceived = rtpPacketReceiver.readReceivedRtp(dstPackets);
  for (let i = 0; i < packetsReceived; ++i) {
    rtpPacketReceiver.receiveRtp(dstPackets[i]);
  }
};
```


### Example 16: Send with BYOP (Bring Your Own Packets)

```javascript
const dstPackets = [];
for (let i = 0; i < kBatchNumPackets; ++i) {
  dstPackets.push(new RTCRtpPacket());  // Dummy until written to.
}

const [pc, rtpSender] = await customPeerConnectionWithRtpSender();
const source = new CustomSource();
const encoder = new CustomEncoder();
const packetizer = new CustomPacketizer();
const rtpPacketSender = await rtpSender.replacePacketSender();
for await (const rawFame in source.frames()) {
  encoder.setTargetBitrate(rtpPacketSender.allocatedBandwidth);
  const encodedFrame = encoder.encode(rawFrame);
  const packetsToSend = packetizer.packetize(encodedFrame, dstPackets);
  for (let i = 0; i < packetsToSend; ++i) {
    rtpPacketSender.sendRtp(dstPackets[i]);
  }
}
```
