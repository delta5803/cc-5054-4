// Step-by-step error replay for the debug view.
//
// A failure packet already contains every field that was actually written.
// replayPacket() rebuilds the prediction from those fields alone (no encoder
// state), walks the 8x8 block in raster order and records each step:
// reference selection, vector application, per-pixel comparison, residual
// application. The same machinery accepts an *equivalent* vector — a different
// (refId, hmvx, hmvy) tuple whose reconstructed pixels are identical — as a
// legal replay rather than a failure, because the lab judges pixels through
// the reference relation, not through tuple identity.

import { BLOCK } from '../core/constants.js';
import { buildSubpelBlock, firstDiff, sseOf } from './subpel.js';
import { FAULT_WRONG_REFERENCE, FAULT_EARLY_ROUNDING } from './faults.js';

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Rebuild one block's prediction from raw written fields.
export function replayPrediction(store, { refId, hmvx, hmvy }, bx, by, { earlyRounding = false } = {}) {
  const reference = store.get(refId);
  const out = new Int32Array(BLOCK * BLOCK);
  buildSubpelBlock(reference, bx, by, hmvx, hmvy, out, earlyRounding);
  return out;
}

export function replayPacket(packet, store) {
  const { bx, by } = packet.block;
  const steps = [];
  const early = packet.channels && packet.channels.interpolatorChanged;
  const prediction = replayPrediction(store, packet.written, bx, by, {
    earlyRounding: early,
  });

  steps.push({
    step: 'reference',
    refId: packet.written.refId,
    available: store.has(packet.written.refId),
    note: `selected reference ${packet.written.refId} (correct id ${packet.correctSyntax.refId})`,
  });
  steps.push({
    step: 'vector',
    hmvx: packet.written.hmvx,
    hmvy: packet.written.hmvy,
    note: `applied half-pel vector (${packet.written.hmvx}, ${packet.written.hmvy})`,
  });
  steps.push({
    step: 'interpolate',
    earlyRounding: !!early,
    note: early
      ? 'per-axis rounding applied before the two axes were combined'
      : 'single rounding after full bilinear combination',
  });

  const target = packet.target;
  const pixelSteps = [];
  for (let i = 0; i < BLOCK * BLOCK; i++) {
    const x = i % BLOCK;
    const y = Math.floor(i / BLOCK);
    const expected = target[i];
    const got = prediction[i];
    pixelSteps.push({
      index: i,
      x,
      y,
      expected,
      predicted: got,
      pixelError: got - expected,
      differs: got !== expected,
    });
  }
  steps.push({ step: 'compare-pixels', firstMismatch: firstDiff(target, prediction), pixelSteps });

  const reconstructed = new Int32Array(BLOCK * BLOCK);
  for (let i = 0; i < BLOCK * BLOCK; i++) {
    reconstructed[i] = clamp8(prediction[i] + packet.written.residual[i]);
  }
  steps.push({ step: 'apply-residual', residual: Array.from(packet.written.residual), reconstructed });

  return {
    kind: packet.kind,
    block: packet.block,
    sse: sseOf(target, prediction),
    firstMismatch: firstDiff(target, prediction),
    prediction,
    reconstructed,
    steps,
  };
}

// Replay the next frame of an aliased-vector packet. Returns the propagation
// trace: where the current-frame coincidence broke and which pixel drifts
// first once the next frame's residual is decoded.
export function replayAliasPropagation(aliasFixture) {
  const next = aliasFixture.next;
  const nextBlock = blockOf(aliasFixture);
  return {
    expectedRefId: next.refId,
    firstChangedPixel: next.firstChangedPixel,
    chain: {
      residualEnergy: energy(next.residualFromChain),
      firstMismatch: firstDiff(nextBlock, next.predictionFromChain),
    },
    staleR1: {
      residualEnergy: energy(next.residualFromStaleR1),
      firstMismatch: firstDiff(nextBlock, next.predictionFromStaleR1),
    },
    driftStartsAt: next.firstChangedPixel,
  };
}

function blockOf(fixture) {
  const out = new Int32Array(BLOCK * BLOCK);
  const { width, bx, by } = fixture;
  const plane = fixture.nextFrame.planes[0];
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      out[y * BLOCK + x] = plane[(by * BLOCK + y) * width + bx * BLOCK + x];
    }
  }
  return out;
}

function energy(residual) {
  let e = 0;
  for (const v of residual) e += v * v;
  return e;
}

// Equivalent-vector legality check. Two tuples are equivalent when they name
// references the store actually holds and their reconstructed pixels are
// identical. The tuple itself need not match — this is the "same pixels,
// different legal vector" case the debug view must accept.
export function isEquivalentReconstruction(store, canonical, alternative, bx, by, target) {
  const refsAvailable = store.has(canonical.refId) && store.has(alternative.refId);
  if (!refsAvailable) {
    return {
      legal: false,
      samePixels: false,
      matchesTarget: false,
      reason: 'one of the named references is not held by the store',
      canonical: { ...canonical },
      alternative: { ...alternative },
    };
  }
  const a = replayPrediction(store, canonical, bx, by);
  const b = replayPrediction(store, alternative, bx, by);
  const samePixels = firstDiff(a, b) === null;
  const matchesTarget = firstDiff(b, target) === null;
  return {
    legal: samePixels && matchesTarget,
    samePixels,
    matchesTarget,
    canonical: { ...canonical },
    alternative: { ...alternative },
  };
}

export function describeFault(kind) {
  if (kind === FAULT_WRONG_REFERENCE) {
    return 'reference id names the twin frame; vector and residual are intact';
  }
  if (kind === FAULT_EARLY_ROUNDING) {
    return 'sub-pixel interpolation rounded each axis early; all written syntax is intact';
  }
  return kind;
}
