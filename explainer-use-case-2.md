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

## Examples

### Example 1: Custom BWE

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
        rtpTransport.customMaxBandwidth = bwe;
    }
}

```

### Example 2: Custom Pacing and Probing

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
    const rtpSent = rtpSender.sendRtp(packet, {sendTime: sendTime});
    (async () => {
        pacer.handleSent(await rtpSent);
    })();
}
```

### Example 3: Batched pacing
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

