# Custom Congestion Control Use Case

## Motivation

Motivation
- Allow applications to experiment with what works for their specific use case independent of the standards to improve the speed of innovation and iteration.
- Improve connectivity for users by allowing the application to use its knowledge of the exact usage scenario to better evaluate trade-offs and manage the network connection actively.

## Goals

Congestion control can be done by the application, by doing custom bandwidth estimation and custom pacing and probing.

## API requirements

Applications can do custom bandwidth estimation via:
- Access to information about when packets are sent, both application supplied and UA packetized, and how large they are.
- Access to information about when congestion control feedback (ack messages) are received, and per-packet information about when they were received.
- Access to information used by L4S.
- Knowledge of when an application packet is not sent, and why.
- Efficient control of when packets are sent and injection of additonal padding packets, in order to do custom pacing and probing.

Applications need to be be able to batch processing to run much less often than per-packet, to reduce overheads in high bandwidth situations, where packets are sent and received thousands of times per second.

## Examples

## Example 1: Custom BWE

```javascript
// TODO
```

## Example 2: Custom Pacing and Probing

```javascript
// TODO
```


