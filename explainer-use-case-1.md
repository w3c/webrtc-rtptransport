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
- Obtain a bandwidth estimate from RtpTransport, do bitrate allocation, and set bitrates of RtpSenders

## API requirements

Enable applications to do custom packetization/depacketization by enabling them to:

- Send RTP packets for a particular RtpSender with an RTP timestamp and RTP payload chosen by the application.
- Receive RTP packets for a particular RtpReceiver and prevent the browser from further processing them.
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
const rtpSendStream = await rtpSender.replaceSendStreams()[0];
rtpSendStream.onpacketizedrtp = () => {
  const rtpPacket = rtpSendStream.readPacketizedRtp();
  rtpPacket.audioLevel = levelGenerator.generate(rtpPacket);
  rtpSendStream.sendRtp(rtpPacket);
};
```

### Example 2: Send custom RTP header extension

```javascript
// TODO: Negotiate headerExtensionCalculator.id in SDP
const [pc, rtpSender] = await customPeerConnectionWithRtpSender();
const headerExtensionGenerator = new CustomHeaderExtensionGenerator();
const rtpSendStream = await rtpSender.replaceSendStreams()[0];
rtpSendStream.onpacketizedrtp = () => {
  for (const rtpPacket of rtpSendStream.readPacketizedRtp()) {
    rtpPacket.setHeaderExtension({
      id: headerExtensionGenerator.id,
      value: headerExtensionGenerator.generate(rtpPacket),
    });
    rtpSendStream.sendRtp(rtpPacket)
  }
};
```

### Example 3: Receive custom RTP header extension

```javascript
// TODO: Negotiate headerExtensionProcessor.id in SDP
const [pc, rtpReceiver] = await customPeerConnectionWithRtpReceiver();
const headerExtensionProcessor = new CustomHeaderExtensionProcessor();
const rtpReceiveStream = await videoRtpReceiver.replaceReceiveStreams()[0];
rtpReceiveStream.onreceivedrtp = () => {
  for (const rtpPacket of rtpReceiveStream.readReceivedRtp()) {
    for (const headerExtension of rtpPacket.headerExtensions) {
      if (headerExtension.id == headerExtensionProcessor.id) {
        headerExtensionProcessor.process(headerExtension.value);
      }
    }
    rtpReceiveStream.receiveRtp(rtpPacket);
  }
}
```

### Example 4: Send and packetize with custom codec (WASM)

```javascript
const [pc, rtpSender] = await customPeerConnectionWithRtpSender();
const source = new CustomSource();
const encoder = new CustomEncoder();
const packetizer = new CustomPacketizer();
const rtpSendStream = await rtpSender.replaceSendStreams()[0];
for await (const rawFame in source.frames()) {
  encoder.setTargetBitrate(rtpSendStream.allocatedBandwidth);
  const encodedFrame = encoder.encode(rawFrame);
  const rtpPackets = packetizer.packetize(encodedFrame);
  for (const rtpPacket of rtpPackets) {
    rtpSendStream.sendRtp(rtpPackets);
  }
}
```

### Example 5: Receive with custom codec (WASM) and jitter buffer

```javascript
const [pc, rtpReceiver] = await customPeerConnectionWithRtpReceiver();
const jitterBuffer = new CustomJitterBuffer();
const renderer = new CustomRenderer();
const rtpReceiveStream = await rtpReceiver.replaceReceiveStreams()[0];
rtpReceiveStream.onreceivedrtp = () => {
  const rtpPackets = rtpReceiveStream.readReceivedRtp();
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
const rtpReceiveStream = await rtpReceiver.replaceReceiveStreams()[0];
rtpReceiveStream.onrtpreceived = () => {
  const rtpPackets = rtpReceiveStream.readReceivedRtp();
  const encodedFrames = depacketizer.depacketize(rtpPackets);
  const decodedFrames = decoder.decode(encodedFrames);
  for (rtpPackets of packetizer.toL16(decodedFrames)) {
    rtpReceiveStream.receiveRtp(rtpPackets);
  }
}
```

### Example 7: Send and packetize with WebCodecs

```javascript
const [pc, rtpSender] = await customPeerConnectionWithRtpSender();
const source = new CustomSource();
const packetizer = new CustomPacketizer();
const rtpSendStream = await rtpSender.replaceSendStreams()[0];
const encoder = new VideoEncoder({
  output: (chunk) => {
    let rtpPackets = packetizer.packetize(chunk);
    for packet in rtpPackets {
      rtpSendStream.sendRtp(rtpPackets);
    }
  },
  ...
});
for await (const rawFrame of source.frames()) {
  encoder.configure({
    ...
    latencyMode: "realtime",
    tuning: {
      bitrate: rtpSendStream.allocatedBandwidth;
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
const rtpReceiveStream = await rtpReceiver.replaceReceiveStreams()[0];
const decoder = new VideoDecoder({
  output: (chunk) => {
    renderer.render(chunk);
  },
  ...
  
});
rtpReceiveStream.onrtpreceived = () => {
  const rtpPackets = rtpReceiveStream.readReceivedRtp();
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
const rtpReceiveStream = await rtpReceiver.replaceReceiveStreams()[0];
const decoder = new AudioDecoder({
  output: (chunk) => {
    const rtpPackets = packetizer.toL16(chunk);
    for packet in rtpPackets {
      rtpRecieveStream.receiveRtp(rtpPackets);
    }
  },
  ...
});
rtpReceiveStream.onrtpreceived = () => {
  const rtp = rtpReceiveStream.readReceivedRtp();
  const encodedFrames = depacketizer.depacketize(rtp);
  decoder.decode(encodedFrames);
}
```

### Example 10: Send custom FEC

```javascript
// TODO: Negotiate headerExtensionCalculator.id in SDP
const [pc, rtpSender] = await customPeerConnectionWithRtpSender();
const fecGenerator = new CustomFecGenerator();
const rtpSendStream = await rtpSender.replaceSendStreams()[0];
rtpSendStream.onpacketizedrtp = () => {
  const rtpPackets = rtpSendStream.readPacketizedRtp();
  const fecPackets = fecGenerator.generate(rtpPackets)
  for (const fecPacket of fecPackets) {
    rtpSendStream.sendRtp(fecPacket)
  }
};
```


### Example 11: Receive custom FEC

```javascript
// TODO: Negotiate headerExtensionProcessor.id in SDP
const [pc, rtpReceiver] = await customPeerConnectionWithRtpReceiver();
const fecProcessor = new CustomFecProcessor();
const rtpReceiveStream = await videoRtpReceiver.replaceReceiveStreams()[0];
rtpReceiveStream.onreceivedrtp = () => {
  const fecPackets = rtpSendStream.readPacketizedRtp();
  const rtpPackets = fecProcessor.process(fecPackets)
  for (const rtpPacket of rtpPackets) {
    rtpReceiveStream.receiveRtp(rtpPacket);
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

## Example 13: Receive with BYOB
```javascript
const [pc, videoRtpReceiver] = await setupPeerConnectionWithRtpReceiver();  // Custom
const videoRtpReceiveStream = await videoRtpReceiver.replaceReceiveStreams()[0];  // Custom
const buffer = new ArrayBuffer(100000);
videoRtpReceiveStream.onrtpreceived = () => {
  const videoRtpPackets = videoRtpReceiveStream.readReceivedRtp(10);
  for (const videoRtpPacket of videoRtpPackets) {
    videoRtpPacket.copyPayloadTo(buffer);
    depacketizeIntoJitterBuffer(videoRtpPacket.sequenceNumber, videoRtpPacket.marker, buffer);  // Custom
  }
};
```

## Example 14: Packetize with BYOB
```javascript
const [pc, videoRtpSender] = await setupPeerConnectionWithRtpSender();  // Custom
const videoRtpSendStream = await videoRtpSender.replaceSendStreams()[0];

// Simplified illustration of packetization using views into an existing ArrayBuffer.
// NOTE: Only an illustration, not at all like an actual packetization algorithm!
const packetByteLen = 1000;
function packetizeEncodedFrame(frameArrayBuffer) {
  for (let byteIdx = 0; byteIdx < frameArrayBuffer.size; byteIdx += packetByteLen) {
    let packetPayloadView = new Uint8Array(frameArrayBuffer, byteIdx, packetByteLen);
    videoRtpSendStream.sendRtp({payload: packetPayloadView, makePacketMetadata().../* Custom */});
  }
}

```


## Alternative designs considered
