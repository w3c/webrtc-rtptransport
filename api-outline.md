# API Outline 

STATUS: working draft

```javascript
interface RtcTransport {
  // Should the user be able to add/remove iceServers after the transport has
  // been created?
  constructor(RtcTransportConfig config);

  // SRTP/V0, DTLS/V0, DTLS/V1, QUIC/V1, SomeGreatWireformat/V1
  // NOTE: Negotiation of wire formats exist for the purpose of evolving the
  //       wire format, and the protocol if needed. Older formats should be
  //       considered deprecated and will be removed after some time.
  readonly attribute sequence<DOMString> supportedFormats;

  // NOTE: A function like `setFormat` implies that the app decides on the wire
  //       format. May only be called once.
  // NOTE: The reason for not setting it in the ctor is so that the user can
  //       start collecting candidates before signaling with the remote has
  //       happened.
  void setFormat(DOMString wireFormat);

  // Largest allowed packet payload size.
  readonly attribute unsigned maxPacketsizeBytes;

  // Gathers local candidates using the specified STUN/TURN server. Promise
  // resolves when gathering is done.
  // TODO: Should there be timeout parameter as well?
  // TODO: STUN attributes?
  // TODO: Gather host candidates, separate function or just null iceServer?
  promise<void> gatherCandidates(IceServer iceServer);

  // Triggers when a local candidate has been found.
  attribute EventHandler oncandidate;

  // Tries to establish a path using the specified pair. The promise will either
  // return a probe result or some error. Can also be used to continuously
  // probe/keep the path alive.
  // NOTE: As soon as the first viable path is found then encryption between the
  //       two peers will be established. Only after that has succeeded will the
  //       promise resolve.
  // TODO: STUN attributes?
  // TODO: What RTT should be measured when using TURN, the TURN server or
  //       the other peer?
  promise<RtcProbeResult> probePath(CandidatePair);

  // Triggers when a local candidate has been removed (lost WIFI etc...).
  attribute EventHandler oncandidateremoved;

  // Triggers when the circuit-breaker kicks in.
  attribute EventHandler oncandidatedisabled;

  // Triggers when the circuit-breaker backs off.
  attribute EventHandler oncandidateenabled;

  // Send Packets according to their send timestamps on the given path.
  // NOTE: Only `CandidatePair`s that was successfully probed with `probePath`
  //       are accepted.
  // TODO: Should we have a `nominateCandidatePair` function instead? Would 
  //       that require "IceRoles"? Could "IceRoles" and path nominations be
  //       implement at the app level?
  void sendPackets(sequence<RtcPacketToSend>, CandidatePair);

  // Notifies the app that `getPacketSentInfo` can be called to get information
  // about sent packets. The app only get notified once per call to
  // `getPacketSentInfo`.
  attribute EventHandler onpendingpacketssentinfo;
  sequence<RtcPacketSentInfo> getPacketSentInfo();

  // Notifies the app that `getReceivedPacket` can be called to get received
  // packets. The app only get notified once per call to `getReceivedPacket`.
  attribute EventHandler onpendingpacketsreceived;
  sequence<RtcPacketReceived> getReceivedPacket();

  // Notifies the app about errors such as:
  // - Sent packet information buffer overflow.
  // - Packet feedback buffer overflow.
  // - Receive buffer overflow.
  // - Candidate gathering errors.
  attribute EventHandler onerror;

  // If protocol level feedback information could not piggybacked on any user
  // generated packet then the RtcTransport instance will automatically generate
  // and send feedback to the other peer. This event handler notifies the user
  // that some amount of bytes were put on the wire.
  // NOTE: The RtcTransport protocol will always send feedback over the same
  //       CandidatePair as the packets were received on.
  attribute EventHandler onfeedbacksent;

  // TODO:
  // -- Notification on protocol level traffic being sent.
  // -- Align ICE handing with RTCIceTransport & IceController specs
  // -- Certificates/enceryption.
  // -- Bring your own buffers.
  // 
  // OTHER:
  // -- Bring your own buffers?
  // -- Do we need a `setClientRole` that set the role of the peer?
  // -- Worker/Window environment seperation
  // -- Details of circuit-breaker operation TBD - severity of crackdowns etc
  // -- Create an RtcTransport protocol RFC?
};
```

Various helper types

```javascript
dictionary IceServer {
  DOMString url;
  DOMString username;
  DOMString credential;
};

enum CandidateType {
  host,
  srflx,
  prflx,
  relay,
}

dictionary Candidate {
  DOMString ufrag;
  DOMString pwd;
  DOMString address;
  unsigned port;
  CandidateType type;
  unsigned networkCost;
};

dictionary RtcTransportConfig {
  // A name could be useful for debugging/devtools.
  DOMString name;
  // Certificates?
};

dicitonary CandidatePair {
  Candidate localCandidate;
  Candidate remoteCandidate;
};

dictionary RtcProbeResult {
  // If true then the path can be used to send data over.
  boolean pathIsViable;
  double RttMs;
};

dictionary RtcPacketToSend {
  // The `id` is used by the app to map packets sent with `sendPackets` to
  // information received in `RtcPacketSentInfo`.
  // NOTE: Must be strictly monotonically increasing.
  long long id;

  // TODO: BYOB, Change to a SetBuffer function.
  ArrayBuffer data;
  // The `sendTime`` must be monotonically increasing across all calls to 
  // `sendPackets`. Sends the packet when time is
  // `window.performance.timeOrigin + window.performance.now()`
  DOMHighResTimeStamp sendTime;
};

dictionary RtcPacketSentInfo {
  long long id;
  long long packetSizeBytes;
  DOMHighResTimeStamp sendTime;
};

dictionary RtcPacketReceived {
  // TODO: BYOB, change to a CopyToBuffer function.
  // TODO: L4S/ECN
  ArrayBuffer data;
  DOMHighResTimeStamp receiveTime;
  CandidatePair candidatePair;
  // Should we also expose which candidate pair that was used for this packet?
};
```