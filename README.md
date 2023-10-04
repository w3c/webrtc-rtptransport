# WebRTC-RtpTransport

An API that allows web applications to send and receive packets using the RTP/RTCP protocol, defined in [RFC 3550](https://datatracker.ietf.org/doc/html/rfc3550). 

RtpTransport is compatible with existing WebRTC APIs, including [WebRTC-PC](https://w3c.github.io/webrtc-pc/) (RTCPeerConnection)
and [WebRTC Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/), and can be combined with
[WebCodecs](https://w3c.github.io/webcodecs/). This allows applications to leverage existing APIs, simplifying the transition, while
allowing applications to decide which pipeline stages to replace or keep.  

RtpTransport enables web applications to support: 
- Custom payloads (such as ML-based audio codecs)
- Custom packetization 
- Custom FEC
- Custom RTX
- Custom Jitter Buffer
- Custom bandwidth estimation (BWE)
- Custom bitrate allocation
- Custom metadata (header extensions)
- Custom RTCP messages
- RTP Forwarding

See the [explainer](https://github.com/aboba/rtptransport/blob/main/explainer.md) for more info.

See the [proposed spec]().

# Samples

   
