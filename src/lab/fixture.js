// Deterministic lab fixtures.
//
// Everything here is constructed from numeric recipes (no scenario files, no
// randomness) so the tests can assert exact block coordinates, reference ids
// and first-diff pixels. Two fixture families cover the brief:
//
//   buildTwinRefFixture  two references with byte-identical texture but
//                        different identities, plus an occluder rectangle that
//                        crosses the target motion block's boundary; feeds the
//                        wrong-reference and early-rounding fault variants.
//   buildSplitTileFixture a stream whose very first motion block was assigned
//                        to a different tile than the reference-producing tile,
//                        so an out-of-order arrival must suspend predictions.
//   buildAliasFixture    two candidate vectors that yield identical current
//                        pixels, only one keeping the correct reference
//                        relation; the next-frame residuals separate the legal
//                        alternative from the coincidental-pass / later-drift
//                        conclusion.

import { Frame } from '../core/image.js';
import { BLOCK } from '../core/constants.js';
import { buildSubpelBlock, blockResidual, sseOf, firstDiff } from './subpel.js';
import { writeTile, LAB_MODE_INTER, LAB_MODE_INTRA, LAB_INTRA_DC } from './tile.js';

// Smooth, deterministic band-limited texture in [16, 240]. Independent of
// src/core/scenarios.js so lab fixtures stay self-contained.
function makeTexture(width, height, seed) {
  const out = new Uint8Array(width * height);
  const p1 = (seed * 0.173) % (Math.PI * 2);
  const p2 = (seed * 0.419 + 1.7) % (Math.PI * 2);
  const p3 = (seed * 0.811 + 0.4) % (Math.PI * 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v =
        128 +
        42 * Math.sin(x * 0.21 + p1) * Math.cos(y * 0.13 + p2) +
        24 * Math.sin((x + y) * 0.09 + p3) +
        12 * Math.sin(x * 0.47 - y * 0.31 + p2);
      out[y * width + x] = Math.max(16, Math.min(240, Math.round(v)));
    }
  }
  return out;
}

function frameFromPlane(width, height, plane) {
  const frame = new Frame(width, height, 1);
  frame.planes[0].set(plane);
  return frame;
}

// Paint a flat rectangle; value 0 means "leave the texture untouched".
function paintRect(plane, width, rect, value) {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      plane[y * width + x] = value;
    }
  }
}

function rectsOverlapBlock(rect, bx, by) {
  const x0 = bx * BLOCK;
  const y0 = by * BLOCK;
  return (
    rect.x < x0 + BLOCK && rect.x + rect.w > x0 && rect.y < y0 + BLOCK && rect.y + rect.h > y0
  );
}

// Integer reference columns/rows touched by a half-pel block fetch.
function sampledWindow(bx, by, hmvx, hmvy) {
  const x0 = bx * BLOCK;
  const y0 = by * BLOCK;
  const hx0 = 2 * x0 + hmvx;
  const hy0 = 2 * y0 + hmvy;
  const hx1 = 2 * (x0 + BLOCK - 1) + hmvx;
  const hy1 = 2 * (y0 + BLOCK - 1) + hmvy;
  return {
    x0: Math.floor(hx0 / 2),
    x1: Math.ceil(hx1 / 2),
    y0: Math.floor(hy0 / 2),
    y1: Math.ceil(hy1 / 2),
  };
}

// Number of block pixels covered by a rectangle (partial coverage counts).
function rectCoverageInBlock(rect, width, height, bx, by) {
  const x0 = bx * BLOCK;
  const y0 = by * BLOCK;
  const x1 = Math.min(width, x0 + BLOCK);
  const y1 = Math.min(height, y0 + BLOCK);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) n += 1;
    }
  }
  return n;
}

// -- twin references + occluder --------------------------------------------
//
// R0 and R1 share one texture plane. Each carries a small flat occluder; the
// two occluders sit on opposite sides of the target block's boundary so that,
// inside the target block, they cover different pixels. The current frame is
// generated from R0 with a diagonally fractional vector (odd/odd half-pel),
// which is what makes the early-rounding fault observable.
export function buildTwinRefFixture(opts = {}) {
  const width = opts.width ?? 24;
  const height = opts.height ?? 24;
  const bx = opts.bx ?? 1;
  const by = opts.by ?? 1;
  const hmvx = opts.hmvx ?? -7; // -3.5 px
  const hmvy = opts.hmvy ?? -5; // -2.5 px
  const seed = opts.seed ?? 11;

  const texture = makeTexture(width, height, seed);
  // Keep the occluder close to the texture level inside the exact window the
  // target block samples, so a wrong reference produces an error of the same
  // order as a one-level rounding fault. Pixel magnitude alone must not be
  // enough to separate the two fault mechanisms.
  const sampleWindow = sampledWindow(bx, by, hmvx, hmvy);
  const windowValues = [];
  for (let y = sampleWindow.y0; y <= sampleWindow.y1; y++) {
    for (let x = sampleWindow.x0; x <= sampleWindow.x1; x++) {
      windowValues.push(texture[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))]);
    }
  }
  const windowAvg = windowValues.reduce((a, v) => a + v, 0) / windowValues.length;
  const occluderValue =
    opts.occluderValue ?? Math.max(16, Math.min(240, Math.round(windowAvg) + 2));

  const plane0 = texture.slice();
  const plane1 = texture.slice();

  // Occluders are thin strips crossing the target block's left (R0) and right
  // (R1) border. Each covers only a couple of samples inside the block, so the
  // wrong-reference damage stays comparable to a single rounding level rather
  // than swamping the sub-pixel fault's SSE.
  const rect0 = { x: bx * BLOCK - 1, y: by * BLOCK + 3, w: 2, h: 2 };
  const rect1 = { x: (bx + 1) * BLOCK - 1, y: by * BLOCK + 3, w: 2, h: 2 };
  paintRect(plane0, width, rect0, occluderValue);
  paintRect(plane1, width, rect1, occluderValue);

  const ref0 = frameFromPlane(width, height, plane0);
  const ref1 = frameFromPlane(width, height, plane1);

  const correctPred = new Int32Array(BLOCK * BLOCK);
  buildSubpelBlock(ref0, bx, by, hmvx, hmvy, correctPred, false);
  // Current frame = correct prediction, zero residual, so any pixel damage is
  // attributable purely to the prediction fault under test.
  const currentPlane = new Uint8Array(width * height);
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      currentPlane[(by * BLOCK + y) * width + bx * BLOCK + x] = correctPred[y * BLOCK + x];
    }
  }
  const current = frameFromPlane(width, height, currentPlane);

  const earlyPred = new Int32Array(BLOCK * BLOCK);
  buildSubpelBlock(ref0, bx, by, hmvx, hmvy, earlyPred, true);
  const wrongRefPred = new Int32Array(BLOCK * BLOCK);
  buildSubpelBlock(ref1, bx, by, hmvx, hmvy, wrongRefPred, false);

  const currentBlock = new Int32Array(BLOCK * BLOCK);
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      currentBlock[y * BLOCK + x] =
        current.planes[0][(by * BLOCK + y) * width + bx * BLOCK + x];
    }
  }

  return {
    width,
    height,
    bx,
    by,
    hmvx,
    hmvy,
    texture,
    rects: { ref0: rect0, ref1: rect1 },
    occluderValue,
    refs: new Map([
      [0, ref0],
      [1, ref1],
    ]),
    current,
    currentBlock,
    correctPred,
    predictions: {
      correct: correctPred,
      earlyRounding: earlyPred,
      wrongReference: wrongRefPred,
    },
    metrics: {
      earlyRounding: {
        sse: sseOf(currentBlock, earlyPred),
        firstDiff: firstDiff(currentBlock, earlyPred),
      },
      wrongReference: {
        sse: sseOf(currentBlock, wrongRefPred),
        firstDiff: firstDiff(currentBlock, wrongRefPred),
      },
      coverage0: rectCoverageInBlock(rect0, width, height, bx, by),
      coverage1: rectCoverageInBlock(rect1, width, height, bx, by),
      occluderHitsBlock0: rectsOverlapBlock(rect0, bx, by),
      occluderHitsBlock1: rectsOverlapBlock(rect1, bx, by),
    },
    residual: blockResidual(current, bx, by, correctPred),
  };
}

// -- split tiles, first motion block on the late tile ----------------------
//
// Frame 0 (reference id 0) is produced as an intra tile. Frame 1 contains
// inter blocks referencing id 0, but its first motion block in raster order
// was packed into a separate tile. A decoder that receives tile 1 before the
// reference tile must suspend those inter blocks while still decoding any
// intra block that shares the tile.
export function buildSplitTileFixture(opts = {}) {
  const width = opts.width ?? 24;
  const height = opts.height ?? 16;
  const cols = Math.ceil(width / BLOCK);
  const rows = Math.ceil(height / BLOCK);
  const allBlocks = [];
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) allBlocks.push({ bx, by });
  }

  const texture = makeTexture(width, height, opts.seed ?? 23);
  const refPlane = texture.slice();
  // Give the reference a recognizable feature so inter predictions differ
  // from the intra DC fallback.
  paintRect(refPlane, width, { x: 2, y: 2, w: 8, h: 6 }, 70);
  const reference = frameFromPlane(width, height, refPlane);

  // Tile 0: the intra-coded reference frame, one block per grid cell.
  const refBlocks = allBlocks.map(({ bx, by }) => {
    const residual = new Int32Array(BLOCK * BLOCK);
    const x0 = bx * BLOCK;
    const y0 = by * BLOCK;
    for (let y = 0; y < BLOCK; y++) {
      for (let x = 0; x < BLOCK; x++) {
        const px = x0 + x;
        const py = y0 + y;
        if (px >= width || py >= height) continue;
        residual[y * BLOCK + x] = refPlane[py * width + px] - LAB_INTRA_DC;
      }
    }
    return { bx, by, mode: LAB_MODE_INTRA, residual };
  });

  // Current frame blocks: half-pel inter from ref 0, plus one intra block so
  // the late tile has something independently decodable while suspended.
  const hmvx = opts.hmvx ?? -3;
  const hmvy = opts.hmvy ?? -3;
  const intraIndex = 2;
  const curBlocks = allBlocks.map((cell, i) => {
    if (i === intraIndex) {
      const residual = new Int32Array(BLOCK * BLOCK);
      residual.fill(20); // deterministic intra content
      return { ...cell, mode: LAB_MODE_INTRA, residual };
    }
    const pred = new Int32Array(BLOCK * BLOCK);
    buildSubpelBlock(reference, cell.bx, cell.by, hmvx, hmvy, pred, false);
    const residual = new Int32Array(BLOCK * BLOCK);
    const x0 = cell.bx * BLOCK;
    const y0 = cell.by * BLOCK;
    for (let y = 0; y < BLOCK; y++) {
      for (let x = 0; x < BLOCK; x++) {
        const px = x0 + x;
        const py = y0 + y;
        if (px >= width || py >= height) continue;
        const src = texture[py * width + px];
        residual[y * BLOCK + x] = src - pred[y * BLOCK + x];
      }
    }
    return { ...cell, mode: LAB_MODE_INTER, refId: 0, hmvx, hmvy, residual };
  });

  // First raster motion block goes to tile index 1; tile 0 holds the rest.
  const firstMotion = curBlocks.find((b) => b.mode === LAB_MODE_INTER);
  const tileA = curBlocks.filter((b) => b !== firstMotion);
  const tileB = [firstMotion];

  const bytesRef = writeTile({
    width,
    height,
    tileIndex: 0,
    tileTotal: 3,
    blocks: refBlocks,
  });
  const bytesA = writeTile({ width, height, tileIndex: 1, tileTotal: 3, blocks: tileA });
  const bytesB = writeTile({ width, height, tileIndex: 2, tileTotal: 3, blocks: tileB });

  return {
    width,
    height,
    cols,
    rows,
    reference,
    refId: 0,
    tiles: [
      {
        tileIndex: 0,
        bytes: bytesRef,
        coords: refBlocks.map((b) => ({ bx: b.bx, by: b.by })),
      },
      {
        tileIndex: 1,
        bytes: bytesA,
        coords: tileA.map((b) => ({ bx: b.bx, by: b.by })),
      },
      {
        tileIndex: 2,
        bytes: bytesB,
        coords: tileB.map((b) => ({ bx: b.bx, by: b.by })),
      },
    ],
    firstMotionBlock: { bx: firstMotion.bx, by: firstMotion.by },
    intraBlock: { bx: curBlocks[intraIndex].bx, by: curBlocks[intraIndex].by },
    hmvx,
    hmvy,
  };
}

// -- aliased vectors --------------------------------------------------------
//
// Two candidate vectors produce byte-identical pixels for the current block:
// one fetches a flat occluder region from R0 (the correct reference), the
// other fetches a different flat region from R1. Both residuals are zero for
// the current frame. The NEXT frame is coded inter against the current
// reconstruction (id 2): the candidate that kept the R0 relation can derive
// it, while the R1 candidate has no legal chain to id 2 and its next-frame
// prediction leaves a non-zero residual — the drift surfaces one frame later.
export function buildAliasFixture(opts = {}) {
  const width = opts.width ?? 24;
  const height = opts.height ?? 24;
  const bx = opts.bx ?? 1;
  const by = opts.by ?? 1;
  const flat = opts.flat ?? 48;

  const texture = makeTexture(width, height, opts.seed ?? 37);
  const plane0 = texture.slice();
  const plane1 = texture.slice();

  // Each reference carries one flat region. They sit at different positions
  // (so the two tuples fetch genuinely different reference pixels) but are
  // painted with the same value, and each region is sized to cover the full
  // half-pel footprint of its candidate vector across the whole 8x8 block.
  const hmvx = -9; // -4.5 px
  const hmvy = 2; // +1.0 px
  const altHmvx = 5; // +2.5 px, same hmvy

  // Correct candidate footprint (R0): dest x in [8,15], ref x = dest-4.5 ->
  // [3.5,10.5] i.e. integer columns [3..11]; ref y = dest+1 -> [9..16].
  const region0 = { x: 3, y: 9, w: 9, h: 8 };
  // Broken candidate footprint (R1): ref x = dest+2.5 -> [10.5,17.5] i.e.
  // integer columns [10..18]; same y range.
  const region1 = { x: 10, y: 9, w: 9, h: 8 };
  paintRect(plane0, width, region0, flat);
  paintRect(plane1, width, region1, flat);
  const ref0 = frameFromPlane(width, height, plane0);
  const ref1 = frameFromPlane(width, height, plane1);

  const predA = new Int32Array(BLOCK * BLOCK);
  const predB = new Int32Array(BLOCK * BLOCK);
  buildSubpelBlock(ref0, bx, by, hmvx, hmvy, predA, false);
  buildSubpelBlock(ref1, bx, by, altHmvx, hmvy, predB, false);

  const currentPlane = new Uint8Array(width * height);
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      currentPlane[(by * BLOCK + y) * width + bx * BLOCK + x] = predA[y * BLOCK + x];
    }
  }
  const current = frameFromPlane(width, height, currentPlane);
  const currentBlock = new Int32Array(BLOCK * BLOCK);
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      currentBlock[y * BLOCK + x] =
        current.planes[0][(by * BLOCK + y) * width + bx * BLOCK + x];
    }
  }

  // Next frame: a small, known change inside the target block, predicted from
  // the current reconstruction (id 2). The legal chain is R0 -> id 2.
  const nextPlane = currentPlane.slice();
  const changeX = 3;
  const changeY = 4;
  const changeIndex = changeY * BLOCK + changeX;
  const oldValue = nextPlane[(by * BLOCK + changeY) * width + bx * BLOCK + changeX];
  const newValue = Math.max(0, Math.min(255, oldValue + 25));
  nextPlane[(by * BLOCK + changeY) * width + bx * BLOCK + changeX] = newValue;
  const nextFrame = frameFromPlane(width, height, nextPlane);

  const nextHmvx = 0;
  const nextHmvy = 0;
  const predFromCurrent = new Int32Array(BLOCK * BLOCK);
  buildSubpelBlock(current, bx, by, nextHmvx, nextHmvy, predFromCurrent, false);
  // A decoder that followed the R1 candidate never registered the current
  // reconstruction under the id its chain expects; if it instead predicts the
  // next frame from R1 directly, it lands on texture, not the flat block.
  const predFromR1 = new Int32Array(BLOCK * BLOCK);
  buildSubpelBlock(ref1, bx, by, nextHmvx, nextHmvy, predFromR1, false);

  return {
    width,
    height,
    bx,
    by,
    refs: new Map([
      [0, ref0],
      [1, ref1],
    ]),
    current,
    currentBlock,
    currentRefId: 2,
    candidates: [
      { name: 'correct-relation', refId: 0, hmvx, hmvy, prediction: predA },
      { name: 'broken-relation', refId: 1, hmvx: altHmvx, hmvy, prediction: predB },
    ],
    nextFrame,
    next: {
      refId: 2,
      hmvx: nextHmvx,
      hmvy: nextHmvy,
      predictionFromChain: predFromCurrent,
      predictionFromStaleR1: predFromR1,
      residualFromChain: blockResidual(nextFrame, bx, by, predFromCurrent),
      residualFromStaleR1: blockResidual(nextFrame, bx, by, predFromR1),
      firstChangedPixel: {
        index: changeIndex,
        x: changeX,
        y: changeY,
        oldValue,
        newValue,
      },
    },
    sameCurrentPixels: sseOf(predA, predB) === 0 && firstDiff(predA, predB) === null,
  };
}
