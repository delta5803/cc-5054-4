import test from 'node:test';
import assert from 'node:assert/strict';

import { ReferenceStore } from '../../src/lab/refstore.js';
import {
  buildTwinRefFixture,
  buildAliasFixture,
} from '../../src/lab/fixture.js';
import {
  applyFault,
  packetForAlias,
  FAULT_WRONG_REFERENCE,
  FAULT_EARLY_ROUNDING,
} from '../../src/lab/faults.js';
import {
  diagnoseBlocks,
  firstPixelMismatch,
  classifyPacket,
  similarPixelError,
  classifyAlias,
} from '../../src/lab/diagnose.js';
import { reduceFaultSample, summariseReduction } from '../../src/lab/reducer.js';
import {
  replayPacket,
  replayAliasPropagation,
  isEquivalentReconstruction,
  describeFault,
} from '../../src/lab/replay.js';

function storeFrom(fixture) {
  const store = new ReferenceStore();
  for (const [id, frame] of fixture.refs) store.add(id, frame);
  return store;
}

function expectedSyntax(fixture) {
  return [
    {
      bx: fixture.bx,
      by: fixture.by,
      mode: 1,
      refId: 0,
      hmvx: fixture.hmvx,
      hmvy: fixture.hmvy,
      residual: fixture.residual,
    },
  ];
}

test('the two faults produce pixel errors of similar magnitude', () => {
  const fixture = buildTwinRefFixture();
  const wrong = applyFault(fixture, FAULT_WRONG_REFERENCE);
  const early = applyFault(fixture, FAULT_EARLY_ROUNDING);
  assert.ok(wrong.sse > 0 && early.sse > 0);
  assert.ok(
    similarPixelError(wrong, early, 4),
    `SSE should be within a 4x band, got ${wrong.sse} vs ${early.sse}`,
  );
});

test('wrong-reference fault: only the refId channel explains the mismatch', () => {
  const fixture = buildTwinRefFixture();
  const packet = applyFault(fixture, FAULT_WRONG_REFERENCE);
  assert.equal(classifyPacket(packet), 'refId');
  assert.deepEqual(packet.written.hmvx, packet.correctSyntax.hmvx);
  assert.deepEqual(Array.from(packet.written.residual), Array.from(packet.correctSyntax.residual));

  const actual = [
    {
      bx: fixture.bx,
      by: fixture.by,
      mode: 1,
      refId: packet.written.refId,
      hmvx: packet.written.hmvx,
      hmvy: packet.written.hmvy,
      residual: packet.written.residual,
    },
  ];
  const diagnosis = diagnoseBlocks(expectedSyntax(fixture), actual);
  assert.ok(diagnosis.first.refId, 'refId channel must fire');
  assert.equal(diagnosis.first.vector, null);
  assert.equal(diagnosis.first.residual, null);
  assert.equal(diagnosis.first.mode, null);
});

test('early-rounding fault: every written channel is clean, pixels still mismatch', () => {
  const fixture = buildTwinRefFixture();
  const packet = applyFault(fixture, FAULT_EARLY_ROUNDING);
  assert.equal(classifyPacket(packet), 'interpolator');
  assert.equal(packet.channels.refIdChanged, false);
  assert.equal(packet.channels.vectorChanged, false);
  assert.equal(packet.channels.residualChanged, false);

  const actual = [
    {
      bx: fixture.bx,
      by: fixture.by,
      mode: 1,
      refId: 0,
      hmvx: fixture.hmvx,
      hmvy: fixture.hmvy,
      residual: fixture.residual,
    },
  ];
  const diagnosis = diagnoseBlocks(expectedSyntax(fixture), actual, new Map([
    [
      `${fixture.bx},${fixture.by}`,
      { expected: fixture.currentBlock, actual: packet.predictions.faulty },
    ],
  ]));
  assert.deepEqual(diagnosis.cleanChannels.sort(), ['mode', 'refId', 'residual', 'vector']);
  assert.ok(diagnosis.channels.pixels.length > 0, 'the pixel channel carries the only signature');
  assert.equal(diagnosis.first.refId, null);
});

test('the tester locates the first mismatching block independently per channel', () => {
  // Two blocks: the earlier raster block has a wrong refId, the later one a
  // wrong vector; each channel must report its own first block.
  const base = buildTwinRefFixture();
  const expected = [
    { bx: 0, by: 0, mode: 1, refId: 0, hmvx: -3, hmvy: -3, residual: base.residual },
    { bx: 1, by: 0, mode: 1, refId: 0, hmvx: -3, hmvy: -3, residual: base.residual },
  ];
  const actual = [
    { bx: 0, by: 0, mode: 1, refId: 1, hmvx: -3, hmvy: -3, residual: base.residual },
    { bx: 1, by: 0, mode: 1, refId: 0, hmvx: -5, hmvy: -3, residual: base.residual },
  ];
  const diagnosis = diagnoseBlocks(expected, actual);
  assert.deepEqual({ bx: diagnosis.first.refId.bx, by: diagnosis.first.refId.by }, { bx: 0, by: 0 });
  assert.deepEqual({ bx: diagnosis.first.vector.bx, by: diagnosis.first.vector.by }, { bx: 1, by: 0 });
});

test('first pixel mismatch reports coordinate and both values', () => {
  const a = new Int32Array([10, 10, 10]);
  const b = new Int32Array([10, 12, 10]);
  assert.deepEqual(firstPixelMismatch(a, b), { index: 1, x: 1, y: 0, expected: 10, actual: 12 });
  assert.equal(firstPixelMismatch(a, a), null);
});

test('replay rebuilds the fault from packet fields alone, in ordered steps', () => {
  const fixture = buildTwinRefFixture();
  const store = storeFrom(fixture);
  for (const fault of [FAULT_WRONG_REFERENCE, FAULT_EARLY_ROUNDING]) {
    const packet = applyFault(fixture, fault);
    const trace = replayPacket(packet, store);
    assert.deepEqual(trace.steps.map((s) => s.step), [
      'reference',
      'vector',
      'interpolate',
      'compare-pixels',
      'apply-residual',
    ]);
    assert.equal(trace.sse, packet.sse);
    assert.deepEqual(trace.firstMismatch, packet.firstMismatch);
    // The replay's compare step must mark exactly the packet's first mismatch.
    const compare = trace.steps.find((s) => s.step === 'compare-pixels');
    const firstBad = compare.pixelSteps.find((p) => p.differs);
    assert.deepEqual(
      { x: firstBad.x, y: firstBad.y },
      { x: packet.firstMismatch.x, y: packet.firstMismatch.y },
    );
  }
});

test('replay accepts an equivalent vector that reconstructs identical pixels', () => {
  const fixture = buildAliasFixture();
  const store = storeFrom(fixture);
  const [canonical, alternative] = fixture.candidates;
  const verdict = isEquivalentReconstruction(
    store,
    { refId: canonical.refId, hmvx: canonical.hmvx, hmvy: canonical.hmvy },
    { refId: alternative.refId, hmvx: alternative.hmvx, hmvy: alternative.hmvy },
    fixture.bx,
    fixture.by,
    fixture.currentBlock,
  );
  assert.equal(verdict.legal, true);
  assert.equal(verdict.samePixels, true);
  assert.notDeepEqual(verdict.canonical, verdict.alternative);

  // A tuple naming a missing reference is rejected rather than thrown.
  const missing = isEquivalentReconstruction(
    store,
    { refId: canonical.refId, hmvx: canonical.hmvx, hmvy: canonical.hmvy },
    { refId: 99, hmvx: 0, hmvy: 0 },
    fixture.bx,
    fixture.by,
    fixture.currentBlock,
  );
  assert.equal(missing.legal, false);
});

test('alias: legal alternative vs coincidental pass then drift are distinct conclusions', () => {
  const fixture = buildAliasFixture();
  const legal = classifyAlias(fixture, 'correct-relation');
  const drift = classifyAlias(fixture, 'broken-relation');
  assert.equal(legal.conclusion, 'legal-alternative');
  assert.equal(legal.currentMatch, true);
  assert.equal(drift.conclusion, 'coincidental-pass-then-drift');
  assert.equal(drift.currentMatch, true);
  assert.ok(drift.staleResidualEnergy > drift.chainResidualEnergy);

  const packet = packetForAlias(fixture, 'broken-relation');
  assert.equal(packet.currentPixelsMatch, true);
  assert.equal(packet.validReferenceChain, false);
  assert.ok(packet.nextFrame.residualFromStaleR1.some((v) => v !== 0));
});

test('next-frame propagation pinpoints where the drift starts', () => {
  const fixture = buildAliasFixture();
  const trace = replayAliasPropagation(fixture);
  assert.equal(trace.expectedRefId, 2);
  assert.deepEqual(trace.driftStartsAt, fixture.next.firstChangedPixel);
  assert.ok(trace.staleR1.residualEnergy > trace.chain.residualEnergy);
  // The legal chain's first mismatch is exactly the one changed pixel.
  assert.deepEqual(
    { x: trace.chain.firstMismatch.x, y: trace.chain.firstMismatch.y },
    { x: fixture.next.firstChangedPixel.x, y: fixture.next.firstChangedPixel.y },
  );
});

test('reducer shrinks geometry and displacement while preserving each fault mechanism', () => {
  for (const fault of [FAULT_WRONG_REFERENCE, FAULT_EARLY_ROUNDING]) {
    const result = reduceFaultSample(fault);
    const summary = summariseReduction(result);
    assert.equal(summary.mechanismPreserved, true);
    assert.ok(summary.minimalGeometry.width <= 24);
    assert.ok(summary.minimalGeometry.height <= 24);
    assert.ok(summary.sse > 0);
    // Every accepted attempt kept the same mechanism id and a real first diff.
    for (const attempt of result.attempts.filter((a) => a.ok)) {
      assert.equal(attempt.mechanism, fault);
      assert.notEqual(attempt.firstMismatch, null);
    }
  }
});

test('reducer keeps an odd/odd half-pel vector for the rounding fault (else it cannot fire)', () => {
  const result = reduceFaultSample(FAULT_EARLY_ROUNDING);
  assert.notEqual(result.minimal.hmvx % 2, 0);
  assert.notEqual(result.minimal.hmvy % 2, 0);
  // And a reduced case that "passes" would have been rejected: assert the
  // minimal case still presents an interpolator-only signature.
  assert.equal(result.packet.channels.interpolatorChanged, true);
  assert.equal(result.packet.channels.refIdChanged, false);
});

test('reducer predicate rejects shrunken cases where the fault no longer fires', () => {
  // A custom predicate that demands an artificially high SSE: no small case
  // can satisfy it, so the reducer must refuse rather than silently pass.
  assert.throws(() =>
    reduceFaultSample(FAULT_EARLY_ROUNDING, {
      predicate: (fixture, packet) => packet.sse > 1_000_000,
    }),
  );
});

test('describeFault identifies both mechanisms in plain language', () => {
  assert.match(describeFault(FAULT_WRONG_REFERENCE), /reference id/);
  assert.match(describeFault(FAULT_EARLY_ROUNDING), /rounded/);
});
