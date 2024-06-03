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

## API Outline 

### RtpPacket, RtcpPacket

```javascript
interface RtpPacket {
  constructor(required RtpPacketInit);
  readonly attribute bool marker;
  readonly attribute octet payloadType;
  readonly attribute unsigned short sequenceNumber;
  readonly attribute unsigned long timestamp;
  readonly attribute unsigned long ssrc;
  readonly attribute sequence<unsigned long> csrcs;
  readonly attribute sequence<RtpHeaderExtension> headerExtensions;

  // Write payload to the specified (Shared-)ArrayBuffer/ArrayBufferView,
  // allowing for BYOB.
  undefined copyPayloadTo(AllowSharedBufferSource destination);

  // OPTIONAL: Duplicate with header extensions, but conveniently parsed
  readonly attribute DOMString? mid;
  readonly attribute DOMString? rid;
  attribute octet? audioLevel;  
  attribute octet? videoRotation;
  readonly attribute unsigned long long? remoteSendTimestamp;

  // OPTIONAL: Extra information that may be useful to know
  readonly attribute DOMHighResTimeStamp receivedTime;
  readonly attribute unsigned long sequenceNumberRolloverCount;

  void setHeaderExtension(RtpHeaderExtension);
}

interface RtpHeaderExtension {
  constructor(required RtpHeaderExtensionInit);
  readonly attribute DOMString uri;
  undefined copyValueTo(AllowSharedBufferSource destination);
}

dictionary RtpPacketInit {
  bool marker = false;
  required octet payloadType;
  required unsigned long timestamp;
  sequence<unsigned long> csrcs = [];
  // Cannot be MID, RID, or congestion control sequence number
  sequence<RtpHeaderExtensionInit> headerExtensions = [];
  required AllowSharedBufferSource payload;

  // Convenience for adding to headerExtensions
  octet audioLevel;
  octet videoRotation;
}

dictionary RtpHeaderExtensionInit {
  required DOMString uri;
  required AllowSharedBufferSource value;
}

```
### RTCPeerConnection, RTCRtpSender, RTCRtpReceiver Extensions

```javascript
partial interface PeerConnection {
  // There may be an RtpTransport with no RtpSenders and no RtpReceivers
  readonly attribute sequence<RtpTransport> getRtpTransports();
}
partial interface RtpSender {
  // shared between RtpSenders in the same BUNDLE group
  readonly attribute RtpTransport? rtpTransport;
  Promise<sequence<RtpSendStream>> replaceSendStreams();
}
partial interface RtpReceiver {
  // shared between RtpSenders in the same BUNDLE group
  readonly attribute RtpTransport? rtpTransport;
  Promise<sequence<RtpReceiveStream>> replaceReceiveStreams();
}

interface RtpTransport {
  Promise<RtpSendStream> addRtpSendStream(RtpSendStreamInit);
  Promise<RtpReceiveStream> addRtpReceiveStream(RtpReceiveStreamInit);
  readonly attribute unsigned long bandwidthEstimate;  // bps
  readonly attribute unsigned long allocatedBandwidth;  // bps
  attribute unsigned long customAllocatedBandwidth;  // writable
}

[Exposed=(Window,Worker), Transferable]
interface RtpSendStream {
  readonly attribute DOMString mid?;  // Shared among many RtpSendStreams
  readonly attribute DOMString rid?;  // Unique to RtpSendStream (scoped to MID)
  readonly attribute unsigned long ssrc;
  readonly attribute unsigned long rtxSsrc;

  attribute EventHandler onpacketizedrtp;
  sequence<RtpPacket> readPacketizedRtp(long maxNumberOfPackets);

  // Takes a synchronous copy of packet.payload and packet.headerExtensions[*].value,
  // allowing the underlying buffers to be reused immediately.
  void sendRtp(RtpPacket packet);
  
  // Amount allocated by the browser
  readonly attribute unsigned long allocatedBandwidth;
}

[Exposed=(Window,Worker), Transferable]
interface RtpReceiveStream {
  readonly attribute DOMString mid?;  // Shared among many RtpReceivetreams
  readonly attribute DOMString rid?;  // Unique to RtpReceiveStream (scoped to MID)
  readonly attribute sequence<unsigned long> ssrcs;
  readonly attribute sequence<unsigned long> rtxSsrcs;

  attribute EventHandler onreceivedrtp;
  sequence<RtpPacket> readReceivedRtp(long maxNumberOfPackets);

  void receiveRtp(RtpPacket packet)
}
```

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
// TODO: Negotiate headerExtensionCalculator.uri in SDP
const [pc, rtpSender] = await customPeerConnectionWithRtpSender();
const headerExtensionGenerator = new CustomHeaderExtensionGenerator();
const rtpSendStream = await rtpSender.replaceSendStreams()[0];
rtpSendStream.onpacketizedrtp = () => {
  for (const rtpPacket of rtpSendStream.readPacketizedRtp()) {
    rtpPacket.setHeaderExtension({
      uri: headerExtensionGenerator.uri,
      value: headerExtensionGenerator.generate(rtpPacket),
    });
    rtpSendStream.sendRtp(rtpPacket)
  }
};
```

### Example 3: Receive custom RTP header extension

```javascript
// TODO: Negotiate headerExtensionProcessor.uri in SDP
const [pc, rtpReceiver] = await customPeerConnectionWithRtpReceiver();
const headerExtensionProcessor = new CustomHeaderExtensionProcessor();
const rtpReceiveStream = await videoRtpReceiver.replaceReceiveStreams()[0];
rtpReceiveStream.onreceivedrtp = () => {
  for (const rtpPacket of rtpReceiveStream.readReceivedRtp()) {
    for (const headerExtension of rtpPacket.headerExtensions) {
      if (headerExtension.uri == headerExtensionProcessor.uri) {
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
// TODO: Negotiate headerExtensionCalculator.uri in SDP
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
// TODO: Negotiate headerExtensionProcessor.uri in SDP
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

## Example 4: Receive with BYOB
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

## Example 5: Packetize with BYOB
```javascript
const [pc, videoRtpSender] = await setupPeerConnectionWithRtpSender();  // Custom
const videoRtpSendStream = await videoRtpSender.replaceSendStreams()[0];

// Simplified illustration of packetization.
const packetByteLen = 1000;
function packetizeEncodedFrame(frameArrayBuffer) {
  for (let byteIdx = 0; byteIdx < frameArrayBuffer.size; byteIdx += packetByteLen) {
    let packetPayloadView = new Uint8Array(frameArrayBuffer, byteIdx, packetByteLen);
    videoRtpSendStream.sendRtp({payload: packetPayloadView, makePacketMetadata().../* Custom */});
  }
}

```


## Alternative designs considered
