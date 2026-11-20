import test from 'node:test';
import assert from 'node:assert/strict';

import { Frame, meanSquaredError, psnr } from '../src/core/image.js';
import { encodeVideo } from '../src/core/encoder.js';
import { decodeVideo } from '../src/core/decode.js';
import { parseHeader } from '../src/core/container.js';
import { generateSequence, attachFrameClass } from '../src/core/scenarios.js';
import { MODE_INTER, MODE_INTRA } from '../src/core/constants.js';

function sequence(id, opts) {
  return attachFrameClass(generateSequence(id, opts), Frame);
}

function assertIdenticalRecon(enc, dec) {
  assert.equal(dec.frames.length, enc.perFrame.length);
  for (let i = 0; i < dec.frames.length; i++) {
    const m = meanSquaredError(enc.perFrame[i].recon, dec.frames[i]);
    assert.equal(m.sse, 0, `frame ${i} reconstruction differs between encoder and decoder`);
  }
}

test('encoder reconstruction and decoder output are bit-identical (pan)', () => {
  const seq = sequence('pan', { width: 64, height: 48, frames: 6 });
  const enc = encodeVideo({ frames: seq.frames, qp: 24, radius: 12, strategy: 'full' });
  const dec = decodeVideo(enc.bytes);
  assertIdenticalRecon(enc, dec);
  assert.ok(psnr(seq.frames[3], dec.frames[3]) > 30, 'decoded frames should be close to source');
});

test('pan vectors recover the known translation', () => {
  const seq = sequence('pan', { width: 64, height: 48, frames: 4 });
  const enc = encodeVideo({ frames: seq.frames, qp: 20, radius: 12, strategy: 'full' });
  // Frame 1 shifts by +2 px, so most inter blocks should carry mvx = -2.
  const frame = enc.perFrame[1];
  const inter = frame.blocks.filter((b) => b.mode === MODE_INTER);
  assert.ok(inter.length > frame.blocks.length / 2, 'most blocks should be inter');
  const correct = inter.filter((b) => b.mvx === -2 && b.mvy === 0).length;
  assert.ok(correct >= inter.length * 0.8, `expected most vectors at (-2,0), got ${correct}/${inter.length}`);
});

test('occlusion sequence falls back to intra where the background is revealed', () => {
  const seq = sequence('occlusion', { width: 64, height: 48, frames: 5 });
  const enc = encodeVideo({ frames: seq.frames, qp: 24, radius: 12, strategy: 'full' });
  const dec = decodeVideo(enc.bytes);
  assertIdenticalRecon(enc, dec);
  // Some blocks must be intra even in inter frames; a pure "always inter"
  // coder would be unable to represent newly revealed pixels.
  const lateFrames = enc.perFrame.slice(1);
  const intra = lateFrames.reduce(
    (n, f) => n + f.blocks.filter((b) => b.mode === MODE_INTRA).length,
    0,
  );
  assert.ok(intra > 0, 'occlusion must produce intra fallback blocks');
});

test('out-of-range motion is clamped to the search border and still decodes', () => {
  const seq = sequence('overshoot', { width: 64, height: 48, frames: 4 });
  const radius = 6;
  const enc = encodeVideo({ frames: seq.frames, qp: 24, radius, strategy: 'full' });
  const dec = decodeVideo(enc.bytes);
  assertIdenticalRecon(enc, dec);

  const frame = enc.perFrame[2];
  const atBorder = frame.blocks.filter(
    (b) => b.mode === MODE_INTER && (Math.abs(b.mvx) === radius || Math.abs(b.mvy) === radius),
  );
  assert.ok(atBorder.length > 0, 'the 14 px/frame object must produce clamped vectors at radius 6');
  // Border-clamped vectors must be genuinely represented in the bitstream.
  const decodedBorder = dec.perFrame[2].blocks.filter(
    (b) => b.mode === MODE_INTER && (Math.abs(b.mvx) === radius || Math.abs(b.mvy) === radius),
  );
  assert.ok(decodedBorder.length > 0, 'decoder must read the same clamped vectors');

  // And no vector may exceed the radius that was declared in the header.
  for (const f of enc.perFrame) {
    for (const b of f.blocks) {
      assert.ok(Math.abs(b.mvx) <= radius && Math.abs(b.mvy) <= radius);
    }
  }
});

test('all three strategies produce decodable streams on all scenarios', () => {
  for (const id of ['pan', 'occlusion', 'overshoot']) {
    const seq = sequence(id, { width: 48, height: 32, frames: 4 });
    for (const strategy of ['full', 'spiral', 'diamond']) {
      const enc = encodeVideo({ frames: seq.frames, qp: 26, radius: 8, strategy });
      const dec = decodeVideo(enc.bytes);
      assertIdenticalRecon(enc, dec);
      assert.equal(dec.frames.length, 4);
    }
  }
});

test('header fields describe the actual stream and CRC protects the payload', () => {
  const seq = sequence('pan', { width: 40, height: 24, frames: 3 });
  const enc = encodeVideo({ frames: seq.frames, qp: 22, radius: 7, strategy: 'spiral', fps: 15 });
  const header = parseHeader(enc.bytes);
  assert.equal(header.width, 40);
  assert.equal(header.height, 24);
  assert.equal(header.components, 1);
  assert.equal(header.frameCount, 3);
  assert.equal(header.fps, 15);
  assert.equal(header.searchRadius, 7);
  assert.equal(header.payloadBits, enc.header.payloadBits);
  assert.equal(header.totalSize, enc.bytes.length);
  assert.equal(header.payloadCrc, enc.header.crc32);
});

test('RGB (3-component) frames round-trip exactly through the decoder', () => {
  const seq = sequence('pan', { width: 48, height: 32, frames: 3, components: 3 });
  const enc = encodeVideo({ frames: seq.frames, qp: 20, radius: 8, strategy: 'diamond' });
  const dec = decodeVideo(enc.bytes);
  assert.equal(dec.header.components, 3);
  assertIdenticalRecon(enc, dec);
});

test('edge geometries (non-multiple of 8, single block, single row) round-trip', () => {
  for (const [w, h] of [[8, 8], [13, 9], [64, 8], [8, 64], [1, 1]]) {
    const seq = sequence('pan', { width: w, height: h, frames: 3 });
    const enc = encodeVideo({ frames: seq.frames, qp: 28, radius: 4, strategy: 'full' });
    const dec = decodeVideo(enc.bytes);
    assert.equal(dec.header.width, w);
    assert.equal(dec.header.height, h);
    assertIdenticalRecon(enc, dec);
  }
});

test('decoder rejects corrupt and truncated streams instead of inventing pixels', () => {
  const seq = sequence('pan', { width: 32, height: 24, frames: 2 });
  const enc = encodeVideo({ frames: seq.frames, qp: 20, radius: 6, strategy: 'full' });

  const badMagic = enc.bytes.slice();
  badMagic[0] ^= 0xff;
  assert.throws(() => decodeVideo(badMagic), /magic|BMPP/);

  const badVersion = enc.bytes.slice();
  badVersion[4] = 9;
  assert.throws(() => decodeVideo(badVersion), /version/);

  const badCrc = enc.bytes.slice();
  badCrc[badCrc.length - 1] ^= 0x01;
  assert.throws(() => decodeVideo(badCrc), /CRC/);

  const truncated = enc.bytes.slice(0, enc.bytes.length - 4);
  assert.throws(() => decodeVideo(truncated), /size/);

  const badSize = enc.bytes.slice();
  new DataView(badSize.buffer).setUint32(28, badSize.length + 7, true);
  assert.throws(() => decodeVideo(badSize), /size/);
});

test('decoder is independent of encoder planning state', async () => {
  // Re-import the decoder in isolation and decode bytes produced earlier; it
  // must not need any encoder object to run.
  const seq = sequence('pan', { width: 32, height: 24, frames: 2 });
  const enc = encodeVideo({ frames: seq.frames, qp: 24, radius: 6, strategy: 'spiral' });
  const { decodeVideo: freshDecode } = await import('../src/core/decode.js');
  const dec = freshDecode(enc.bytes);
  assert.equal(dec.frames.length, 2);
});

test('first frame is always intra and inter needs a reference', () => {
  const seq = sequence('pan', { width: 32, height: 24, frames: 2 });
  const enc = encodeVideo({ frames: seq.frames, qp: 20, radius: 6, strategy: 'full' });
  for (const b of enc.perFrame[0].blocks) assert.equal(b.mode, MODE_INTRA);
  const dec = decodeVideo(enc.bytes);
  for (const b of dec.perFrame[0].blocks) assert.equal(b.mode, MODE_INTRA);
});
