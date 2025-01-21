# API Outline 

```javascript
interface RTCRtpPacket {
  constructor(required RTCRtpPacketInit);
  readonly attribute bool marker;
  readonly attribute octet payloadType;
  readonly attribute unsigned short sequenceNumber;
  readonly attribute unsigned long timestamp;
  readonly attribute unsigned long ssrc;
  readonly attribute sequence<unsigned long> csrcs;
  readonly attribute sequence<RTCRtpHeaderExtension> headerExtensions;
  readonly attribute unsigned long paddingBytes;

  // The MID and RID are possibly inferred by the SSRC,
  // and do not necessarily represent header extension values.
  readonly attribute DOMString? mid;
  readonly attribute DOMString? rid;

  // Write payload to the specified (Shared-)ArrayBuffer/ArrayBufferView,
  // allowing for BYOB. Throws a TypeError if |destination| is smaller than
  // |payloadByteLength|.
  undefined copyPayloadTo(AllowSharedBufferSource destination);
  readonly attribute unsigned long payloadByteLength;

  // OPTIONAL: Extra information that may be useful to know
  readonly attribute DOMHighResTimeStamp receivedTime;
  readonly attribute unsigned long sequenceNumberRolloverCount;

  void setHeaderExtension(RTCRtpHeaderExtension);
}

interface RTCRtpHeaderExtension {
  constructor(required RTCRtpHeaderExtensionInit);
  readonly attribute DOMString uri;
  readonly attribute unsigned long valueByteLength;

  // Write the extension's value to the specified (Shared-)ArrayBuffer/ArrayBufferView,
  // allowing for BYOB. Throws a TypeError if |destination| is smaller than
  // |valueByteLength|.
  undefined copyValueTo(AllowSharedBufferSource destination);
}

dictionary RTCRtpPacketInit {
  bool marker = false;
  required octet payloadType;
  required unsigned long timestamp;
  sequence<unsigned long> csrcs = [];
  // Cannot be MID, RID, or congestion control sequence number
  sequence<RTCRtpHeaderExtensionInit> headerExtensions = [];
  required AllowSharedBufferSource payload;
  // Causes padding bit to be set and padding added when serializing if > 0.
  unsigned long paddingBytes = 0;

  // The RID here specifies which "layer" to send with, and what goes over
  // the wire maybe a specific SSRC, not necessarily a header extension.
  readonly attribute DOMString? rid;
}

dictionary RTCRtpHeaderExtensionInit {
  required DOMString uri;
  required AllowSharedBufferSource value;
}

interface RTCRtcpPacket {
  readonly attribute sequence<RTCRtcpNack> nacks;
}

```
### RTCPeerConnection, RTCRtpPacketSender, RTCRtpPacketReceiver Extensions

```javascript
partial interface RTCPeerConnection {
  // There may be an RtpTransport with no RtpSenders and no RtpReceivers.
  readonly attribute RTCRtpTransport? rtpTransport;
}

// Add this to RTCConfiguration
dictionary RTCConfiguration {
  // Means "continue to encode and packetize packets, but don't send them.
  // Instead give them to me via onpacketizedrtpavailable/readPacketizedRtp
  // and I will send them."
  // TODO: Think of a better name
  bool customPacer;
  // Means "continue to encode and packetize RTCP NACK, but don't send them.
  // Instead give them to me via onpacketizedrtcpavailable/readPacketizedRtcp
  // and I will send them."
  // TODO: Think of a better name
  bool customNack;
}

partial interface RTCRtpSender {
  // shared between RTCRtpSenders in the same BUNDLE group
  readonly attribute RTCRtpTransport? rtpTransport;
  Promise<RTCRtpPacketSender> replacePacketSender();
}

partial interface RTCRtpReceiver {
  // shared between RTCRtpSenders in the same BUNDLE group
  readonly attribute RTCRtpTransport? rtpTransport;
  Promise<RTCRtpPacketReceiver> replacePacketReceiver();
}

interface RTCRtpTransport {
  attribute EventHandler onpacketizedrtpavailable;  // No payload. Call readPacketizedRtp
  sequence<RTCRtpPacket> readPacketizedRtp(maxNumberOfPackets);
  attribute EventHandler onpacketizedrtcpavailable;  // No payload. Call readPacketizedRtcp
  sequence<RTCRtcpPacket> readPacketizedRtcp(maxNumberOfPackets);

  attribute EventHandler onsentrtp;  // No payload. Use readSentRtp
  // Batch interface to read SentRtp notifications.
  sequence<SentRtp> readSentRtp(long maxCount);

  attribute EventHandler onreceivedrtpacks;  // No payload. Use readReceivedRtpAcks
  // Batch interface to read RtpAcks as an alternative to onrtpacksreceived.
  sequence<RtpAcks> readReceivedRtpAcks(long maxCount);

  readonly attribute unsigned long bandwidthEstimate;  // bps
  readonly attribute unsigned long allocatedBandwidth;  // bps
  attribute unsigned long customAllocatedBandwidth;  // writable
  // Means "when doing bitrate allocation and rate control, don't use more than this"
  attribute unsigned long customMaxBandwidth;
  // Means "make each packet smaller by this much so I can put custom stuff in each packet"
  attribute unsigned long customPerPacketOverhead;
}

// RFC 8888 or Transport-cc feedback
interface RTCRtpAcks {
  readonly attribute sequence<RTCRtpAck> acks;
  readonly attribute unsigned long long remoteSendTimestamp;
  readonly attribute DOMHighResTimeStamp receivedTime;
  readonly attribute RTCExplicitCongestionNotification explicitCongestionNotification;  // AKA "ECN"
}

interface RTCRtpAck {
  // Correlated with RtpSent.ackId
  readonly attribute unsigned long long ackId; 
  readonly attribute unsigned long long remoteReceiveTimestamp;
}

// See RFC 3991 and RFC 3168
enum RTCExplicitCongestionNotification {
  // ECT = ECN-Capable Transport
  "unset",  // AKA "Not-ECT";  Bits: 00
  "scalable-congestion-not-experienced",  // AKA "ECT(1)" or "Scalable" or "L4S" ; Bits: 01
  "classic-congestion-not-experienced", // AKA "ECT(0)" or "Classic" or "not L4S"; Bits: 10
  "congestion-experienced" // AKA "CE" or "ECN-marked" or "marked"; Bits: 11
}

[Exposed=(Window,Worker), Transferable]
interface RTCRtpPacketSender {
  readonly attribute DOMString mid?;
  // The "layers" of an RtpPacketSender correspond to the "encodings" of an RTP transceiver
  // and are primarily used for simulcast.
  readonly sequence<RTCRtpPacketSenderLayer> layers;

  attribute EventHandler onpacketizedrtp;
  sequence<RTCRtpPacket> readPacketizedRtp(long maxNumberOfPackets);

  attribute EventHandler onreceivedrtcpnacks;
  sequence<RTCRtcpNack> readReceivedRtcpNacks(long maxNumberOfPackets);

  // https://github.com/w3c/webrtc-rtptransport/issues/32
  void sendRtp(RTCRtpPacket packet);
  Promise<RTCRtpSendResult> sendRtp(RTCRtpPacketInit packet, RTCRtpSendOptions options);
  
  // Amount allocated by the browser
  readonly attribute unsigned long allocatedBandwidth;
}

dictionary RTCRtpPacketSenderLayer {
  readonly attribute DOMString rid?;
  readonly attribute unsigned long ssrc;
  readonly attribute unsigned long rtxSsrc;
}

interface RTCRtpSendResult {
  readonly attribute RTCRtpSent sent?;
  readonly attribute RTCRtpUnsentReason unsent?;
}

interface RTCRtpSent {
  readonly attribute DOMHighResTimeStamp time;

  // Can be correlated with acks
  readonly attribute unsigned long long ackId?;
  readonly attribute unsigned long long size;
}

enum RTCRtpUnsentReason {
  "overuse",
  "transport-unavailable",
};

dictionary RTCRtpSendOptions {
  DOMHighResTimeStamp sendTime;
  // Serializes the first two bytes of the RTP payload as an RTX payload
  // and sends using the RTX ssrc.
  bool asRtx;
}

interface RTCRtcpNack {
  readonly attribute sequence<unsigned short> sequenceNumbers;
}

[Exposed=(Window,Worker), Transferable]
interface RTCRtpPacketReceiver {
  readonly attribute DOMString mid?;
  readonly attribute sequence<unsigned long> ssrcs;
  readonly attribute sequence<unsigned long> rtxSsrcs;

  attribute EventHandler onreceivedrtp;
  sequence<RTCRtpPacket> readReceivedRtp(long maxNumberOfPackets);

  void receiveRtp(RTCRtpPacket packet);

  void sendNack(sequence<unsigned short>);
}
```