// Error Recovery Module
// Implements NACK (RFC 4585), PLI/FIR (RFC 4585/5104), and XOR FEC (RFC 5109)

export { NackHandler, parseNackPacket, type NackStats } from './nack-handler';
export {
  KeyframeRequestHandler,
  isPliOrFir,
  type KeyframeRequestStats,
  type KeyframeRequestHandlerOptions,
} from './keyframe-request';
export {
  FecEncoder,
  FecDecoder,
  type FecPacket,
  type FecEncoderOptions,
  type FecStats,
} from './fec';
