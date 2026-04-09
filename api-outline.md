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

  // Send packets according to their send timestamps on the given route.
  // TODO: Exact behavior needs to be specified for what should happen if the
  //       NetworkRoute is non-viable when packets are scheduled, or if it
  //       becomes non-viable before the scheduled send time.
  void sendPackets(sequence<RtcPacketToSend> packets, NetworkRoute route);

  readonly attribute (RtcManualIceController or RtcAutomaticIceController) transportController;

  // Triggers when the circuit-breaker disabled/re-enables the transport.
  attribute EventHandler ontransportstatus;

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
  attribute EventHandler onerror;

  // If protocol level feedback information could not piggybacked on any user
  // generated packet then the RtcTransport instance will automatically generate
  // and send feedback to the other peer. This event handler notifies the user
  // that some amount of bytes were put on the wire.
  // NOTE: The RtcTransport protocol will always send feedback over the same
  //       NetworkRoute as the packets were received on.
  attribute EventHandler onfeedbacksent;

  // TODO:
  // -- Notification on protocol level traffic being sent.
  // -- Align ICE handing with RTCIceTransport & IceController specs
  // -- Certificates/encryption.
  // -- Bring your own buffers.
  // 
  // OTHER:
  // -- Bring your own buffers?
  // -- Do we need a `setClientRole` that set the role of the peer?
  // -- Worker/Window environment separation
  // -- Details of circuit-breaker operation TBD - severity of crackdowns etc
  // -- Create an RtcTransport protocol RFC?
};
```

A manual ICE controller API
```javascript
interface RtcManualIceController {
  // Will continuously gather host candidates.
  void gatherHostCandidates();

  // Gathers srflx candidates.
  Promise<void> gatherSrflxCandidates(IceServer iceServer);
  // Sends a STUN ping to the IceServer used to discover this candidate, used
  // to keep the candidate (NAT binding) alive. Returns a boolean indicating
  // whether a successful STUN response was received or not.
  // NOTE: Not specifying the IceServer implies that the IceCandidate is tied
  //       to a certain IceServer under the hood.
  Promise<boolean> refreshSrflxCandidate(LocalIceCandidate localCandidate);

  // Gathers relay candidates.
  Promise<void> gatherRelayCandidates(IceServer server, unsigned requestedLifetimeInSeconds);
  // Sends a STUN packet with a LIFETIME attribute included, used to extend the
  // TURN allocation. Returns the actual lifetime granted by the server.
  Promise<unsigned> refreshRelayCandidate(LocalIceCandidate relayCandidate, unsigned requestedLifetimeInSeconds);

  // Creates and object that represents a possible network route. An 
  // IceCandidatePair is a generic "NetworkRouter" object that can be passed to
  // the RtcTransport.send function.
  IceCandidatePair createCandidatePair(LocalIceCandidate local, RemoteIceCandidate remote);

  // Probes the candidate pair to check if it's (still) viable and what the RTT is.
  Promise<IceProbeResult> probeCandidatePair(IceCandidatePair candidatePair);

  // Triggers when a local candidate has been found (IceCandidateGatheredEvent). 
  attribute EventHandler oncandidategathered;

  // Triggers when a local candidate has been removed (lost WIFI etc...).
  attribute EventHandler oncandidateremoved;

  // Triggers when the max payload size of some IceCandidatePair is updated. 
  attribute EventHandler onmaxpayloadsizeupdate;

  // Triggers when there is a candidate gathering error.
  attribute EventHandler onerror;

  // More stuff:
  // - STUN attributes?
  // - What should happen if a the STUN server returns a different IP/port?
  //   Should we return some value indicating that the candidate changed/is
  //   obsolete?
};

```

An automatic ICE controller API
```javascript
interface RtcAutomaticIceController {
  void SetIceServers(sequence<IceServer> servers);

  void gatherCandidates();

  void AddRemoteCandidate(RemoteIceCandidate remoteCandidate);

  // Triggers when a local candidate has been found (IceCandidateGatheredEvent). 
  attribute EventHandler oncandidategathered;

  // Triggers when a local candidate has been removed (lost WIFI etc...).
  attribute EventHandler oncandidateremoved;

  // Triggers when the max payload size is updated. 
  attribute EventHandler onmaxpayloadsizeupdate;

  // Triggers whenever a new IceCandidatePair has been selected. 
  attribute EventHandler oncandidatepairupdated;

  // Triggers when there is a candidate gathering error.
  attribute EventHandler onerror;
};
```

Various helper types

```javascript
dictionary IceServer {
 DOMString url;
 DOMString username;
 DOMString credentials;
};

enum IceCandidateType {
  host,
  srflx,
  prflx,
  relay,
};

interface LocalIceCandidate {
  readonly DOMString ufrag;
  readonly DOMString pwd;
  readonly DOMString address;
  readonly unsigned port;
  readonly IceCandidateType type;
  readonly unsigned networkCost;
};

dictionary RemoteIceCandidate {
  required DOMString ufrag;
  required DOMString pwd;
  required DOMString address;
  required unsigned port;
  required IceCandidateType type;
  unsigned networkCost;
};

interface IceCandidatePair {
  readonly LocalIceCandidate localCandidate;
  readonly RemoteIceCandidate remoteCandidate;
};

enum RtcTransportTransportControllerType {
  automaticIceController,
  manualIceController,
};

dictionary RtcTransportConfig {
  // A name could be useful for debugging/devtools.
  DOMString name;
  RtcTransportTransportControllerType transportControllerType;
  // Certificates?
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

  NetworkRoute networkRoute;
};

dictionary IceCandidateGatheredEvent {
  // Either a string ("host"), or an IceServer (the one passed to
  // gatherCandidates), or an IceCandidate (the remote peer if prflx).
  readonly (DOMString or IceServer or IceCandidate) source;
  readonly LocalIceCandidate candidate;
  readonly unsigned networkCost;

  // Only set if this is a relay candidate.
  readonly unsigned? allocationLifetime;
}
```