// SRTP Bypass Marker
// SRTP encryption/decryption is handled by the RtcTransport browser API
// when using wireProtocol: "dtls-srtp". The JavaScript code sends and
// receives plain RTP/RTCP packets which are encrypted/decrypted at the
// transport layer automatically.
//
// This file documents the security model:
// - RtcTransport performs DTLS-SRTP key exchange
// - All RTP/RTCP packets are encrypted with SRTP before being sent on the wire
// - Received packets are decrypted before being delivered to JavaScript
// - The JS application never handles encryption keys or raw encrypted packets

export const SRTP_MODE = 'transport-handled' as const;

/**
 * Indicates whether SRTP is handled by the transport layer.
 * Always true when using RtcTransport with wireProtocol: "dtls-srtp".
 */
export function isSrtpHandledByTransport(): boolean {
  return true;
}
