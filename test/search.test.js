import test from 'node:test';
import assert from 'node:assert/strict';

import { Frame, blockSAD } from '../src/core/image.js';
import { searchBlock, exhaustiveOptions } from '../src/core/search.js';
import { mvBits } from '../src/core/mvcode.js';

function rampPair(bx, by, shift) {
  const W = 48;
  const H = 48;
  const src = new Frame(W, H, 1);
  const ref = new Frame(W, H, 1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) ref.planes[0][y * W + x] = Math.min(255, 16 + x);
  }
  for (let i = 0; i < W * H; i++) src.planes[0][i] = ref.planes[0][i];
  // Copy the shifted block, then perturb four pixels so SAD(shift,0) is
  // small but non-zero (8), while nearer vectors are worse.
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      src.planes[0][(by * 8 + y) * W + bx * 8 + x] =
        ref.planes[0][(by * 8 + y) * W + bx * 8 + x + shift];
    }
  }
  for (let k = 0; k < 4; k++) {
    src.planes[0][(by * 8 + k) * W + bx * 8 + k] = Math.min(
      255,
      ref.planes[0][(by * 8 + k) * W + bx * 8 + k + shift] + 2,
    );
  }
  return { src, ref, bx, by, W, H };
}

test('zero lambda reproduces the pure-SAD optimum', () => {
  const { src, ref, bx, by } = rampPair(2, 2, 4);
  const options = exhaustiveOptions({ source: src, reference: ref, bx, by, radius: 8 });
  const minSad = Math.min(...options.map((o) => o.sad));
  const result = searchBlock({
    source: src,
    reference: ref,
    bx,
    by,
    radius: 8,
    lambda: 0,
    strategy: 'full',
  });
  assert.equal(result.best.sad, minSad);
});

test('motion vector coding cost changes the selected displacement', () => {
  const { src, ref, bx, by } = rampPair(2, 2, 4);
  // At lambda 0 the estimator prefers the SAD-optimal +4 vector (SAD 8,
  // 8 bits). Charging bits pushes it to a cheaper, slightly worse vector.
  const plain = searchBlock({
    source: src,
    reference: ref,
    bx,
    by,
    radius: 8,
    lambda: 0,
    strategy: 'full',
  });
  const priced = searchBlock({
    source: src,
    reference: ref,
    bx,
    by,
    radius: 8,
    lambda: 40,
    strategy: 'full',
  });

  assert.equal(plain.best.mvx, 4, 'SAD-only should pick the exact match');
  assert.notEqual(priced.best.mvx, 4, 'bit cost should move the choice away');
  assert.ok(priced.best.sad > plain.best.sad, 'the priced choice trades SAD for bits');
  assert.ok(
    priced.best.bits < plain.best.bits,
    'and the trade really reduces transmitted vector size',
  );

  // The RD objective must be what was minimised: no evaluated candidate may
  // have a lower J than the winner.
  const evaluated = searchBlock({
    source: src,
    reference: ref,
    bx,
    by,
    radius: 8,
    lambda: 40,
    strategy: 'full',
    recordCandidates: true,
  });
  for (const c of evaluated.candidates) {
    assert.ok(
      evaluated.best.cost <= c.cost,
      `candidate (${c.mvx},${c.mvy}) has lower cost than the winner`,
    );
  }
});

test('candidate cost uses the exact transmitted size of the vector', () => {
  const { src, ref, bx, by } = rampPair(2, 2, 4);
  const result = searchBlock({
    source: src,
    reference: ref,
    bx,
    by,
    radius: 8,
    lambda: 7,
    strategy: 'full',
    recordCandidates: true,
  });
  for (const c of result.candidates) {
    assert.equal(c.bits, mvBits(c.mvx, c.mvy));
    assert.equal(c.cost, c.sad + 7 * c.bits);
  }
});

test('full search evaluates the whole window; fast strategies evaluate less', () => {
  const { src, ref, bx, by } = rampPair(2, 2, 4);
  const radius = 10;
  const full = searchBlock({ source: src, reference: ref, bx, by, radius, lambda: 3, strategy: 'full' });
  const spiral = searchBlock({ source: src, reference: ref, bx, by, radius, lambda: 3, strategy: 'spiral' });
  const diamond = searchBlock({ source: src, reference: ref, bx, by, radius, lambda: 3, strategy: 'diamond' });

  assert.equal(full.evaluated, (2 * radius + 1) ** 2);
  assert.ok(spiral.evaluated <= full.evaluated);
  assert.ok(diamond.evaluated < full.evaluated, 'diamond must sample far fewer points');

  let fullSsad = 0;
  for (const c of full.candidates || []) fullSsad += c.sad;
  assert.equal(full.candidates, null, 'candidates are not recorded unless requested');
  assert.equal(fullSsad, 0);
});

test('every strategy finds the true minimum-SAD displacement', () => {
  const { src, ref, bx, by } = rampPair(2, 2, 4);
  const options = exhaustiveOptions({ source: src, reference: ref, bx, by, radius: 8 });
  const minSad = Math.min(...options.map((o) => o.sad));
  assert.equal(minSad, 8, 'fixture minimum is the perturbed exact match');
  for (const strategy of ['full', 'spiral', 'diamond']) {
    const result = searchBlock({
      source: src,
      reference: ref,
      bx,
      by,
      radius: 8,
      lambda: 0,
      strategy,
    });
    assert.equal(result.best.sad, minSad, `${strategy} should find the minimum-SAD match`);
    assert.equal(blockSAD(src, ref, bx, by, result.best.mvx, result.best.mvy), minSad);
  }
});

test('search radius is honoured, including a zero-radius window', () => {
  const { src, ref, bx, by } = rampPair(2, 2, 4);
  const zero = searchBlock({ source: src, reference: ref, bx, by, radius: 0, lambda: 0, strategy: 'full' });
  assert.equal(zero.evaluated, 1);
  assert.equal(zero.best.mvx, 0);
  assert.equal(zero.best.mvy, 0);

  const r3 = searchBlock({ source: src, reference: ref, bx, by, radius: 3, lambda: 0, strategy: 'full' });
  for (const c of r3.candidates || []) {
    assert.ok(Math.abs(c.mvx) <= 3 && Math.abs(c.mvy) <= 3);
  }
});
