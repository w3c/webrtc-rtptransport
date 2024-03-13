# Custom Packetization Use Case

## Use case description

In this use case, packetization of encoded video frames (RTCEncodedVideoFrame) or audio frames (RTCEncodedAudioFrame) is handled by the application, as is depacketization. The encoded video or audio frames to be packetized can be obtained from the Encoded Transform API, or can be constructed using WebCodecs or WASM.  The codecs to be packetized/depacketized can be supported natively within WebRTC (e.g. Opus, VP8, H.264, etc.) or they could be codecs supported natively within WebCodecs (e.g. AAC) but not within WebRTC, or they could be codecs implemented in WASM but not supported natively in either WebRTC or WebCodecs (e.g. Lyra or Satin). 

## Goals

For the custom packetization use case, WebRTC-RtpTransport API requires: 

- Custom payloads (ML-based audio codecs)
- Custom packetization
- Custom FEC 
- Custom RTX
- Custom Jitter Buffer 
- Custom bandwidth estimate
- Custom rate control (with built-in bandwidth estimate)
- Custom bitrate allocation
- Custom metadata (header extensions)

## Key use-cases

Custom packetization/depacketiztion enables the following WebRTC Extended Use Cases: 

- [Section 2.3](https://www.w3.org/TR/webrtc-nv-use-cases/#videoconferencing*): Video Conferencing with a Central Server
- [Section 3.2.1](https://www.w3.org/TR/webrtc-nv-use-cases/#game-streaming): Game streaming
- [Section 3.2.2](https://www.w3.org/TR/webrtc-nv-use-cases/#auction): Low latency Broadcast with Fanout
- [Section 3.5](https://www.w3.org/TR/webrtc-nv-use-cases/#vr*): Virtual Reality Gaming

WebRTC-RtpTransport enables these use cases by enabling applications to:

- Encode with a custom (WASM) codec, packetize and send
- Obtain frames from Encoded Transform API, packetize and send
- Obtain frames from Encoded Transform API, apply custom FEC, and send
- Observe incoming NACKs and resend with custom RTX behavior
- Observe incoming packets and customize when NACKs are sent
- Receive packets using a custom jitter buffer implementation
- Use WebCodecs for encode or decode, implement packetization/depacketization and a custom jitter buffer
- Receive packets, depacketize and inject into Encoded Transform (requires a constructor for EncodedAudioFrame/EncodedVideoFrame)
- Observe incoming feedback and/or estimations from built-in congestion control and implement custom rate control (as long as the sending rate is lower than the bandwidth estimate provided by built-in congestion control)
- Obtain frames from Encoded Transform API, packetize, attach custom metadata, and send
- Obtain a bandwidth estimate from RtpTransport, do bitrate allocation, and set bitrates of RtpSenders

## API Outline 

### RtpPacket, RtcpPacket, RtxPacket, RtpHeaderExtension

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

  // Duplicate with header extensions, but conveniently parsed
  readonly attribute DOMString? mid;
  readonly attribute DOMString? rid;
  readonly attribute octet? audioLevel;  
  readonly attribute octet? videoRotation;
  readonly attribute unsigned long long? remoteSendTimestamp;

  // Extra information that may be useful to know
  readonly attribute DOMHighResTimeStamp receivedTime;
  readonly attribute unsigned long sequenceNumberRolloverCount;
}

dictionary RtpPacketInit {
  bool marker = false;
  reuired octet payloadType;
  unsigned short sequenceNumber;  // optional for sendRtp
  required unsigned long timestamp;
  sequence<unsigned long> csrcs = [];
  // Cannot be MID, RID, or congestion control sequence number
  sequence<RtpHeaderExtensionInit> headerExtensions = [];
  required ArrayBuffer payload;

  // Convenience for adding to headerExtensions
  octet audioLevel;    // optional
  octet videoRotation;  // optional
}

interface RtcpPacket {
  constructor(required RtcpPacketInit);
  readonly attribute octet type;
  readonly attribute octet subType;
  readonly attribute ArrayBuffer value;  
}

dictionary RtcpPacketInit {
  required octet type;  // TODO: Should we force the type APP?
  required octet subType;  // AKA FMT
  required ArrayBuffer value;  
}

interface RtxPacket {
  constructor(required RtxPacketInit, RtpPacket);
  readonly attribute octet payloadType;
  readonly attribute unsigned short sequenceNumber;
  readonly attribute unsigned long ssrc;
  readonly attribute RtpPacket originalRtp;  
}

dictionary RtxPacketInit {
  required octet payloadType;
  required unsigned short sequenceNumber;
  required unsigned long ssrc;
}

interface RtpHeaderExtension {
  constructor(required RtpHeaderExtensionInit);
  readonly attribute DOMString uri;
  readonly attribute ArrayBuffer value;
}

dictionary RtpHeaderExtensionInit {
  required DOMString uri;
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
  sequence<RtpSendStream> replaceSendStreams();
}
partial interface RtpReceiver {
  // shared between RtpSenders in the same BUNDLE group
  readonly attribute RtpTransport? rtpTransport;
  sequence<RtpReceiveStream> replaceReceiveStreams();
}

interface RtpTransport {
  // For custom RTCP
  Promise<RtpSendStream> createRtpSendStream(RtpSendStreamInit);
  Promise<RtpReceiveStream> createRtpReceiveStream(RtpReceiveStreamInit);
}

[Exposed=(Window,Worker), Transferable]
interface RtpSendStream {
  readonly attribute DOMString mid?;  // Shared among RtpSendStreams
  readonly attribute DOMString rid?;  // Unique (scoped to MID)
  readonly attribute unsigned long ssrc;
  readonly attribute unsigned long rtxSsrc;

  // Goes to the network
  Promise<RtpSent> sendRtp(RtpPacketInit packet, optional RtpSendOptions options);
  void sendBye();
  
  // Comes from the network
  attribute EventHandler onreceivepli;  // Cancellable
  attribute EventHandler onreceivefir;  // Cancellable
  attribute EventHandler onreceivenack; // sequence<unsigned short>
  attribute EventHandler onreceivebye;

  // not needed if we go with frame-level APIs instead
  attribute EventHandler onrtppacketized;
  sequence<RtpPacket> readPacketizedRtp(maxNumberOfPackets);

  // If browser-owned, goes to the browser, 
  void receivePli();
  void receiveFir();
  void receiveNack(sequence<unsigned short>);
  void receiveBye();

  // If browser-owned, amount the browser expects to use for this RID
  readonly attribute unsigned long allocatedBandwidth;

  // If app-owned, de-allocates the MID, RID, and SSRC
  void close();
}

[Exposed=(Window,Worker), Transferable]
interface RtpReceiveStream {
  readonly attribute DOMString mid?;
  readonly attribute DOMString rid?;
  readonly attribute sequence<unsigned long> ssrcs;
  readonly attribute sequence<unsigned long> rtxSsrcs;

  attribute EventHandler onrtpreceived;
  sequence<RtpPacket> readReceivedRtp(maxNumberOfPackets);

  // Goes to the network
  void sendPli();
  void sendFir();
  void sendNack(sequence<unsigned short>);

  // If browser-owned Comes from the browser;  Cancellable
  attribute EventHandler onsendpli; // cancellable
  attribute EventHandler onsendfir; // cancellable
  attribute EventHandler onsendnack; // sequence<unsigned short> cancellable

  // not needed if we go with frame-level APIs instead
  void depacketizeRtp(RtpPacketInit packet);

  // If app-owned, de-allocates the MID, RID, and SSRC
  void close();
}

```

## Proposed solutions

## Example: Send with custom packetization

```javascript
const pc = new RTCPeerConnection({encodedInsertableStreams: true});
const rtpTransport = pc.createRtpTransport();
pc.getSenders().forEach((sender) => {
  pc.createEncodedStreams().readable.
      pipeThrough(createPacketizingTransformer()).pipeTo(rtpTransport.writable);
});

function createPacketizingTransformer() {
  return new TransformStream({
    async transform(encodedFrame, controller) {
      let rtpPackets = myPacketizer.packetize(frame);
      rtpPackets.forEach(controller.enqueue);
    }
  });
}
```

## Example: Receive with custom packetization

```javascript
const pc = new RTCPeerConnection({encodedInsertableStreams: true});
const rtpTransport = pc.createRtpTransport();
receiver.ontrack = event => {
  const esWriter = event.receiver.createEncodedStreams().writable.getWriter();
  rtpTransport.onrtppacket = (rtpPacket) => {
    let {vBuffer, esWriter} = receivers[getUniqueStreamIdentifier(rtpPacket)];
    vBuffer.insertPacket(rtpPacket);
    // Requires a constructor for EncodedVideoFrame/EncodedAudioFrame
    while (vBuffer.nextFrameReady()) esWriter.write(vBuffer.getFrame());
  }
}
```

## Example: Receive with custom jitter buffer and built-in depacketization

```javascript
const receiver = new RTCPeerConnection({encodedInsertableStreams: true});
receiver.ontrack = e => {
  if (e.track.kind == "video") {
    const es = event.receiver.createEncodedStreams({jitterBuffer: false});
    receiveVideo(es.readable.getReader(), es.writable.getWriter());
  }
  else {
    const es = event.receiver.createEncodedStreams();
    receiveAudio(es.readable.getReader(), es.writable.getWriter());
  }
}
function receiveVideo(reader, writer) {
  while (true) {
    const {value: frame, done} = await reader.read();
    if (done) return;
    vBuffer.insertFrame(frame);
    while (vBuffer.nextFrameReady()) writer.write(vBuffer.getFrame());
  }
}
```

## Example: Custom bitrate allocation

```javascript
const pc = new RTCPeerConnection();
const rtpTransport = pc.createRtpTransport();
rtpTransport.ontargetsendratechanged = () => {
  const rtpSender = pc.getTransceivers()[0];
  const parameters = rtpSender.getParameters();
  parameters.encodings[0].maxBitrate = rtpTransport.targetSendRate;
  rtpSender.setParameters(parameters);
};
```

## Alternative designs considered
