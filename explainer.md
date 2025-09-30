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
send and receive packets. 

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
encrypted and congestion-controlled communication.

## Key use-cases

RTCTransport can be used to implement the following use cases: 

- [Use Case 1](https://github.com/w3c/webrtc-rtptransport/blob/main/explainer-use-case-1.md): Custom Packetization
- [Use Case 2](https://github.com/w3c/webrtc-rtptransport/blob/main/explainer-use-case-2.md): Custom Congestion Control

RTCTransport enables these use cases by enabling applications to:

- Encode with a custom (WASM) codec, packetize and send
- Observe packets and customize when NACKs are sent and when to resend with custom RTX behavior
- Receive packets using a custom jitter buffer implementation
- Use WebCodecs for encode or decode, implement packetization/depacketization and a custom jitter buffer
- Observe incoming feedback and/or estimations from built-in congestion control and implement custom rate control (as long as the sending rate is lower than the bandwidth estimate provided by built-in congestion control)
- Obtain a bandwidth estimate from RTCTransport, do bitrate allocation, and set bitrates of encoders
- Forward packets from one RTCTransport to another, with full control over the entire packet (modulo encryption/CC exceptions)
