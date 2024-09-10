# WebRTC-RtpTransport

A proposed API that allows web applications to send and receive packets using the RTP/RTCP protocol, defined in [RFC 3550](https://datatracker.ietf.org/doc/html/rfc3550). 

The WebRTC-RtpTransport API is compatible with existing WebRTC APIs, including [WebRTC-PC](https://w3c.github.io/webrtc-pc/) (RTCPeerConnection)
and [WebRTC Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/), and can be combined with
[WebCodecs](https://w3c.github.io/webcodecs/). This allows applications to leverage existing APIs, simplifying the transition, while
allowing applications to decide which pipeline stages to replace or keep.  

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
  
# Samples

See the [explainer](https://github.com/w3c/webrtc-rtptransport/blob/main/explainer.md) for more info.

See the [Custom Packetization Use Case ](https://github.com/w3c/webrtc-rtptransport/blob/main/explainer-use-case-1.md) for some API info.

See the [API outline ](https://github.com/w3c/webrtc-rtptransport/blob/main/api-outline.md)
