# RTCTransport Explainer

## Problem and Motivation

Real-time communications and streaming technologies are converging within
ultra low latency use cases such as augmented reality/virtual reality,
game streaming or live streaming with fanout. These use cases may involve
peer-to-peer interactions traversing Network Address Translators (NATs)
so that they cannot be addressed solely with client/server APIs. 
For example, streaming a game from a console to a mobile device
or a live streaming application supporting peer-to-peer fanout to
improve scalability.

For these applications, today's WebRTC APIs may not be sufficient, due to: 

- Lack of support for custom metadata. In AR/VR applications, the metadata
can be large enough to require custom packetization and rate control. 

- Lack of codec support. For music, the AAC codec is popular,
but it is not supported in WebRTC implementations. However,
[AAC](https://www.w3.org/TR/webcodecs-aac-codec-registration/) is supported in WebCodecs.

- Lack of custom rate control. While WebRTC's built-in rate control is
general purpose, it does not allow for rapid response to changes in bandwidth,
as is possible with [per-frame QP rate control in WebCodecs](https://docs.google.com/presentation/d/1FpCAlxvRuC0e52JrthMkx-ILklB5eHszbk8D3FIuSZ0/edit#slide=id.g2452ff65d17_0_1).

- Inability to support custom RTCP messages. WebRTC implementations today do
not support feedback messages such as [LRR](https://datatracker.ietf.org/doc/html/draft-ietf-avtext-lrr/), [RPSI](https://datatracker.ietf.org/doc/html/rfc4585#page-39) or [SLI](https://datatracker.ietf.org/doc/html/rfc4585#page-37), or extended statistics as provided by RTCP-XR. 
 
Native applications can use raw UDP sockets, but those are not available on the
web because they lack encryption, congestion control, and a mechanism for
consent to send (to prevent DDoS attacks).

To enable new use cases, this document proposes an API to
send and receive packets with encryption and customizable congestion control. 

## Goals

The RTCTransport API enables web applications to support: 

- Custom payloads (such as ML-based audio codecs)
- Custom packetization
- Custom FEC 
- Custom RTX
- Custom jitter buffers
- Custom bandwidth estimation
- Custom rate control
- Custom bitrate allocation
- Packet forwarding

## Non-goals

This is not [UDP Socket API](https://www.w3.org/TR/raw-sockets/).  We must have
consent, encryption, and congestion control.

## Key use-cases

RTCTransport enables these use cases by enabling applications to:

- Encode with a custom (WASM) codec or WebCodecs, and then packetize and send
- Receive packets, sends custom NACKs, receive those, and send custom retransmissions (RTX)
- Receive packets, put them in a custom jitter buffer, and then decode them using a custom codec (WASM) or WebCodecs
- Receive packets, send custom feedback, receive custom feedback, be notified of built-in feedback, use that information to calculate a bandwidth estimate, and use that estimate to set bitrates of encoders
- Forward packets from one RTCTransport to another, with full control over the entire packet (modulo encryption/CC exceptions)
- Improve connectivity for users by using knowledge of the exact usage scenario to better evaluate trade-offs and manage the network connection actively.


## Extended use cases

This enables the following WebRTC Extended Use Cases: 

- [Section 2.3](https://www.w3.org/TR/webrtc-nv-use-cases/#videoconferencing*): Video Conferencing with a Central Server
- [Section 3.2.1](https://www.w3.org/TR/webrtc-nv-use-cases/#game-streaming): Game streaming
- [Section 3.2.2](https://www.w3.org/TR/webrtc-nv-use-cases/#auction): Low latency Broadcast with Fanout
- [Section 3.5](https://www.w3.org/TR/webrtc-nv-use-cases/#vr*): Virtual Reality Gaming

## API requirements

Enable applications to:

- Establish encrypted peer-to-peer connections
- Send and receive packets over those connections
- Efficient control of when packets are sent and injection of additonal padding packets, in order to do custom pacing and probing.
- Have as much information about packets as possible (times, sizes, ECN bits, etc)
to do custom congestion control.
- Do batch processing to run much less often than per-packet, to reduce overheads in high bandwidth situations, where packets are sent and received thousands of times per second.

Complexities of sending and receiving packets other than these requirements are still handled by the User Agent, such
as encryption.

## Examples

### Example 1: Send packets

```javascript

const certificate = await RTCPeerConnection.generateCertificate({
  name: "ECDSA",
  namedCurve: "P-256",
});
const transport = new RtcTransport({
  name: "ExampleRtc",
  transportControllerType: "automaticIceController",
  certificates: [certificate],
});
transport.setFormat("ICE-DTLS/V0");

const localFingerprints = certificate.getFingerprints();
const firstLocalCandidate = await new Promise((resolve) => {
  transport.networkRouteController.oncandidategathered = (event) => resolve(event.candidate);
});

// TODO: Show how to do trickle ICE
const [remoteFingerprints, remoteCandidates] = doSignaling(localFingerprints, [firstLocalCandidate]);

transport.setRemoteFingerprints(remoteFingerprints);
transport.networkRouteController.setRemoteCandidates(remoteCandidates);

const firstNetworkRoute = await new Promise((resolve) => {
  transport.networkRouteController.oncandidatepairupdated = (event) => resolve(event.candidatePair);
});

const encrypted = await transport.establishEncryption(firstNetworkRoute);
if (encrypted) {
    const now = performance.now();
    transport.sendPackets(
    [
        { id: 1, data: new Uint8Array([0x01, 0x02, 0x03]).buffer, sendTime: now },
        { id: 2, data: new Uint8Array([0x04, 0x05, 0x06]).buffer, sendTime: now },
    ],
    firstNetworkRoute,
    );
}

```

### Example 2: Recieve Packets

```javascript
// TODO
```

### Example 3: Send custom NACK and RTX (not RTP/RTCP)

```javascript
// TODO
```

### Example 4: Send custom FEC

```javascript
// TODO
```

### Example 5: Encode, packetize, and send using WebCodecs

```javascript
// TODO
```

### Example 6: Implement bandwidth estimation, bitrate allocation, and encoder rate control

```javascript
// TODO
```


### Example 7: Send using specific send times (pacing)

```javascript
// TODO
```


