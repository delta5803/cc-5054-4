// Channel-wise block diagnosis.
//
// The tester must not collapse "the pictures differ" into one boolean. It
// compares what was actually written on three independent channels — motion
// vector, reference id, residual — and then the resulting pixels, and reports
// the first mismatching block per channel in raster order. A fault that only
// corrupts the interpolator leaves every written channel clean, which is how
// an early-rounding fault is distinguished from a swapped reference id even
// when the pixel SSE happens to be similar.

import { BLOCK } from '../core/constants.js';

function blockKey(b) {
  return `${b.bx},${b.by}`;
}

// expected/actual: arrays of block records carrying mode, refId, hmvx, hmvy
// and a residual Int32Array. Raster order is the tie breaker for "first".
// `pixelPlanes` optionally maps "bx,by" to {expected, actual} 8x8 buffers so
// the pixel channel is diagnosed alongside the three written channels.
export function diagnoseBlocks(expected, actual, pixelPlanes = null) {
  const actualByKey = new Map(actual.map((b) => [blockKey(b), b]));
  const channels = {
    mode: [],
    refId: [],
    vector: [],
    residual: [],
    pixels: [],
  };
  const ordered = expected
    .map((block) => ({ block, seen: actualByKey.get(blockKey(block)) }))
    .sort((a, b) => a.block.by - b.block.by || a.block.bx - b.block.bx);

  for (const { block, seen } of ordered) {
    if (!seen) {
      channels.mode.push({ bx: block.bx, by: block.by, expected: block.mode, actual: null });
      continue;
    }
    if (seen.mode !== block.mode) {
      channels.mode.push({ bx: block.bx, by: block.by, expected: block.mode, actual: seen.mode });
    }
    if (block.refId !== seen.refId) {
      channels.refId.push({ bx: block.bx, by: block.by, expected: block.refId, actual: seen.refId });
    }
    if (seen.hmvx !== block.hmvx || seen.hmvy !== block.hmvy) {
      channels.vector.push({
        bx: block.bx,
        by: block.by,
        expected: { hmvx: block.hmvx, hmvy: block.hmvy },
        actual: { hmvx: seen.hmvx, hmvy: seen.hmvy },
      });
    }
    const residualMismatch = firstResidualMismatch(block.residual, seen.residual);
    if (residualMismatch) {
      channels.residual.push({ bx: block.bx, by: block.by, ...residualMismatch });
    }
    if (pixelPlanes) {
      const planes = pixelPlanes.get(blockKey(block));
      if (planes) {
        const pixelMismatch = firstResidualMismatch(planes.expected, planes.actual);
        if (pixelMismatch) channels.pixels.push({ bx: block.bx, by: block.by, ...pixelMismatch });
      }
    }
  }

  return {
    channels,
    first: {
      mode: channels.mode[0] ?? null,
      refId: channels.refId[0] ?? null,
      vector: channels.vector[0] ?? null,
      residual: channels.residual[0] ?? null,
    },
    cleanChannels: Object.entries(channels)
      .filter(([, list]) => list.length === 0)
      .map(([name]) => name),
  };
}

function firstResidualMismatch(expected, actual) {
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    if (expected[i] !== actual[i]) {
      return {
        index: i,
        x: i % BLOCK,
        y: Math.floor(i / BLOCK),
        expected: expected[i],
        actual: actual[i],
      };
    }
  }
  return null;
}

// Pixel-level comparison of two 8x8 buffers (or same-sized planes), used once
// the written channels have been ruled out.
export function firstPixelMismatch(expected, actual) {
  if (expected.length !== actual.length) {
    throw new RangeError('pixel buffers must have the same length');
  }
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) {
      return { index: i, x: i % BLOCK, y: Math.floor(i / BLOCK), expected: expected[i], actual: actual[i] };
    }
  }
  return null;
}

// Classify a failure packet against the three written channels plus pixels.
// Returns the channel that actually explains the damage, never just "pixels
// differ": wrong-reference faults own the refId channel, early-rounding faults
// have no written-channel signature and are attributed to the interpolator.
export function classifyPacket(packet) {
  if (packet.kind === 'aliased-vector') return 'aliased-vector';
  if (packet.channels.refIdChanged) return 'refId';
  if (packet.channels.vectorChanged) return 'vector';
  if (packet.channels.residualChanged) return 'residual';
  if (packet.channels.interpolatorChanged) return 'interpolator';
  return 'none';
}

// Two faults count as "similar pixel error" when their block SSE is within a
// small multiplicative band; the tests use this to prove pixel magnitude alone
// cannot tell the two fault mechanisms apart.
export function similarPixelError(a, b, factor = 4) {
  if (a.sse === 0 || b.sse === 0) return false;
  const hi = Math.max(a.sse, b.sse);
  const lo = Math.min(a.sse, b.sse);
  return hi <= lo * factor;
}

// Decision between the two alias conclusions. A candidate that reproduces the
// current pixels but has no valid reference chain can only look correct on the
// current frame: the next frame carries a non-zero residual where the legal
// chain predicts near-exactly, which is the drift signature.
export function classifyAlias(fixture, candidateName) {
  const candidate = fixture.candidates.find((c) => c.name === candidateName);
  if (!candidate) throw new Error(`unknown candidate ${candidateName}`);
  const currentMatch = firstPixelMismatch(fixture.currentBlock, candidate.prediction) === null;
  const next = fixture.next;
  let chainEnergy = 0;
  let staleEnergy = 0;
  for (const v of next.residualFromChain) chainEnergy += v * v;
  for (const v of next.residualFromStaleR1) staleEnergy += v * v;
  const legal = candidateName === 'correct-relation';
  if (legal && currentMatch && chainEnergy <= staleEnergy) {
    return {
      conclusion: 'legal-alternative',
      currentMatch,
      chainResidualEnergy: chainEnergy,
      staleResidualEnergy: staleEnergy,
      note: 'bitstream legal; a different but reference-valid choice reproduces the same pixels',
    };
  }
  if (currentMatch && staleEnergy > chainEnergy) {
    return {
      conclusion: 'coincidental-pass-then-drift',
      currentMatch,
      chainResidualEnergy: chainEnergy,
      staleResidualEnergy: staleEnergy,
      note: 'current frame passes by coincidence; the next-frame residual exposes the broken reference chain',
    };
  }
  return {
    conclusion: 'mismatch',
    currentMatch,
    chainResidualEnergy: chainEnergy,
    staleResidualEnergy: staleEnergy,
    note: 'candidate does not reproduce the current pixels',
  };
}
