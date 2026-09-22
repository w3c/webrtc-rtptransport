// Error-recovery tests: NACK, PLI/FIR, and XOR FEC.
//
// Exercises the recovery modules the same way the proxy shim wires them:
//  - NACK receive-side gap detection → generate/parse, send-side retransmit.
//  - PLI/FIR generation, on-wire detection, and keyframe callbacks.
//  - XOR FEC recovery of a single lost packet, including the shim's
//    "protect the whole serialized RTP packet" integration, and the
//    unrecoverable (2-lost) case.
//
// Run with: npm test  (esbuild-bundles this file to dist/test.js, then node).

import assert from 'node:assert/strict';

import { NackHandler, parseNackPacket } from '../src/recovery/nack-handler';
import { KeyframeRequestHandler, isPliOrFir } from '../src/recovery/keyframe-request';
import { FecEncoder, FecDecoder } from '../src/recovery/fec';
import { RtpSendStream } from '../src/rtp/rtp-session';
import { parseRtpPacket } from '../src/rtp/rtp-packet';

// ─── Tiny test runner ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \u2717 ${name}`);
    console.error('    ' + (err as Error).stack?.split('\n').slice(0, 4).join('\n    '));
    failed++;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function seqOf(pkt: Uint8Array): number {
  return (pkt[2] << 8) | pkt[3];
}

// ─── NACK ─────────────────────────────────────────────────────────────────────

console.log('NACK (RFC 4585)');

test('receive side detects a gap and generates a NACK for the missing seqs', () => {
  const rx = new NackHandler({ senderSsrc: 0x1111, mediaSsrc: 0x2222 });

  assert.equal(rx.onPacketReceived(100), false, 'first packet: no gap yet');
  assert.equal(rx.onPacketReceived(101), false, 'in-order: no gap');
  // Jump from 101 to 105 → 102,103,104 are missing.
  assert.equal(rx.onPacketReceived(105), true, 'forward jump should flag a gap');

  const nack = rx.generateNack();
  assert.ok(nack, 'a NACK packet should be produced');
  const seqs = parseNackPacket(nack!);
  assert.ok(seqs, 'NACK should parse');
  for (const missing of [102, 103, 104]) {
    assert.ok(seqs!.includes(missing), `NACK should list missing seq ${missing}`);
  }
  assert.ok(!seqs!.includes(101), 'received seqs must not be NACKed');
});

test('receiving the missing packet clears it from the NACK list (recovery)', () => {
  const rx = new NackHandler({ senderSsrc: 1, mediaSsrc: 2 });
  rx.onPacketReceived(10);
  rx.onPacketReceived(13); // 11,12 missing
  assert.equal(rx.getPendingNackCount(), 2);
  rx.onPacketReceived(11); // arrives late
  assert.equal(rx.getPendingNackCount(), 1);
  assert.equal(rx.stats.packetsRecovered, 1);
});

test('send side buffers packets and answers an incoming NACK with retransmits', () => {
  const tx = new NackHandler({ senderSsrc: 0x2222, mediaSsrc: 0x1111 });
  const pktA = new Uint8Array([0xaa, 0, 0, 0, 1]);
  const pktB = new Uint8Array([0xbb, 0, 0, 0, 2]);
  tx.bufferSentPacket(200, pktA);
  tx.bufferSentPacket(201, pktB);

  // Build a NACK asking for 200 and 201.
  const rx = new NackHandler({ senderSsrc: 0x1111, mediaSsrc: 0x2222 });
  rx.onPacketReceived(199);
  rx.onPacketReceived(202); // 200,201 missing
  const nack = rx.generateNack()!;

  const retransmits = tx.handleIncomingNack(nack);
  assert.equal(retransmits.length, 2, 'both buffered packets should be resent');
  assert.ok(retransmits.some((p) => bytesEqual(p, pktA)));
  assert.ok(retransmits.some((p) => bytesEqual(p, pktB)));
  assert.equal(tx.stats.retransmissionsSent, 2);
});

// ─── PLI / FIR ────────────────────────────────────────────────────────────────

console.log('PLI / FIR (RFC 4585 / RFC 5104)');

test('PLI is well-formed and recognised on the wire', () => {
  const h = new KeyframeRequestHandler({ senderSsrc: 5, mediaSsrc: 6 });
  const pli = h.generatePli();
  assert.ok(pli, 'PLI should be generated');
  assert.equal(pli!.length, 12);
  assert.equal(pli![1], 206, 'PT must be PSFB');
  assert.equal(pli![0] & 0x1f, 1, 'FMT must be 1 (PLI)');
  assert.ok(isPliOrFir(pli!));
});

test('FIR is well-formed, carries an FCI entry, and increments its seq', () => {
  const h = new KeyframeRequestHandler({ senderSsrc: 5, mediaSsrc: 6, minIntervalMs: 0 });
  const fir1 = h.generateFir();
  assert.ok(fir1, 'FIR should be generated');
  assert.equal(fir1!.length, 20);
  assert.equal(fir1![1], 206, 'PT must be PSFB');
  assert.equal(fir1![0] & 0x1f, 4, 'FMT must be 4 (FIR)');
  assert.ok(isPliOrFir(fir1!));
  const firSeq1 = fir1![16];
  const fir2 = h.generateFir()!;
  assert.equal(fir2![16], (firSeq1 + 1) & 0xff, 'FIR seq must increment');
});

test('incoming PLI/FIR fire the keyframe-request callback', () => {
  let count = 0;
  const sender = new KeyframeRequestHandler({
    senderSsrc: 6, mediaSsrc: 5, onKeyframeRequested: () => { count++; },
  });
  const receiver = new KeyframeRequestHandler({ senderSsrc: 5, mediaSsrc: 6, minIntervalMs: 0 });

  assert.equal(sender.handleIncoming(receiver.generatePli()!), true);
  assert.equal(sender.handleIncoming(receiver.generateFir()!), true);
  assert.equal(count, 2, 'both PLI and FIR should request a keyframe');
  assert.equal(sender.stats.pliReceived, 1);
  assert.equal(sender.stats.firReceived, 1);
});

test('keyframe requests are throttled by minIntervalMs', () => {
  const h = new KeyframeRequestHandler({ senderSsrc: 5, mediaSsrc: 6, minIntervalMs: 10_000 });
  assert.ok(h.generatePli(), 'first request allowed');
  assert.equal(h.generatePli(), null, 'second request throttled');
});

// ─── FEC ──────────────────────────────────────────────────────────────────────

console.log('XOR FEC (RFC 5109)');

test('recovers a single lost payload from a full FEC group', () => {
  const enc = new FecEncoder({ groupSize: 5 });
  const payloads = [
    new Uint8Array([1, 2, 3, 4]),
    new Uint8Array([5, 6, 7]),
    new Uint8Array([8, 9, 10, 11, 12]),
    new Uint8Array([13, 14]),
    new Uint8Array([15, 16, 17, 18]),
  ];
  let fec = null;
  for (let i = 0; i < payloads.length; i++) {
    fec = enc.addPacket(10 + i, payloads[i], 1000 + i);
  }
  assert.ok(fec, 'a FEC packet should close the group');

  const dec = new FecDecoder();
  // Deliver all but index 2 (seq 12).
  for (let i = 0; i < payloads.length; i++) {
    if (i === 2) continue;
    dec.addMediaPacket(10 + i, payloads[i], 1000 + i);
  }
  const recovered = dec.addFecPacket(fec!.data);
  assert.equal(recovered.length, 1, 'exactly one packet recovered');
  assert.equal(recovered[0].seq, 12);
  assert.ok(bytesEqual(recovered[0].payload, payloads[2]), 'recovered bytes must match original');
  assert.equal(dec.stats.packetsRecoveredByFec, 1);
});

test('cannot recover when two packets in a group are lost', () => {
  const enc = new FecEncoder({ groupSize: 5 });
  const payloads = Array.from({ length: 5 }, (_, i) => new Uint8Array([i, i + 1, i + 2]));
  let fec = null;
  for (let i = 0; i < payloads.length; i++) fec = enc.addPacket(20 + i, payloads[i], i);

  const dec = new FecDecoder();
  // Drop indexes 1 and 3.
  for (let i = 0; i < payloads.length; i++) {
    if (i === 1 || i === 3) continue;
    dec.addMediaPacket(20 + i, payloads[i], i);
  }
  const recovered = dec.addFecPacket(fec!.data);
  assert.equal(recovered.length, 0, 'double loss is unrecoverable with one FEC packet');
  assert.equal(dec.stats.packetsRecoveredByFec, 0);
});

test('shim integration: protect whole RTP packets and recover a dropped one', () => {
  // Mirrors the shim: FEC protects entire serialized RTP packets, so a
  // recovered payload parses straight back into an RTP packet.
  const stream = new RtpSendStream({ ssrc: 0xabcdef, payloadType: 96, clockRate: 90000 });
  const enc = new FecEncoder({ groupSize: 5 });
  const dec = new FecDecoder();

  const sent: Uint8Array[] = [];
  let fec = null;
  for (let i = 0; i < 5; i++) {
    const media = new Uint8Array([0xde, 0xad, 0xbe, 0xef, i]);
    const pkt = stream.createPacket(media, 3000, i === 4);
    sent.push(pkt);
    fec = enc.addPacket(seqOf(pkt), pkt, 0);
  }
  assert.ok(fec, 'FEC repair packet produced');

  const dropIndex = 2;
  for (let i = 0; i < sent.length; i++) {
    if (i === dropIndex) continue;
    dec.addMediaPacket(seqOf(sent[i]), sent[i], 0);
  }

  const recovered = dec.addFecPacket(fec!.data);
  assert.equal(recovered.length, 1, 'the dropped RTP packet is recovered');

  const original = sent[dropIndex];
  assert.ok(bytesEqual(recovered[0].payload, original), 'recovered RTP bytes match original');

  // The recovered bytes parse back into the same RTP packet.
  const reparsed = parseRtpPacket(recovered[0].payload);
  const expected = parseRtpPacket(original);
  assert.equal(reparsed.header.sequenceNumber, expected.header.sequenceNumber);
  assert.equal(reparsed.header.ssrc, expected.header.ssrc);
  assert.equal(reparsed.header.payloadType, expected.header.payloadType);
  assert.ok(bytesEqual(reparsed.payload, expected.payload), 'payload survives recovery');
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
