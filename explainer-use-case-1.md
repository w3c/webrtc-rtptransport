# Custom Packetization Use Case

## Extended use cases

Custom packetization/depacketization enables the following WebRTC Extended Use Cases: 

- [Section 2.3](https://www.w3.org/TR/webrtc-nv-use-cases/#videoconferencing*): Video Conferencing with a Central Server
- [Section 3.2.1](https://www.w3.org/TR/webrtc-nv-use-cases/#game-streaming): Game streaming
- [Section 3.2.2](https://www.w3.org/TR/webrtc-nv-use-cases/#auction): Low latency Broadcast with Fanout
- [Section 3.5](https://www.w3.org/TR/webrtc-nv-use-cases/#vr*): Virtual Reality Gaming

## Detailed description

In this use case, packetization of encoded video frames (RTCEncodedVideoFrame) or audio frames (RTCEncodedAudioFrame) is handled by the application, as is depacketization. The encoded video or audio frames to be packetized can be obtained from the Encoded Transform API, or can be constructed using WebCodecs or WASM.  The codecs to be packetized/depacketized can be supported natively within WebRTC (e.g. Opus, VP8, H.264, etc.) or they could be codecs supported natively within WebCodecs (e.g. AAC) but not within WebRTC, or they could be codecs implemented in WASM but not supported natively in either WebRTC or WebCodecs (e.g. Lyra or Satin). 

Custom packetization/depacketization enables applications to do things such as:
- Encode with a custom (WASM) codec, packetize and send
- Obtain frames from Encoded Transform API, packetize and send
- Obtain frames from Encoded Transform API, apply custom FEC, and send
- Observe incoming NACKs and resend with custom RTX behavior
- Observe incoming packets and customize when NACKs are sent
- Receive packets using a custom jitter buffer implementation
- Use WebCodecs for encode or decode, implement packetization/depacketization and a custom jitter buffer
- Receive packets, depacketize and inject into Encoded Transform (relies on a constructor for EncodedAudioFrame/EncodedVideoFrame)
- Obtain frames from Encoded Transform API, packetize, attach custom metadata, and send
- Obtain a bandwidth estimate from RtpTransport, do bitrate allocation, and set bitrates of RtpSenders

## API requirements

Enable applications to do custom packetization/depacketization by enabling them to:

- Send RTP packets for a particular RtpSender with an RTP timestamp and RTP payload chosen by the application.
- Receive RTP packets for a particular RtpReceiver and prevent the browser from further processing them.
- Know what bitrates the browser has already allocate to send.
- Know what bitrate can be sent in addition to what the browser has already allocated to send.
- Cause the browser to allocate less to send, leaving more bitrate available to the application to send.

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
  readonly attribute ArrayBuffer payload;

  // OPTIONAL: Duplicate with header extensions, but conveniently parsed
  readonly attribute DOMString? mid;
  readonly attribute DOMString? rid;
  readonly attribute octet? audioLevel;  
  readonly attribute octet? videoRotation;
  readonly attribute unsigned long long? remoteSendTimestamp;

  // OPTIONAL: Extra information that may be useful to know
  readonly attribute DOMHighResTimeStamp receivedTime;
  readonly attribute unsigned long sequenceNumberRolloverCount;
}

interface RtpHeaderExtension {
  constructor(required RtpHeaderExtensionInit);
  readonly attribute DOMString uri;
  readonly attribute ArrayBuffer value;
}

dictionary RtpPacketInit {
  bool marker = false;
  required octet payloadType;
  // When sending, can be filled in automatically
  unsigned short sequenceNumber;
  required unsigned long timestamp;
  sequence<unsigned long> csrcs = [];
  // Cannot be MID, RID, or congestion control sequence number
  sequence<RtpHeaderExtensionInit> headerExtensions = [];
  required ArrayBuffer payload;

  // Convenience for adding to headerExtensions
  octet audioLevel;
  octet videoRotation;
}

dictionary RtpHeaderExtensionInit {
  required DOMString uri;
  required ArrayBuffer value;
}

interface RtcpPacket {
  constructor(required RtcpPacketInit);
  readonly attribute octet type;
  readonly attribute octet subType;
  readonly attribute ArrayBuffer value;  
}

dictionary RtcpPacketInit {
  // TODO: Should we force the type APP?
  required octet type;
  required octet subType;  // AKA FMT
  required ArrayBuffer value;  
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

  void sendRtp(RtpPacketInit packet);
  
  // Amount allocated by the browser
  readonly attribute unsigned long allocatedBandwidth;
}

[Exposed=(Window,Worker), Transferable]
interface RtpReceiveStream {
  readonly attribute DOMString mid?;  // Shared among many RtpReceivetreams
  readonly attribute DOMString rid?;  // Unique to RtpReceiveStream (scoped to MID)
  readonly attribute sequence<unsigned long> ssrcs;
  readonly attribute sequence<unsigned long> rtxSsrcs;

  attribute EventHandler onrtpreceived;
  sequence<RtpPacket> readReceivedRtp(long maxNumberOfPackets);
}
```

## Examples

## Example 1: Send with custom packetization (using WebCodecs)

```javascript
const videoTrack = await openVideoTrack();  // Custom
const [pc, videoRtpSender] = await setupPeerConnectionWithRtpSender();  // Custom
const videoRtpSendStream = await videoRtpSender.replaceSendStreams()[0];
const videoTrackProcessor = new MediaStreamTrackProcessor(videoTrack);
const videoFrameReader = videoTrackProcessor.readable.getReader();
const videoEncoder = new VideoEncoder({
  output: (videoChunk, cfg) => {
    const videoRtpPackets = packetizeVideoChunk(videoChunk, cfg);
    for (const videoRtpPacket of videoRtpPackets) {
      videoRtpSendStream.sendRtp(videoRtpPacket);
    }
  }
});
while (true) {
  const { done, videoFrame } = await videoFrameReader.read();
  videoEncoder.configure({
    latencyMode: "realtime",
    codec: "vp8",
    framerate: 30,
    bitrate: videoRtpSendStream.allocatedBandwidth,
  });
  videoEncoder.encode(videoFrame);
  if (done) {
    break;
  }
}
```

## Example 2: Receive with custom packetization (using WebCodecs)
```javascript
const [pc, videoRtpReceiver] = await setupPeerConnectionWithRtpReceiver();  // Custom
const videoRtpReceiveStream = await videoRtpReceiver.replaceReceiveStreams()[0];  // Custom
const videoDecoder = new VideoDecoder({
  output: (frame) => {
    renderVideoFrame(frame);  // Custom
  }
});
videoRtpReceiveStream.onrtpreceived = () => {
  const videoRtpPackets = videoRtpReceiveStream.readReceivedRtp(10);
  for (const videoRtpPacket of videoRtpPackets) {
    const assembledVideoFrames = depacketizeVideoRtpPacketAndInjectIntoJitterBuffer(videoRtpPacket);  // Custom
    for (const assembledVideoFrame of assembledVideoFrames) {
      // Question: can assembledVideoFrames be assumed to be decodable (e.g. no gaps)?
      decoder.decode(assembledVideoFrame);
    }
  }
};
```

## Example 3: Custom bitrate allocation
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


## Alternative designs considered
