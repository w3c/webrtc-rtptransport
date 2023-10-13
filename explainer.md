# WebRTC-RtpTransport Explainer

## Problem and Motivation

Today realtime communications and streaming technologies are converging within
ultra low latency use cases such as augmented reality/virtual reality,
game streaming or live streaming with fanout. These use cases may involve
peer-to-peer interactions traversing Network Address Translators (NATs)
so that they cannot be addressed solely with client/server APIs. 
For example, streaming a game from a console to a mobile device
or a live streaming application supporting peer-to-peer fanout to
improve scalability.

For these applications, today's WebRTC APIs may not be sufficient, due to: 

-- Lack of support for custom metadata. In AR/VR applications, the metadata
can be large enough to require custom packetization and rate control. 

-- Lack of codec support. For music, the AAC codec is popular,
but it is not supported in WebRTC implementations. However,
[AAC](https://www.w3.org/TR/webcodecs-aac-codec-registration/) is supported in WebCodecs.

-- Lack of custom rate control. While WebRTC's built-in rate control is
general purpose, it does not allow for rapid response to changes in bandwidth,
as is possible with [per-frame QP rate control in WebCodecs](https://docs.google.com/presentation/d/1FpCAlxvRuC0e52JrthMkx-ILklB5eHszbk8D3FIuSZ0/edit#slide=id.g2452ff65d17_0_1).

-- Inability to support custom RTCP messages. WebRTC implementations today do
not support feedback messages such as [LRR](https://datatracker.ietf.org/doc/html/draft-ietf-avtext-lrr/), [RPSI](https://datatracker.ietf.org/doc/html/rfc4585#page-39) or [SLI](https://datatracker.ietf.org/doc/html/rfc4585#page-37), or extended statistics as provided by RTCP-XR. 
 
Native applications can use raw UDP sockets, but those are not available on the
web because they lack encryption, congestion control, and a mechanism for
consent to send (to prevent DDoS attacks).

To enable new use cases, we think it would be useful to provide an API to
send and receive RTP and RTCP packets. 

## Goals

The WebRTC-RtpTransport API enables web applications to support: 

- Custom payloads (ML-based audio codecs)
- Custom packetization
- Custom FEC 
- Custom RTX
- Custom Jitter Buffer 
- Custom bandwidth estimate
- Custom rate control (with built-in bandwidth estimate)
- Custom bitrate allocation
- Custom metadata (header extensions)
- Custom RTCP messages
- Custom RTCP message timing
- RTP forwarding

## Non-goals

This is not [UDP Socket API](https://www.w3.org/TR/raw-sockets/).  We must have
encrypted and congestion-controlled communication.

## Key use-cases

WebRTC-RtpTransport can be used to implement the following WebRTC Extended Use Cases: 

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
- Forward RTP/RTCP packets from one PeerConnection to another, with full control over the entire packet (modulo SRTP/CC exceptions)

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

