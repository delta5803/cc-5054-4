// Fault injection and failure packets.
//
// Two deliberately different faults that can produce pixel errors of similar
// magnitude on the same block:
//
//   WRONG_REFERENCE  the transmitted reference id names the twin frame; the
//                    vector and residual are untouched, so the vector and
//                    residual channels stay byte-identical and only the
//                    reference-id channel can explain the mismatch.
//   EARLY_ROUNDING   the right reference and vector, but the sub-pixel
//                    interpolator rounds each axis before combining; every
//                    written syntax field is identical, so only pixels move.
//
// A failure packet carries everything a debugger needs to replay the damage
// from fields alone: the actual written vector / ref id / residual, the
// correct and faulty 8x8 predictions, and the first mismatching pixel.

import { BLOCK } from '../core/constants.js';
import { buildSubpelBlock, sseOf, sadOf, firstDiff } from './subpel.js';

export const FAULT_WRONG_REFERENCE = 'wrong-reference';
export const FAULT_EARLY_ROUNDING = 'early-rounding';

export function applyFault(fixture, fault, options = {}) {
  if (fault === FAULT_WRONG_REFERENCE) {
    const wrongRefId = options.wrongRefId ?? 1;
    const reference = fixture.refs.get(wrongRefId);
    if (!reference) throw new Error(`fixture has no reference ${wrongRefId}`);
    const prediction = new Int32Array(BLOCK * BLOCK);
    buildSubpelBlock(reference, fixture.bx, fixture.by, fixture.hmvx, fixture.hmvy, prediction, false);
    return makePacket(fixture, {
      kind: FAULT_WRONG_REFERENCE,
      refId: wrongRefId,
      correctRefId: 0,
      hmvx: fixture.hmvx,
      hmvy: fixture.hmvy,
      prediction,
      detail: `vector and residual unchanged; reference id swapped 0 -> ${wrongRefId}`,
    });
  }
  if (fault === FAULT_EARLY_ROUNDING) {
    const prediction = new Int32Array(BLOCK * BLOCK);
    buildSubpelBlock(
      fixture.refs.get(0),
      fixture.bx,
      fixture.by,
      fixture.hmvx,
      fixture.hmvy,
      prediction,
      true,
    );
    return makePacket(fixture, {
      kind: FAULT_EARLY_ROUNDING,
      refId: 0,
      correctRefId: 0,
      hmvx: fixture.hmvx,
      hmvy: fixture.hmvy,
      prediction,
      detail: 'bilinear interpolation rounded per axis before combining',
    });
  }
  throw new Error(`unknown fault ${fault}`);
}

function makePacket(fixture, spec) {
  const target = fixture.currentBlock;
  const correct = fixture.predictions.correct;
  const residual = fixture.residual;
  const diff = firstDiff(target, spec.prediction);
  const sse = sseOf(target, spec.prediction);
  const sad = sadOf(target, spec.prediction);
  const differingPixels = countDiffering(target, spec.prediction);
  return {
    kind: spec.kind,
    block: { bx: fixture.bx, by: fixture.by },
    written: {
      refId: spec.refId,
      hmvx: spec.hmvx,
      hmvy: spec.hmvy,
      residual: Int32Array.from(residual),
    },
    correctSyntax: {
      refId: spec.correctRefId,
      hmvx: fixture.hmvx,
      hmvy: fixture.hmvy,
      residual: new Int32Array(residual),
    },
    channels: {
      refIdChanged: spec.refId !== spec.correctRefId,
      vectorChanged: false,
      residualChanged: false,
      interpolatorChanged: spec.kind === FAULT_EARLY_ROUNDING,
    },
    predictions: {
      correct: Int32Array.from(correct),
      faulty: Int32Array.from(spec.prediction),
    },
    target: Int32Array.from(target),
    firstMismatch: diff,
    differingPixels,
    sse,
    sad,
    detail: spec.detail,
  };
}

function countDiffering(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n += 1;
  return n;
}

// Packet for the aliased-vector fixture, where two legal candidate choices
// coincide on current pixels. `candidateName` selects which written tuple the
// packet describes; the packet records whether its reference chain is valid.
export function packetForAlias(fixture, candidateName) {
  const candidate = fixture.candidates.find((c) => c.name === candidateName);
  if (!candidate) throw new Error(`unknown candidate ${candidateName}`);
  const target = fixture.currentBlock;
  const diff = firstDiff(target, candidate.prediction);
  const next = fixture.next;
  return {
    kind: 'aliased-vector',
    block: { bx: fixture.bx, by: fixture.by },
    written: {
      refId: candidate.refId,
      hmvx: candidate.hmvx,
      hmvy: candidate.hmvy,
      residual: new Int32Array(BLOCK * BLOCK),
    },
    validReferenceChain: candidateName === 'correct-relation',
    currentPixelsMatch: diff === null,
    nextFrame: {
      expectedRefId: next.refId,
      hmvx: next.hmvx,
      hmvy: next.hmvy,
      firstChangedPixel: next.firstChangedPixel,
      residualFromChain: Int32Array.from(next.residualFromChain),
      residualFromStaleR1: Int32Array.from(next.residualFromStaleR1),
    },
    predictions: {
      candidate: Int32Array.from(candidate.prediction),
    },
    firstMismatch: diff,
    sse: sseOf(target, candidate.prediction),
    detail:
      candidateName === 'correct-relation'
        ? 'flat-region fetch from the reference the chain actually holds'
        : 'same flat pixels fetched from the twin reference; chain to id 2 is broken',
  };
}
