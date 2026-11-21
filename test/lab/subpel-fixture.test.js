import test from 'node:test';
import assert from 'node:assert/strict';

import { Frame } from '../../src/core/image.js';
import {
  interpolatePixel,
  interpolatePixelEarly,
  buildSubpelBlock,
  roundHalfUp,
  firstDiff,
  sseOf,
} from '../../src/lab/subpel.js';
import {
  buildTwinRefFixture,
  buildAliasFixture,
  buildSplitTileFixture,
} from '../../src/lab/fixture.js';

function flatFrame(width, height, value) {
  const frame = new Frame(width, height, 1);
  frame.planes[0].fill(value);
  return frame;
}

test('half-pel interpolator: integer offsets copy source pixels exactly', () => {
  const frame = flatFrame(16, 16, 77);
  const plane = frame.planes[0];
  assert.equal(interpolatePixel(plane, 16, 16, 2 * 5, 2 * 3), 77);
  const out = new Int32Array(64);
  buildSubpelBlock(frame, 0, 0, -4, 2, out); // -2 px x, +1 px y (all integer)
  assert.ok(out.every((v) => v === 77));
});

test('half-pel position is the mean of the two neighbours (single final rounding)', () => {
  const frame = new Frame(4, 1, 1);
  frame.planes[0].set([10, 11, 20, 21]);
  // Halfway between column 0 (10) and column 1 (11), integer row 0.
  assert.equal(interpolatePixel(frame.planes[0], 4, 1, 1, 0), roundHalfUp((10 + 11) / 2));
  assert.equal(interpolatePixel(frame.planes[0], 4, 1, 1, 0), 11);
});

test('early rounding only diverges from the correct path for diagonally fractional vectors', () => {
  // Row means carry a .5 (0/1 -> 0.5, 1/3 -> 2.0), so rounding each axis early
  // rounds the first row up to 1; the correct path keeps the half and the
  // combined mean 1.25 rounds down. The two rounding orders visibly disagree.
  const frame = new Frame(4, 4, 1);
  frame.planes[0].fill(0);
  frame.planes[0][1 * 4 + 1] = 0;
  frame.planes[0][1 * 4 + 2] = 1;
  frame.planes[0][2 * 4 + 1] = 1;
  frame.planes[0][2 * 4 + 2] = 3;
  // Quarter position on both axes between those four pixels (hx=3, hy=3).
  const correct = interpolatePixel(frame.planes[0], 4, 4, 3, 3);
  const early = interpolatePixelEarly(frame.planes[0], 4, 4, 3, 3);
  const expectedCorrect = roundHalfUp((0 + 1 + 1 + 3) / 4);
  assert.equal(correct, expectedCorrect);
  assert.equal(correct, 1);
  assert.equal(early, 2);
  assert.notEqual(correct, early);

  // Fraction on one axis only: the two implementations must coincide.
  assert.equal(
    interpolatePixel(frame.planes[0], 4, 4, 3, 2),
    interpolatePixelEarly(frame.planes[0], 4, 4, 3, 2),
  );
  assert.equal(
    interpolatePixel(frame.planes[0], 4, 4, 2, 3),
    interpolatePixelEarly(frame.planes[0], 4, 4, 2, 3),
  );
});

test('twin references carry byte-identical texture but distinct identities', () => {
  const fixture = buildTwinRefFixture();
  const ref0 = fixture.refs.get(0);
  const ref1 = fixture.refs.get(1);
  assert.notEqual(ref0, ref1);
  // Remove the occluders conceptually: texture planes differ only where the
  // two occluder rectangles were painted, and the rectangles themselves sit at
  // different positions, so the references are distinct frames.
  let differing = 0;
  for (let i = 0; i < ref0.planes[0].length; i++) {
    if (ref0.planes[0][i] !== ref1.planes[0][i]) differing += 1;
  }
  assert.ok(differing > 0, 'the two references must be distinguishable as frames');
  assert.ok(fixture.metrics.occluderHitsBlock0 && fixture.metrics.occluderHitsBlock1);
});

test('occluder crosses the target motion block boundary on both references', () => {
  const fixture = buildTwinRefFixture();
  const { bx } = fixture;
  const blockLeft = bx * 8;
  const blockRight = (bx + 1) * 8;
  const r0 = fixture.rects.ref0;
  const r1 = fixture.rects.ref1;
  assert.ok(r0.x < blockLeft && r0.x + r0.w > blockLeft, 'R0 occluder straddles the left border');
  assert.ok(r1.x < blockRight && r1.x + r1.w > blockRight, 'R1 occluder straddles the right border');
});

test('twin fixture: the correct prediction reproduces the current block with zero residual', () => {
  const fixture = buildTwinRefFixture();
  assert.equal(firstDiff(fixture.currentBlock, fixture.predictions.correct), null);
  assert.ok(fixture.residual.every((v) => v === 0));
});

test('both fault variants damage pixels, at different first pixels', () => {
  const fixture = buildTwinRefFixture();
  const earlyDiff = firstDiff(fixture.currentBlock, fixture.predictions.earlyRounding);
  const wrongDiff = firstDiff(fixture.currentBlock, fixture.predictions.wrongReference);
  assert.ok(earlyDiff, 'early rounding must change at least one pixel');
  assert.ok(wrongDiff, 'wrong reference must change at least one pixel');
  assert.notDeepEqual(earlyDiff, wrongDiff, 'the two mechanisms surface at different pixels');
});

test('alias fixture: two different tuples reconstruct identical current pixels', () => {
  const fixture = buildAliasFixture();
  assert.equal(fixture.candidates.length, 2);
  assert.notDeepEqual(
    { refId: fixture.candidates[0].refId, hmvx: fixture.candidates[0].hmvx },
    { refId: fixture.candidates[1].refId, hmvx: fixture.candidates[1].hmvx },
  );
  assert.ok(fixture.sameCurrentPixels);
  assert.equal(sseOf(fixture.candidates[0].prediction, fixture.candidates[1].prediction), 0);
});

test('alias fixture: only one candidate keeps the reference chain to id 2', () => {
  const fixture = buildAliasFixture();
  assert.equal(fixture.candidates[0].name, 'correct-relation');
  assert.equal(fixture.candidates[1].name, 'broken-relation');
  assert.notEqual(fixture.candidates[0].refId, fixture.candidates[1].refId);
});

test('split-tile fixture packs the first raster motion block into its own tile', () => {
  const fixture = buildSplitTileFixture();
  assert.equal(fixture.tiles.length, 3);
  const lastTile = fixture.tiles[2];
  assert.equal(lastTile.coords.length, 1);
  assert.deepEqual(lastTile.coords[0], fixture.firstMotionBlock);
  // The first motion block is genuinely the earliest raster inter block.
  const allInter = fixture.tiles
    .flatMap((t) => t.coords)
    .sort((a, b) => a.by - b.by || a.bx - b.bx);
  assert.deepEqual(allInter[0], fixture.firstMotionBlock);
});
