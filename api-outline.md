# API Outline 

STATUS: working draft
```javascript
[Exposed=Window,Worker]
interface RtcTransport {
  // Should the user be able to add/remove iceServers after the transport has
  // been created?
  constructor(RtcTransportConfig config);

  // NOTE: Negotiation of wire formats exist for the purpose of evolving the
  //       wire format, and the protocol if needed. Older formats should be
  //       considered deprecated and will be removed after some time.
  static readonly attribute FrozenArray<RtcTransportFormat> supportedFormats;

  // NOTE: A function like `setFormat` implies that the app decides on the wire
  //       format. May only be called once.
  // NOTE: The reason for not setting it in the ctor is so that the user can
  //       start collecting candidates before signaling with the remote has
  //       happened.
  undefined setFormat(RtcTransportFormat format);

  // Send packets according to their send timestamps on the given route.
  // TODO: Exact behavior needs to be specified for what should happen if the
  //       networkRoute is non-viable when packets are scheduled, or if it
  //       becomes non-viable before the scheduled send time.
  undefined sendPackets(sequence<RtcPacketToSend> packets, RtcNetworkRoute networkRoute);

  // Set the fingerprints of the certificate of the peer.
  void setRemoteFingerprints(sequence<ArrayBuffer> fingerprint);

  // After a viable RtcNetworkRoute has been found then a handshake needs to be
  // initiated or completed before `sendPackets` can be used. The promise
  // resolves with `true` when encryption is successfully establish, `false`
  // otherwise.
  Promise<boolean> establishEncryption(RtcNetworkRoute networkRoute);

  // The type depends on which `RtcNetworkRouteControllerType` that was given in
  // the constructor.
  readonly attribute RtcNetworkRouteController networkRouteController;

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
  //       RtcNetworkRoute as the packets were received on.
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
[Exposed=Window,Worker]
interface RtcManualIceController {
  // Will continuously gather host candidates.
  undefined gatherHostCandidates();

  // Gathers srflx candidates.
  Promise<undefined> gatherSrflxCandidates(IceServer iceServer);
  // Sends a STUN ping to the IceServer used to discover this candidate, used
  // to keep the candidate (NAT binding) alive. Returns a boolean indicating
  // whether a successful STUN response was received or not.
  // NOTE: Not specifying the IceServer implies that the IceCandidate is tied
  //       to a certain IceServer under the hood.
  Promise<boolean> refreshSrflxCandidate(LocalIceCandidate localCandidate);

  // Gathers relay candidates.
  Promise<undefined> gatherRelayCandidates(IceServer server, unsigned long requestedLifetimeInSeconds);
  // Sends a STUN packet with a LIFETIME attribute included, used to extend the
  // TURN allocation. Returns the actual lifetime granted by the server.
  Promise<unsigned long> refreshRelayCandidate(LocalIceCandidate relayCandidate, unsigned long requestedLifetimeInSeconds);

  // Creates an IceCandidatePair that represents a possible network route.
  IceCandidatePair createCandidatePair(LocalIceCandidate local, RemoteIceCandidateInit remote);

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
[Exposed=Window,Worker]
interface RtcAutomaticIceController {
  undefined SetIceServers(sequence<IceServer> servers);

  undefined gatherCandidates();

  undefined AddRemoteCandidate(RemoteIceCandidateInit remoteCandidate);

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
typedef (RtcManualIceController or RtcAutomaticIceController) RtcNetworkRouteController;
typedef IceCandidatePair RtcNetworkRoute;


// As the wire/feedback format evolves new enums will be added to describe them.
// Examples could be "DTLS/V1" or "QUIC/V0".
enum RtcTransportFormat {
  "DTLS/V0",
};

enum RtcNetworkRouteControllerType {
  "automaticIceController",
  "manualIceController",
};

dictionary RtcTransportConfig {
  // A name could be useful for debugging/devtools.
  required DOMString name;
  required RtcNetworkRouteControllerType transportControllerType;
  required sequence<RTCCertificate> certificates;
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

  RtcNetworkRoute networkRoute;
};

```

Various ICE related helper types

```javascript
dictionary IceServer {
  required DOMString url;
  required DOMString username;
  required DOMString credentials;
};

enum IceCandidateType {
  "host",
  "srflx",
  "prflx",
  "relay",
};

[Exposed=Window,Worker]
interface LocalIceCandidate {
  readonly attribute DOMString ufrag;
  readonly attribute DOMString pwd;
  readonly attribute DOMString address;
  readonly attribute unsigned short port;
  readonly attribute IceCandidateType type;
  readonly attribute unsigned short networkCost;
}; 

[Exposed=Window,Worker]
interface RemoteIceCandidate {
  readonly attribute DOMString ufrag;
  readonly attribute DOMString pwd;
  readonly attribute DOMString address;
  readonly attribute unsigned short port;
  readonly attribute IceCandidateType type;
  readonly attribute unsigned short networkCost;
}; 

dictionary RemoteIceCandidateInit {
  required DOMString ufrag;
  required DOMString pwd;
  required DOMString address;
  required unsigned short port;
  required IceCandidateType type;
  unsigned short networkCost;
};

[Exposed=Window,Worker]
interface IceCandidatePair {
  readonly attribute LocalIceCandidate localCandidate;
  // TODO: Invalid IDL, a dictionary can not be an attribute.
  readonly attribute RemoteIceCandidate remoteCandidate;
};

[Exposed=Window,Worker]
interface IceCandidateGatheredEvent : Event {
  // Either a string ("host"), or an IceServer (the one passed to
  // gatherCandidates), or an IceCandidate (the remote peer if prflx).
  // TODO: Invalid IDL: A dictionary (IceServer, IceCandidate) can not be an
  // attribute.
  readonly attribute (DOMString or IceServer or IceCandidate) source;
  readonly attribute LocalIceCandidate candidate;
  readonly attribute unsigned long networkCost;

  // Only set if this is a relay candidate.
  readonly attribute unsigned long? allocationLifetime;
};
```
