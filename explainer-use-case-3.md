# Cross stream and transport wide RTP/RTCP.

## Detailed description

Some RTP packets and RTCP messages does not relate to any particular stream, but may relate to multiple stream or the transport in general. Examples of this is Flex-FEC which provides resilience for multiple streams, or Transport wide Congestion Controll (TWCC) which relates to the BWE/CC of the transport itself.

## Motivation

Motivation
- Allow applications to experiment with what works for their specific use case independent of the standards to improve the speed of innovation and iteration.

## Goals

To allow the application to send and receive RTP packets and RTCP messages that relate to either more than one stream, or to the transport itself.

## API requirements

Applications can do cross stream and transport wide RTP/RTCP by:
- Sending custom RTP/RTCP on the transport.
- Receiving RTP/RTCP from the transport.

## Examples

## Example 1: Cross stream RTP packets.

```javascript
// ---- Sender ----
const [pc, rtpTransport] = setupPeerConnectionWithRtpTransport();
const multiStreampacketGenerator = videoEncoderAndPacketizer({videoSsrc: 1111, screeshareSsrc: 2222});
const fecPacketGenerator = flexFecGenerator({ssrc:3333});
while (true) {
  const packet = await multiStreampacketGenerator.nextPacket();
  rtpTransport.sendRtp(packet);
  const fecPackets = fecPacketGenerator.sentPacket(packet);
  for (const fecPacket in fecPackets) {
    rtpTransport.sendRtp(fecPackets, {sendTime: sendTime});
  }
}


// ---- Receiver ----
const [pc, rtpTransport] = setupPeerConnectionWithRtpTransport();
const rtpStreamDecoder1 = videoDepacketizerAndDecoder();
const rtpStreamDecoder2 = videoDepacketizerAndDecoder();
const fecPacketRestorer = fecPacketRestorer();

function receivePacket(packet) {
  if (packet.ssrc == 1111) {
    rtpStreamDecoder1.receivedRtp(packet);
  } else if (packet.ssrc == 2222) {
    rtpStreamDecoder2.receivedRtp(packet);
  }
}

rtpTransport.onrtpreceived = (packet) => {
  if (packet.ssrc == 3333) {
    const restoredPackets = fecPacketRestorer.onPacket(packet);
    for (const restoredPacket in restoredPackets) {
      receivePacket(restoredPacket);
    }
  } else {
    receivePacket(packet);
  }
}
```

## Example 2: Transport wide RTCP

```javascript
// ---- Sender ----
const [pc, rtpTransport] = setupPeerConnectionWithRtpTransport();
const packetGenerator = videoEncoderAndPacketizer();
const feedbackConsumer = myCustomFeedbackConsumer(rtpTransport);

rtpTransport.onrtcpreceived = (rtcp) => {
  if (isMyCustomFeedbackMessage(rtcp)) {
    feedbackConsumer.onRtcp(rtcp);
  }
}

while (true) {
  const packet = await packetGenerator.nextPacket();
  rtpTransport.sendRtp(packet);
}


// ---- Receiver ----
const [pc, rtpTransport] = setupPeerConnectionWithRtpTransport();
const customFeedbackGenerator = myCustomFeedbackGenerator();

rtpTransport.onrtpreceived = (packet) => {
  const rtcpFeedback = customFeedbackGenerator.onPacket(packet);
  if (rtcpFeedback) {
    rtpTransport.sendRtcp(rtcpFeedback);
  }
}
```
