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
- Efficient control of when packets are sent and injection of additonal padding packets, in order to do custom pacing and probing.

Applications need to be be able to batch processing to run much less often than per-packet, to reduce overheads in high bandwidth situations, where packets are sent and received thousands of times per second.

## Examples

## Example 1: Custom BWE

```javascript
const [pc, rtpTransport] = setupPeerConnectionWithRtpTransport();  // Custom
const estimator = createBandwidthEstimator();  // Custom
rtpTransport.onsentrtp = () => {
  for (const sentRtp of rtpTransport.readSentRtp(100)) {
    if (sentRtp.ackId) {
        estimator.rememberSentRtp(sentRtp);
    }
  }
}
rtpTransport.onreceivedrtpacks = () => {
    for (const rtpAcks in rtpTransport.readReceivedRtpAcks(100)) {
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
    const [rtpSender, originalPacket, paddingBytes, sendTime] = await pacer.dequeue();  // Custom
    // Create an RTCRtpPacketInit instance with the desired padding.
    const packetInit = {
      originalPacket.marker,
      originalPacket.payloadType,
      originalPacket.timestamp,
      originalPacket.csrcs,
      originalPacket.headerExtensions,
      originalPacket.payload,
      paddingBytes
    };
    const rtpSent = rtpSender.sendRtp(packetInit, {sendTime: sendTime});
    (async () => {
        pacer.handleSent(await rtpSent);
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

## Example 3: Custom BWE with Batched processing

```javascript
const [pc, rtpTransport] = setupPeerConnectionWithRtpTransport();  // Custom
const estimator = createBandwidthEstimator();  // Custom

// Every 100ms, notify the estimator of all RTP packets sent.
setInterval(() => {
  // Read all synchronously available rtpSents in batches of 100.
  while(true) {
    let sentRtps = rtpTransport.readSentRtp(100);
    if (sentRtps.length == 0) {
      break;
    }
    sentRtps.forEach((sentRtp) => estimator.rememberRtpSent(sentRtp));
  }
}, 100);

// Every 100ms, notify the estimator of all RTP acks received.
setInterval(() => {
  // Read all synchronously available RtpAcks in batches of 100.
  while(true) {
    let rtpAcks = rtpTransport.readReceivedRtpAcks(100);
    if (rtpAcks.length == 0) {
      break;
    }
    rtpAcks.forEach((ack) => estimator.processReceivedAcks(ack));
  }
  // Update bitrate estimations now that estimator is up to date.
  doBitrateAllocationAndUpdateEncoders(estimator);  // Custom
}, 100);
```

## Alternative designs considered

