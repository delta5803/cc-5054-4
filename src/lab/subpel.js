// Half-pixel interpolation for the fault-injection lab.
//
// The BMPP-1 core codec (src/core) is deliberately integer-pel only; this
// module lives entirely under src/lab and is never imported by the normative
// encoder/decoder. It gives the lab a deterministic sub-pixel predictor so the
// tests can construct a *real* interpolation fault (premature rounding) rather
// than a made-up pixel diff.
//
// Coordinates are expressed in half-pixel units: a displacement of hx=3, hy=0
// means 1.5 pixels. The correct predictor is bilinear with a single rounding at
// the very end (round-half-up). The faulty predictor rounds each axis early,
// which only diverges when both axes carry a fractional part, i.e. the vector
// has odd hx AND odd hy.

import { BLOCK } from '../core/constants.js';
import { clampIndex } from '../core/image.js';

const roundHalfUp = (v) => (v >= 0 ? Math.floor(v + 0.5) : -Math.floor(-v + 0.5));

// One interpolated sample. hx/hy are the destination pixel's reference
// position in half-pixel units, so fx = hx & 1 is the horizontal fraction.
export function interpolatePixel(plane, width, height, hx, hy) {
  const x0 = hx >> 1;
  const y0 = hy >> 1;
  const fx = hx & 1;
  const fy = hy & 1;
  if (fx === 0 && fy === 0) {
    return plane[clampIndex(y0, height) * width + clampIndex(x0, width)];
  }
  const x1 = clampIndex(x0 + 1, width);
  const y1 = clampIndex(y0 + 1, height);
  const cx = clampIndex(x0, width);
  const cy = clampIndex(y0, height);
  const p00 = plane[cy * width + cx];
  const p10 = plane[cy * width + x1];
  const p01 = plane[y1 * width + cx];
  const p11 = plane[y1 * width + x1];
  // One division/rounding at the end: numerator in [0, 1020].
  const top = p00 * (2 - fx) * (2 - fy);
  const horizontal = p10 * fx * (2 - fy);
  const vertical = p01 * (2 - fx) * fy;
  const diagonal = p11 * fx * fy;
  return clamp8(roundHalfUp((top + horizontal + vertical + diagonal) / 4));
}

// The fault: each axis is rounded before it is combined. On the integer axis
// this is a no-op, so damage only appears for diagonally fractional vectors.
export function interpolatePixelEarly(plane, width, height, hx, hy) {
  const x0 = hx >> 1;
  const y0 = hy >> 1;
  const fx = hx & 1;
  const fy = hy & 1;
  if (fx === 0 && fy === 0) {
    return plane[clampIndex(y0, height) * width + clampIndex(x0, width)];
  }
  const x1 = clampIndex(x0 + 1, width);
  const y1 = clampIndex(y0 + 1, height);
  const cx = clampIndex(x0, width);
  const cy = clampIndex(y0, height);
  const p00 = plane[cy * width + cx];
  const p10 = plane[cy * width + x1];
  const p01 = plane[y1 * width + cx];
  const p11 = plane[y1 * width + x1];
  const rowA = roundHalfUp((p00 * (2 - fx) + p10 * fx) / 2);
  const rowB = roundHalfUp((p01 * (2 - fx) + p11 * fx) / 2);
  return clamp8(roundHalfUp((rowA * (2 - fy) + rowB * fy) / 2));
}

// Build an 8x8 prediction block. hmvx/hmvy are motion vectors in HALF-pixel
// units (3 = 1.5 px); the destination pixel's reference position is its own
// coordinate plus the vector, all scaled by 2 for the interpolator.
export function buildSubpelBlock(frame, bx, by, hmvx, hmvy, out, early = false) {
  const { width, height } = frame;
  const plane = frame.planes[0];
  const x0 = bx * BLOCK;
  const y0 = by * BLOCK;
  const maxY = Math.min(BLOCK, height - y0);
  const maxX = Math.min(BLOCK, width - x0);
  const pick = early ? interpolatePixelEarly : interpolatePixel;
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      if (y >= maxY || x >= maxX) {
        out[y * BLOCK + x] = 0;
        continue;
      }
      out[y * BLOCK + x] = pick(
        plane,
        width,
        height,
        2 * (x0 + x) + hmvx,
        2 * (y0 + y) + hmvy,
      );
    }
  }
  return out;
}

// Residual against an arbitrary 8x8 prediction, raster order, component 0.
export function blockResidual(frame, bx, by, pred) {
  const { width } = frame;
  const plane = frame.planes[0];
  const x0 = bx * BLOCK;
  const y0 = by * BLOCK;
  const residual = new Int32Array(BLOCK * BLOCK);
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      residual[y * BLOCK + x] = plane[(y0 + y) * width + x0 + x] - pred[y * BLOCK + x];
    }
  }
  return residual;
}

export function sseOf(a, b) {
  let sse = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sse += d * d;
  }
  return sse;
}

export function sadOf(a, b) {
  let sad = 0;
  for (let i = 0; i < a.length; i++) sad += Math.abs(a[i] - b[i]);
  return sad;
}

// First raster position where two 8x8 buffers differ, or null.
export function firstDiff(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return { index: i, x: i % BLOCK, y: Math.floor(i / BLOCK), a: a[i], b: b[i] };
  }
  return null;
}

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

export { roundHalfUp, clamp8 };
