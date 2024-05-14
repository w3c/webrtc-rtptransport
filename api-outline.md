# API Outline 

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
  readonly attribute octet id;
  readonly attribute ArrayBuffer value;
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
  required octet id;
  required AllowSharedBufferSource value;
}

```
### PeerConnection, RtpSendStream, RtpReceiveStream Extensions

```javascript
partial interface PeerConnection {
  // There may be an RtpTransport with no RtpSenders and no RtpReceivers.
  readonly attribute RtpTransport? rtpTransport;
}

// Add this to RTCConfiguration
dictionary RTCConfiguration {
  // Means "continue to encode and packetize packets, but don't send them.
  // Instead give them to me via onpacketizedrtpavailable/readPacketizedRtp
  // and I will send them."
  // TODO: Think of a better name
  bool customPacer;
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
  attribute EventHandler onrtpsent;  // RtpSent
  attribute EventHandler onrtpacksreceived;  // RtpAcks
  attribute EventHandler onpacketizedrtpavailable;  // No payload. Call readPacketizedRtp
  sequence<RtpPacket> readPacketizedRtp(maxNumberOfPackets);

  readonly attribute unsigned long bandwidthEstimate;  // bps
  readonly attribute unsigned long allocatedBandwidth;  // bps
  attribute unsigned long customAllocatedBandwidth;  // writable
  // Means "when doing bitrate allocation and rate control, don't use more than this"
  attribute unsigned long customMaxBandwidth;
  // Means "make each packet smaller by this much so I can put custom stuff in each packet"
  attribute unsigned long customPerPacketOverhead;
}

// RFC 8888 or Transport-cc feedback
interface RtpAcks {
  readonly attribute sequence<RtpAck> acks;
  readonly attribute unsigned long long remoteSendTimestamp;
  readonly attribute DOMHighResTimeStamp receivedTime;
  readonly attribute ExplicitCongestionNotification explicitCongestionNotification;  // AKA "ECN"
}

interface RtpAck {
  // Correlated with RtpSent.ackId
  readonly attribute unsigned long long ackId; 
  readonly attribute unsigned long long remoteReceiveTimestamp;
}

// See RFC 3991 and RFC 3168
enum ExplicitCongestionNotification {
  // ECT = ECN-Capable Transport
  "unset",  // AKA "Not-ECT";  Bits: 00
  "scalable-congestion-not-experienced",  // AKA "ECT(1)" or "Scalable" or "L4S" ; Bits: 01
  "classic-congestion-not-experienced", // AKA "ECT(0)" or "Classic" or "not L4S"; Bits: 10
  "congestion-experienced" // AKA "CE" or "ECN-marked" or "marked"; Bits: 11
}

[Exposed=(Window,Worker), Transferable]
interface RtpSendStream {
  readonly attribute DOMString mid?;  // Shared among many RtpSendStreams
  readonly attribute DOMString rid?;  // Unique to RtpSendStream (scoped to MID)
  readonly attribute unsigned long ssrc;
  readonly attribute unsigned long rtxSsrc;

  attribute EventHandler onpacketizedrtp;
  sequence<RtpPacket> readPacketizedRtp(long maxNumberOfPackets);

  // https://github.com/w3c/webrtc-rtptransport/issues/32
  void sendRtp(RtpPacket packet);
  Promise<RtpSendResult> sendRtp(RtpPacketInit packet, RtpSendOptions options);
  
  // Amount allocated by the browser
  readonly attribute unsigned long allocatedBandwidth;
}

interface RtpSendResult {
  readonly attribute RtpSent sent?;
  readonly attribute RtpUnsentReason unsent?;
}

interface RtpSent {
  readonly attribute DOMHighResTimeStamp time;

  // Can be correlated with acks
  readonly attribute unsigned long long ackId?;
  readonly attribute unsigned long long size;
}

enum RtpUnsentReason {
  "overuse",
  "transport-unavailable",
};

dictionary RtpSendOptions {
  DOMHighResTimeStamp sendTime;
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