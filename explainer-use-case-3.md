# Custom RTX Use Case

## Motivation

Advanced web applications wish to control NACK and RTX behavior, such as being able to control how large the RTX packet cache is, or how long packets stay in the cache.

## Examples

### Example 1a: Custom RTX packet cache (per-stream and parsed)

```javascript
const [pc, rtpTransport, rtpSender] = setupPeerConnectionWithRtpTransport();  // Custom
const rtxPacketCache = createRtxPacketCache();  // Custom
const rtpSendStream = await rtpSender.replaceSendStreams()[0];
rtpSendStream.onpacketizedrtp = () => {
  const rtpPackets = rtpSendStream.readPacketizedRtp();
  for (const rtpPacket of rtpPackets) {
    rtxPacketCache.cacheRtpPacket(rtpPacket);
    // CON: Need sendRtp
    rtpSendStream.sendRtp(rtpPacket);
  }
};
// TODO: How do we disable normal NACK processing?  
rtpSendStream.onreceivedrtcpnacks = () => {
    // NEW: readReceivedRtcpNacks and Nack.sequenceNumbers
    const nacks = rtpSendStream.readReceivedRtcpNacks();
    for (const nack of nacks) {
        for (const seqnum of nack.sequenceNumbers) {
            const cachedRtpPacket = rtxPacketCache.getCachedRtpPacketBySequenceNumber(seqnum);
            if (cachedRtpPacket) {
                // NEW: asRtx
                rtpSendStream.sendRtp(cachedRtpPacket, {asRtx: true});
            }
        }
    }
}
```

### Example 1b: Custom RTX packet cache (cross-RtpTransport and parsed)

```javascript
const [pc, rtpTransport] = setupPeerConnectionWithRtpTransport();  // Custom
const rtxPacketCache = createRtxPacketCache();  // Custom
rtpTransport.onrtpsent = () => {
  // NEW: RtpTransport.readSentRtp (make RtpTransport.onrtpsent batch-style)
  const sentRtps = rtpTransport.readSentRtp();
  for (const sentRtp of sentRtps) {
    // NEW: SentRtp.packet (make the existing object include the whole RtpPacket, not just timestamps)
    rtxPacketCache.cacheRtpPacket(sentRtp.packet);
    // PRO: No sendRtp required
  }
};
// TODO: How do we disable normal NACK processing?  
// NEW: RtpTransport.onreceivedrtcp (a whole new thing)
rtpTransport.onreceivedrtcp = () => {
    // NEW: RtpTransport.readReceivedRtcp (batched part of RtpTransport.onrecievedrtcp)
    // NEW: RtcpPacket.nacks and Nack.sequenceNumbers and Nack.ssrc
    const rtcp = rtpTransport.readReceivedRtcp();
    for (const nack of rtcp.nacks) {
        for (const seqnum of nack.sequenceNumbers) {
            const cachedRtpPacket = rtxPacketCache.getCachedRtpPacket(nack.ssrc, seqnum);
            if (cachedRtpPacket) {
                // NEW: asRtx
                rtpSendStream.sendRtp(cachedRtpPacket, {asRtx: true});
            }
        }
    }
}
```

### Example 1c: Custom RTX packet cache (cross-RtpTransport and unparsed)

```javascript
const [pc, rtpTransport] = setupPeerConnectionWithRtpTransport();  // Custom
const rtxPacketCache = createRtxPacketCache();  // Custom
  // NEW: RtpTransport.readSentRtp (make RtpTransport.onrtpsent batch-style)
  const sentRtps = rtpTransport.readSentRtp();
  for (const sentRtp of sentRtps) {
    // NEW: SentRtp.packet (make the existing object include the whole RtpPacket, not just timestamps)
    rtxPacketCache.cacheRtpPacket(sentRtp.packet);
    // PRO: No sendRtp required
  }
};
// TODO: How do we disable normal NACK processing?  
// NEW: RtpTransport.onreceivedrtcp (a whole new thing)
rtpTransport.onreceivedrtcp = () => {
    // NEW: RtpTransport.readReceivedRtcp (batched part of RtpTransport.onrecievedrtcp)
    const rtcp = rtpTransport.readReceivedRtcp();
    // PRO: No need for browser to parse NACKs
    // CON: Need to parse NACKs yourself
    const nacks = parseNacks(rtcp);
    for (const nack of nacks) {
        for (const seqnum of nack.sequenceNumbers) {
            const cachedRtpPacket = rtxPacketCache.getCachedRtpPacket(nack.ssrc, seqnum);
            if (cachedRtpPacket) {
                // NEW: asRtx
                rtpSendStream.sendRtp(cachedRtpPacket, {asRtx: true});
            }
        }
    }
}
```

### Example 2a: Custom NACK (per-stream and "parsed")

```javascript
const [pc, rtpTransport, rtpReceiver] = setupPeerConnectionWithRtpTransport();  // Custom
const nackCalculator = createNackCalculator();  // Custom
const rtpReceiveStream = await rtpReceiver.replaceReceiveStreams()[0];
// TODO: How do we disable normal NACK sending?
rtpReceiveStream.onrtpreceived = () => {
  const rtpPackets = rtpReceiveStream.readReceivedRtp();
  const nackedSequenceNumbers = nackCalaculator.calculateNackedSequenceNumbers(rtpPackets);
  if (nackedSequenceNumbers) {
    rtpRecieveStream.sendNack(nackedSequenceNumbers);
  }
}
```

### Example 2b: Custom NACK (per-transport and "parsed")

```javascript
const [pc, rtpTransport] = setupPeerConnectionWithRtpTransport();  // Custom
const nackCalculator = createNackCalculator();  // Custom
// TODO: How do we disable normal NACK sending?
// NEW: RtpTransport.onrtpreceived (transport-wide version of RtpReceiveStream.onrtpreceived)
// CON: Duplicate onrtpreceived (transport-wide and per-stream)
rtpTransport.onrtpreceived = () => {
  // NEW: RtpTransport.readReceivedRtp (transport-wide version of RtpReceiveStream.readReceivedRtp)
  const rtpPackets = rtpTransport.readReceivedRtp();
  const nacks = nackCalaculator.calculateNacks(rtpPackets);
  for (const nack of nacks) {
    // NEW: RtpTransport.sendNack (or maybe sendRtcp)
    rtpTransport.sendNack(nack.ssrc, nack.sequenceNumbers);
  }
}
```

### Example 2c: Custom NACK (per-transport and "unparsed")

```javascript
const [pc, rtpTransport] = setupPeerConnectionWithRtpTransport();  // Custom
const nackCalculator = createNackCalculator();  // Custom
// TODO: How do we disable normal NACK sending?
// NEW: RtpTransport.onrtpreceived (transport-wide version of RtpReceiveStream.onrtpreceived)
// CON: Duplicate onrtpreceived (transport-wide and per-stream)
rtpTransport.onrtpreceived = () => {
  // NEW: RtpTransport.readReceivedRtp (transport-wide version of RtpReceiveStream.readReceivedRtp)
  const rtpPackets = rtpTransport.readReceivedRtp();
  const nacks = nackCalaculator.calculateNacks(rtpPackets);
  for (const nack of nacks) {
    // PRO: Browser doesn't have to construct NACK
    // CON: User does have to construct NACK
    const rtcp = constructNackPacket(nack.ssrc, nack.sequenceNumbers);
    rtpTransport.sendRtcp(rtcp);
  }
}
```


### Example: Custom RTX payload

TODO