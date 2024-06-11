# Custom Congestion Control Use Case

## Motivation

Motivation
- Allow applications to experiment with what works for their specific use case independent of the standards to improve the speed of innovation and iteration.
- Improve connectivity for users by allowing the application to use its knowledge of the exact usage scenario to better evaluate trade-offs and manage the network connection actively.

## Goals

Congestion control can be done by the application, by doing custom bandwidth estimation and custom pacing and probing.

## API requirements

Applications can do custom bandwidth estimation via:
- Access to information about when RTP packets are sent, both application supplied and UA packetized, and how large they are.
- Access to information about when congestion control feedback (ack messages) are received, and per-packet information about when they were received.
- Access to information used by L4S.
- Knowledge of when an application packet is not sent, and why.
- Efficient control of when packets are sent, in order to do custom pacing and probing.

## API Outline 


```javascript
partial interface RtpSendStream {
  Promise<RtpSendResult> sendRtp(RtpPacketInit packet, RtpSendOptions options);
}

dictionary RtpSendOptions {
  DOMHighResTimeStamp sendTime;
}

interface RtpSendResult {
  readonly attribute SentRtp sent?;
  readonly attribute RtpUnsentReason unsent?;
}

interface SentRtp {
  readonly attribute DOMHighResTimeStamp time;

  // Can be correlated with acks
  readonly attribute unsigned long long ackId?;
  readonly attribute unsigned long long size;
}

enum RtpUnsentReason {
  "overuse",
  "transport-unavailable",
};

// Add this to RTCConfiguration
dictionary RTCConfiguration {
  // Means "continue to encode and packetize packets, but don't send them.
  // Instead give them to me via onpacketizedrtpavailable/readPacketizedRtp
  // and I will send them."
  // TODO: Think of a better name
  bool customPacer;
}

partial interface RtpTransport {
  attribute EventHandler onsentrtp;  // Use readSendRtp
  attribute EventHandler onreceivedrtpacks;  // Use readReceivedRtpAcks
  // Means "when doing bitrate allocation and rate control, don't use more than this"
  attribute unsigned long customMaxBandwidth;
  // Means "make each packet smaller by this much so I can put custom stuff in each packet"
  attribute unsigned long customPerPacketOverhead;
  
  attribute EventHandler onpacketizedrtpavailable;  // No payload.  Call readPacketizedRtp
  sequence<RtpPacket> readPacketizedRtp(optional long maxNumberOfPackets);
  sequence<RtpAcks> readReceivedRtpAcks(optional long maxNumber);
  sequence<SentRtp> readSentRtp(optional long maxNumber);
}

// RFC 8888 or Transport-cc feedback
interface RtpAcks {
  readonly attribute sequence<RtpAck> acks;
  readonly attribute unsigned long long remoteSendTimestamp;
  readonly attribute DOMHighResTimeStamp receivedTime;
  readonly attribute ExplicitCongestionNotification explicitCongestionNotification;  // AKA "ECN"
}

interface RtpAck {
  // Correlated with SentRtp.ackId
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
```

## Examples

## Example 1: Custom BWE

```javascript
const [pc, rtpTransport] = setupPeerConnectionWithRtpTransport();  // Custom
const estimator = createBandwidthEstimator();  // Custom
rtpTransport.onsentrtp = () => {
    for (const sentRtp of rtpTransport.readSentRtp()) {
      if (sentRtpPacket.ackId) {
          estimator.rememberSendRtp(sendRtpPacket);
      }
    }
}
rtpTransport.onreceivedrtpacks = () => {
    for (const rtpAcks in rtpTransport.readReceivedRtpAcks()) {
      for (const rtpAck in rtpAcks.acks) {
          const bwe = estimator.processReceivedAcks(rtpAck);
          rtpTransport.customMaxBandwidth = bwe;
      }
    }
}
```

## Example 2: Custom Pacing and Probing

```javascript
const [pc, rtpTransport] = setupPeerConnectionWithRtpTransport({customPacer: true});  // Custom
const pacer = createPacer();  // Custom
rtpTransport.onpacketizedrtpavailable = () => {
  for (const rtpPacket in rtpTransport.readPacketizedRtp(100)) {
    pacer.enqueue(rtpPacket);
  }
}
while (true) {
    const [rtpSender, packet, sendTime] = await pacer.dequeue();  // Custom
    const sendRtp = rtpSender.sendRtp(packet, {sendTime: sendTime});
    (async () => {
        pacer.handleSentRtp(await sendRtp);
    })();
}
```

## Example 3: Batched pacing
Making use of the synchronous readPacketizedRtp method to only read packets in batches
at a controlled frequency.

```javascript
const [pc, rtpTransport] = setupPeerConnectionWithRtpTransport();  // Custom
const pacer = createPacer();  // Custom
rtpTransport.customPacer = true;

async function pacePacketBatch() {
  rtpTransport.onpacketizedrtpavailable = undefined;
  while(true) {
    let pendingPackets = rtpTransport.readPacketizedRtp(100);
    if (pendingPackets.size() == 0) {
      // No packets available synchronously. Wait for the next available packet.
      rtpTransport.onpacketizedrtpavailable = pacePacketBatch;
      return;
    }
    for (const rtpPacket in rtpTransport.readPacketizedRtp(100)) {
      pacer.enqueue(rtpPacket);
    }
    // Wait 20ms before processing more packets.
    await new Promise(resolve => {setTimeout(resolve, 20)});
  }
}
```

## Alternative designs considered

