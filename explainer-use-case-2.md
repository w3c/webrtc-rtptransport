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

partial interface RtpTransport {
  attribute EventHandler onrtpsent;  // RtpSent
  attribute EventHandler onrtpacksreceived;  // RtpAcks
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
```

## Examples

## Example 1: Custom BWE

```javascript
const [pc, rtpTransport] = setupPeerConnectionWithRtpTransport();  // Custom
const estimator = createBandwidthEstimator();  // Custom
rtpTransport.onrtpsent = (rtpSent) => {
    if (rtpSent.ackId) {
        estimator.rememberRtpSent(rtpSent);
    }
}
rtpTransport.onrtpacksreceived = (rtpAcks) => {
    for (const rtpAck in rtpAcks.acks) {
        const bwe = estimator.processReceivedAcks(rtpAck);
        doBitrateAllocationAndUpdateEncoders(bwe);  // Custom
    }
}

```

## Example 2: Custom Pacing and Probing

```javascript
const [pc, rtpSender1, rtpSender2] = setupPeerConnectionWithRtpSenders();  // Custom
const pacer = createPacer();  // Custom
while (true) {
    // Packets are queued by using pacer.sendRtp(rtpSender, rtpPacket) instead of rtpSender.sendRtp(rtpPacket)
    const [rtpSender, packet, sendTime] = await pacer.dequeue();  // Custom
    const rtpSent = rtpSender.sendRtp(packet, {sendTime: sendTime});
    (async () => {
        pacer.handleSent(await rtpSent);
    })();
}
```


## Alternative designs considered

