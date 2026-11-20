// Motion search strategies.
//
// All strategies share one objective:
//
//   J(mv) = SAD(source block, reference block at mv) + lambda * bits(mv)
//
// `bits(mv)` comes from mvcode.js, i.e. it is the true transmitted size of the
// vector under the BMPP-1 code, not a guess. `lambda` is supplied by the
// encoder and derived from the quantiser step, so vector cost is weighed
// against residual fidelity rather than acting as a tie-breaker.
//
// Candidate objects are only retained when `recordCandidates` is true. The
// encoder turns this off (a full search would otherwise allocate ~1000 objects
// per block); the UI turns it on for the single block being inspected.

import { blockSAD } from './image.js';
import { mvBits, clampMV } from './mvcode.js';
import { SEARCH_STRATEGIES } from './constants.js';

function candidate(mvx, mvy, sad, lambda) {
  const bits = mvBits(mvx, mvy);
  return { mvx, mvy, sad, bits, cost: sad + lambda * bits };
}

function better(a, b) {
  if (!b) return a;
  if (a.cost !== b.cost) return a.cost < b.cost ? a : b;
  if (a.sad !== b.sad) return a.sad < b.sad ? a : b;
  if (a.mvy !== b.mvy) return a.mvy < b.mvy ? a : b;
  if (a.mvx !== b.mvx) return a.mvx < b.mvx ? a : b;
  return a;
}

class SearchContext {
  constructor(source, reference, bx, by, radius, lambda, recordCandidates) {
    this.source = source;
    this.reference = reference;
    this.bx = bx;
    this.by = by;
    this.radius = Math.max(0, Math.min(Math.abs(Math.trunc(radius)), 255));
    this.lambda = lambda;
    this.record = recordCandidates;
    this.evaluated = 0;
    this.candidates = recordCandidates ? [] : null;
  }

  evaluate(mvx, mvy) {
    const cx = clampMV(mvx);
    const cy = clampMV(mvy);
    const sad = blockSAD(this.source, this.reference, this.bx, this.by, cx, cy);
    const c = candidate(cx, cy, sad, this.lambda);
    this.evaluated += 1;
    if (this.record) this.candidates.push(c);
    return c;
  }

  within(mvx, mvy) {
    return Math.abs(mvx) <= this.radius && Math.abs(mvy) <= this.radius;
  }
}

function searchFull(ctx) {
  let best = null;
  const r = ctx.radius;
  for (let mvy = -r; mvy <= r; mvy++) {
    for (let mvx = -r; mvx <= r; mvx++) best = better(ctx.evaluate(mvx, mvy), best);
  }
  return { best, mode: 'exhaustive', stopRing: null };
}

// Concentric square rings, inner to outer. Early exit fires when the ring's
// best SAD is at or below `earlyExitSad` (a near-perfect match means wider
// vectors cannot win on RD cost).
function searchSpiral(ctx, earlyExitSad) {
  let best = ctx.evaluate(0, 0);
  if (best.sad <= earlyExitSad) {
    return { best, mode: 'early-exit-center', stopRing: 0 };
  }
  const r = ctx.radius;
  for (let ring = 1; ring <= r; ring++) {
    let ringBest = null;
    for (let x = -ring; x <= ring; x++) {
      for (const y of [-ring, ring]) {
        if (!ctx.within(x, y)) continue;
        ringBest = better(ctx.evaluate(x, y), ringBest);
      }
    }
    for (let y = -ring + 1; y <= ring - 1; y++) {
      for (const x of [-ring, ring]) {
        if (!ctx.within(x, y)) continue;
        ringBest = better(ctx.evaluate(x, y), ringBest);
      }
    }
    if (ringBest) {
      best = better(ringBest, best);
      if (ringBest.sad <= earlyExitSad) {
        return { best, mode: 'early-exit', stopRing: ring };
      }
    }
  }
  return { best, mode: 'exhausted', stopRing: r };
}

// Diamond search: start at zero, take the best of the 9-point diamond at the
// current step, step down by powers of two, finish with a ±1 refinement.
const DIAMOND = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

function searchDiamond(ctx) {
  let centre = ctx.evaluate(0, 0);
  let step = Math.max(1, ctx.radius);
  while (step >= 1) {
    let improved = true;
    while (improved) {
      improved = false;
      let local = centre;
      for (const [dx, dy] of DIAMOND) {
        const nx = centre.mvx + dx * step;
        const ny = centre.mvy + dy * step;
        if (!ctx.within(nx, ny)) continue;
        const c = ctx.evaluate(nx, ny);
        if (c.cost < local.cost) {
          local = c;
          improved = true;
        }
      }
      if (improved) centre = local;
    }
    step = Math.floor(step / 2);
  }
  return { best: centre, mode: 'diamond', stopRing: null };
}

export function searchBlock({
  source,
  reference,
  bx,
  by,
  radius,
  lambda,
  strategy,
  earlyExitSad = 0,
  recordCandidates = false,
}) {
  const ctx = new SearchContext(source, reference, bx, by, radius, lambda, recordCandidates);
  let result;
  switch (strategy) {
    case SEARCH_STRATEGIES.FULL:
      result = searchFull(ctx);
      break;
    case SEARCH_STRATEGIES.SPIRAL:
      result = searchSpiral(ctx, earlyExitSad);
      break;
    case SEARCH_STRATEGIES.DIAMOND:
      result = searchDiamond(ctx);
      break;
    default:
      throw new Error(`unknown search strategy: ${strategy}`);
  }
  return {
    strategy,
    best: result.best,
    mode: result.mode,
    stopRing: result.stopRing,
    evaluated: ctx.evaluated,
    candidates: ctx.candidates,
    radius: ctx.radius,
    lambda: ctx.lambda,
  };
}

// Exhaustive, cost-free reference used by tests to reason about SAD-optimal
// versus RD-optimal displacement.
export function exhaustiveOptions({ source, reference, bx, by, radius }) {
  const r = Math.max(0, Math.min(Math.abs(Math.trunc(radius)), 255));
  const list = [];
  for (let mvy = -r; mvy <= r; mvy++) {
    for (let mvx = -r; mvx <= r; mvx++) {
      list.push({ mvx, mvy, sad: blockSAD(source, reference, bx, by, mvx, mvy) });
    }
  }
  return list;
}
