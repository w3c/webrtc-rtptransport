# RTCTransport Explainer

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

To enable new use cases, we think it would be useful to provide an API to
send and receive packets with encryption and congestion control. 

## Goals

The RTCTransport API enables web applications to support: 

- Custom payloads (ML-based audio codecs)
- Custom packetization
- Custom FEC 
- Custom RTX
- Custom Jitter Buffer 
- Custom bandwidth estimate
- Custom rate control (with built-in bandwidth estimate)
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

Enable applications to do custom packetization/depacketization by enabling them to:

- Send packets
- Receive packets
- Access information about when packets are sent and how large they are.
- Access information about when packet are not sent, and why.
- Access information about when feedback is received, and what that feedback contains (such as acks, timestamps, and ECN/L4S bits)
- Efficient control of when packets are sent and injection of additonal padding packets, in order to do custom pacing and probing.
- Do batch processing to run much less often than per-packet, to reduce overheads in high bandwidth situations, where packets are sent and received thousands of times per second.

Complexities of sending and receiving packets other than these requirements are still handled by the User Agent, such
as encryption and congestion control.

## Examples

### Example 1: Send packets

```javascript
// TODO
```

### Example 2: Recieve Packets

```javascript
// TODO
```

### Example 3: Send metadata (not RTP header extensions)

```javascript
// TODO
```

### Example 4: Send custom NACK and RTX (not RTP/RTCP)

```javascript
// TODO
```

### Example 5: Send custom FEC

```javascript
// TODO
```

### Example 6: Encode, packetize, and send using WebCodecs

```javascript
// TODO
```

### Example 7: Implement bandwidth estimation, bitrate allocation, and encoder rate control

```javascript
// TODO
```


### Example 8: Send using specific send times (pacing)

```javascript
// TODO
```


