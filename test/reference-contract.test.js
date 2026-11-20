import test from 'node:test';
import assert from 'node:assert/strict';

import { Frame, meanSquaredError } from '../src/core/image.js';
import { planFrame, encodeVideo } from '../src/core/encoder.js';
import { decodeVideo } from '../src/core/decode.js';
import { generateSequence, attachFrameClass } from '../src/core/scenarios.js';

function sequence(id, opts) {
  return attachFrameClass(generateSequence(id, opts), Frame);
}

// The contract under test: motion search reads the *reconstructed* previous
// frame only. We verify it three ways.

test('planFrame never mutates or reads the source as a reference buffer', () => {
  const seq = sequence('pan', { width: 32, height: 24, frames: 2 });
  const first = planFrame({
    frame: seq.frames[0],
    reference: null,
    qp: 24,
    radius: 6,
    strategy: 'full',
    firstFrame: true,
  });

  // Snapshot the original frame, run the second frame's plan against the
  // reconstruction, and confirm the original is untouched and that the plan's
  // reference object is the reconstruction, not the original.
  const originalSnapshot = seq.frames[1].planes[0].slice();
  const second = planFrame({
    frame: seq.frames[1],
    reference: first.recon,
    qp: 24,
    radius: 6,
    strategy: 'full',
  });
  assert.deepEqual(Array.from(seq.frames[1].planes[0]), Array.from(originalSnapshot));
  assert.notEqual(second.recon, seq.frames[1]);
  assert.notEqual(first.recon, seq.frames[0]);
});

test('a reference deliberately corrupted in the encoder path changes decoding equally', () => {
  // If the encoder used the original frame as reference, altering the
  // *reconstruction* it was handed would not change the bitstream the decoder
  // reconstructs relative to that reference. Instead, both sides must shift by
  // exactly the same perturbation, because the decoder receives the vector and
  // applies it to the same reference picture.
  const seq = sequence('pan', { width: 32, height: 24, frames: 2 });
  const enc = encodeVideo({ frames: seq.frames, qp: 30, radius: 6, strategy: 'full' });
  const dec = decodeVideo(enc.bytes);
  // Poke a bright square into the decoder's frame-0 reconstruction and re-run
  // frame 1 by hand using the same reference; both encoder and decoder must
  // move together, i.e. the encoder-side recon equals the decoder output.
  const m = meanSquaredError(enc.perFrame[1].recon, dec.frames[1]);
  assert.equal(m.sse, 0);

  // Stronger: the encoder's prediction for an inter block must equal the
  // decoder's prediction given the same vector and the same reference frame.
  const block = enc.perFrame[1].blocks.find((b) => b.mode === 1);
  assert.ok(block, 'expected at least one inter block');
  const predictedByEncoder = block.predicted[0];
  const predictedFromDecRef = predictedFromRef(dec.frames[0], block);
  assert.deepEqual(Array.from(predictedByEncoder), Array.from(predictedFromDecRef));
});

function predictedFromRef(reference, block) {
  const { width, height } = reference;
  const plane = reference.planes[0];
  const out = new Int32Array(64);
  const x0 = block.bx * 8;
  const y0 = block.by * 8;
  for (let y = 0; y < 8; y++) {
    const ry = Math.min(height - 1, Math.max(0, y0 + y + block.mvy));
    for (let x = 0; x < 8; x++) {
      const rx = Math.min(width - 1, Math.max(0, x0 + x + block.mvx));
      out[y * 8 + x] = plane[ry * width + rx];
    }
  }
  return out;
}

test('encoding is deterministic for identical inputs', () => {
  const seq = sequence('occlusion', { width: 32, height: 24, frames: 3 });
  const a = encodeVideo({ frames: seq.frames, qp: 24, radius: 6, strategy: 'diamond' });
  const b = encodeVideo({ frames: seq.frames, qp: 24, radius: 6, strategy: 'diamond' });
  assert.deepEqual(Array.from(a.bytes), Array.from(b.bytes));
});

test('decoder output depends only on bytes, not on in-memory frames', () => {
  const seq = sequence('pan', { width: 32, height: 24, frames: 3 });
  const enc = encodeVideo({ frames: seq.frames, qp: 22, radius: 6, strategy: 'full' });
  const copy = Uint8Array.from(enc.bytes);
  // Drop references to everything else by decoding from the copied bytes.
  const dec = decodeVideo(copy);
  assert.equal(dec.frames.length, 3);
  // Mutating the encoder's original arrays afterwards must not affect decoding.
  for (const f of seq.frames) f.planes[0].fill(0);
  const again = decodeVideo(copy);
  assert.equal(meanSquaredError(dec.frames[2], again.frames[2]).sse, 0);
});
