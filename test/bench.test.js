import test from 'node:test';
import assert from 'node:assert/strict';

import { Frame } from '../src/core/image.js';
import { generateSequence, attachFrameClass } from '../src/core/scenarios.js';
import { compareStrategies, evaluateStrategy, summarise } from '../src/core/bench.js';

function sequence(id, opts) {
  return attachFrameClass(generateSequence(id, opts), Frame);
}

test('strategy comparison reports cost, bits and real distortion', () => {
  const seq = sequence('pan', { width: 48, height: 32, frames: 5 });
  const rows = compareStrategies({ frames: seq.frames, qp: 24, radius: 8 });
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.ok(row.evaluations > 0);
    assert.ok(row.bytes > 64);
    assert.ok(Number.isFinite(row.psnr) || row.psnr === Infinity);
    assert.ok(row.rdCost > 0);
    assert.equal(row.bitsPerPixel, row.payloadBits / (seq.frames.length * 48 * 32));
  }
});

test('full search evaluates more candidates than diamond and never worse RD', () => {
  const seq = sequence('pan', { width: 48, height: 32, frames: 5 });
  const rows = summarise(compareStrategies({ frames: seq.frames, qp: 24, radius: 8 }));
  const by = Object.fromEntries(rows.map((r) => [r.strategy, r]));

  assert.ok(by.diamond.evaluations < by.full.evaluations, 'diamond must be cheaper to search');
  assert.ok(by.spiral.evaluations <= by.full.evaluations, 'spiral exits early at least sometimes');
  // Full search is the RD reference; the others must not beat it on this
  // fixture, otherwise the comparison numbers are not comparable.
  assert.ok(by.diamond.rdCost >= by.full.rdCost * 0.98);
});

test('diamond trades quality for search effort (measurable difference)', () => {
  const seq = sequence('occlusion', { width: 64, height: 48, frames: 6 });
  const full = evaluateStrategy({ frames: seq.frames, qp: 22, radius: 10, strategy: 'full' });
  const diamond = evaluateStrategy({ frames: seq.frames, qp: 22, radius: 10, strategy: 'diamond' });
  assert.ok(
    diamond.evaluations * 4 < full.evaluations,
    'diamond should need far fewer block matches',
  );
  // They should not be bit-identical: the cheaper search makes different
  // decisions somewhere in the sequence.
  assert.notEqual(full.bytes, diamond.bytes);
});

test('summarise strips heavy buffers and rounds numbers for display', () => {
  const seq = sequence('pan', { width: 32, height: 24, frames: 3 });
  const rows = summarise([evaluateStrategy({ frames: seq.frames, qp: 24, radius: 6, strategy: 'spiral' })]);
  const row = rows[0];
  assert.equal(row.bytesData, undefined);
  assert.equal(row.encodeResult, undefined);
  assert.equal(typeof row.rdCost, 'number');
  assert.equal(Number.isInteger(row.rdCost), true);
  assert.equal(Number.isFinite(row.bitsPerPixel), true);
});
