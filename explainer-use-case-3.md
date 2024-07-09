# Custom RTX Use Case

## Motivation

Advanced web applications wish to control NACK and RTX behavior, such as being able to control how large the RTX packet cache is, or how long packets stay in the cache.

## Examples

### Example: Custom RTX packet cache

```javascript
const [pc, rtpTransport, rtpSender] = setupPeerConnectionWithRtpTransport();  // Custom
const rtxPacketCache = createRtxPacketCache();  // Custom
const rtpSendStream = await rtpSender.replaceSendStreams()[0];
rtpSendStream.onpacketizedrtp = () => {
  const rtpPackets = rtpSendStream.readPacketizedRtp();
  for (const rtpPacket of rtpPackets) {
    rtxPacketCache.cacheRtpPacket(rtpPacket);
    rtpSendStream.sendRtp(rtpPacket);
  }
};
// TODO: How do we disable normal NACK processing?  
rtpSendStream.onreceivedrtcpnacks = () => {
    const nacks = rtpSendStream.readReceivedRtcpNacks();
    for (const nack of nacks) {
        for (const seqnum of nack.sequenceNumbers) {
            const cachedRtpPacket = rtxPacketCache.getCachedRtpPacketBySequenceNumber(seqnum);
            if (cachedRtpPacket) {
                rtpSendStream.sendRtp(cachedRtpPacket, {asRtx: true});
            }
        }
    }
}
```

### Example: Custom NACK

```javascript
const [pc, rtpTransport, rtpReceiver] = setupPeerConnectionWithRtpTransport();  // Custom
const nackCalculator = createNackCalculator();  // Custom
const rtpReceiveStream = await rtpReceiver.replaceReceiveStreams()[0];
// TODO: How do we disable normal NACK sending?
rtpReceiveStream.onrtpreceived = () => {
  const rtpPacket = rtpReceiveStream.readReceivedRtp();
  const nackedSequenceNumbers = nackCalaculator.calculateNackedSequenceNumbers(rtpPacket);
  if (nackedSequenceNumbers) {
    rtpRecieveStream.sendNack(nackedSequenceNumbers);
  }
}
```

### Example: Custom RTX payload

TODO