# Custom Packetization Use Case

## Extended use cases

Custom packetization/depacketization enables the following WebRTC Extended Use Cases: 

- [Section 2.3](https://www.w3.org/TR/webrtc-nv-use-cases/#videoconferencing*): Video Conferencing with a Central Server
- [Section 3.2.1](https://www.w3.org/TR/webrtc-nv-use-cases/#game-streaming): Game streaming
- [Section 3.2.2](https://www.w3.org/TR/webrtc-nv-use-cases/#auction): Low latency Broadcast with Fanout
- [Section 3.5](https://www.w3.org/TR/webrtc-nv-use-cases/#vr*): Virtual Reality Gaming

## Detailed description

In this use case, packetization of encoded video or audio frames is handled by the application, as is depacketization. The encoded video or audio frames to be packetized can be constructed using WebCodecs or WASM.  The codecs to be packetized/depacketized can be supported with supported natively within WebCodecs, or they could be codecs implemented in WASM but not supported natively by WebCodecs. 

Custom packetization/depacketization enables applications to do things such as:
- Encode with a custom (WASM) codec, packetize and send
- Observe incoming packets
- Receive packets using a custom jitter buffer implementation
- Use WebCodecs for encode or decode, implement packetization/depacketization, a custom jitter buffer, and custom FEC
- Obtain a bandwidth estimate from RTCTransport, do bitrate allocation, and choose encoder bitrates.

## API requirements

Enable applications to do custom packetization/depacketization by enabling them to:

- Send packets
- Receive packets
- Know what bitrates the browser has estimated

Complexities of sending and receiving packets other than these requirements are still handled by the User Agent, such
as encryption and congestion control

## Examples

### Example 1: Send packets

```javascript
// TODO
```

### Example 2: Receive packets

```javascript
// TODO
```

### Example 3: Send and packetize with custom codec (WASM)

```javascript
// TODO
```

### Example 4: Receive with custom codec (WASM) and jitter buffer

```javascript
// TODO
```

### Example 5: Send and packetize with WebCodecs

```javascript
// TODO
```

### Example 6: Receive with custom codec (WASM) and jitter buffer

```javascript
// TODO
```

### Example 7: Send custom FEC

```javascript
// TODO
```


### Example 8: Receive custom FEC

```javascript
// TODO
```

### Example 9: Custom bitrate allocation
```javascript
// TODO
```

