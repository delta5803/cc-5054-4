// Prediction, transform and reconstruction primitives shared by encoder and
// decoder. These functions are the only place where a block's predicted
// samples and reconstructed samples are produced, so both sides are provably
// identical (same integer path, same clamp order).

import { BLOCK, BLOCK_PIXELS } from './constants.js';
import { fdct8x8, idct8x8, quantize, dequantize } from './transform.js';
import { clampIndex } from './image.js';

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// DC prediction from already-reconstructed neighbours of the *current* frame.
// Left column and top row of the block are averaged; unavailable borders are
// simply not counted. If neither exists (top-left block) the predictor is 128.
export function intraPredictor(recon, planeIndex, bx, by) {
  const { width } = recon;
  const plane = recon.planes[planeIndex];
  const x0 = bx * BLOCK;
  const y0 = by * BLOCK;
  let sum = 0;
  let count = 0;
  if (x0 > 0) {
    for (let y = 0; y < BLOCK; y++) sum += plane[(y0 + y) * width + (x0 - 1)];
    count += BLOCK;
  }
  if (y0 > 0) {
    for (let x = 0; x < BLOCK; x++) sum += plane[(y0 - 1) * width + x0 + x];
    count += BLOCK;
  }
  if (count === 0) return 128;
  return Math.round(sum / count);
}

export function buildPredictionBlock(recon, planeIndex, bx, by, mvx, mvy, out) {
  const { width, height } = recon;
  const plane = recon.planes[planeIndex];
  const x0 = bx * BLOCK;
  const y0 = by * BLOCK;
  for (let y = 0; y < BLOCK; y++) {
    const ry = clampIndex(y0 + y + mvy, height);
    for (let x = 0; x < BLOCK; x++) {
      const rx = clampIndex(x0 + x + mvx, width);
      out[y * BLOCK + x] = plane[ry * width + rx];
    }
  }
  return out;
}

export function buildIntraBlock(recon, planeIndex, bx, by, out) {
  const dc = intraPredictor(recon, planeIndex, bx, by);
  out.fill(dc);
  return out;
}

// residual = source - prediction, per component, block-sized.
export function residualFromPrediction(frame, planeIndex, bx, by, pred) {
  const { width } = frame;
  const plane = frame.planes[planeIndex];
  const x0 = bx * BLOCK;
  const y0 = by * BLOCK;
  const residual = new Int32Array(BLOCK_PIXELS);
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      residual[y * BLOCK + x] = plane[(y0 + y) * width + x0 + x] - pred[y * BLOCK + x];
    }
  }
  return residual;
}

const COEF = new Int32Array(BLOCK_PIXELS);
const RECO_RES = new Int32Array(BLOCK_PIXELS);

export function transformAndQuantize(residual, qp) {
  fdct8x8(residual, BLOCK, 0, COEF);
  const levels = new Int32Array(BLOCK_PIXELS);
  quantize(COEF, qp, levels);
  // A fresh array per block: callers keep these references for the bitstream,
  // the reconstruction and UI display, so a shared scratch buffer would alias.
  return levels;
}

// Reconstruct a block into `recon` from its quantised levels and prediction.
export function reconstructBlock(recon, planeIndex, bx, by, pred, levels, qp) {
  dequantize(levels, qp, COEF);
  idct8x8(COEF, RECO_RES, BLOCK, 0);
  const { width } = recon;
  const plane = recon.planes[planeIndex];
  const x0 = bx * BLOCK;
  const y0 = by * BLOCK;
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      const v = pred[y * BLOCK + x] + RECO_RES[y * BLOCK + x];
      plane[(y0 + y) * width + x0 + x] = clamp8(v);
    }
  }
}

// SSD between reconstructed block and source, used for mode/vector decisions.
// `recon` is accepted for call-site symmetry but only `frame` and `pred` are
// read; the reconstruction is computed locally from `levels`.
export function blockSSD(frame, _recon, planeIndex, bx, by, pred, levels, qp) {
  dequantize(levels, qp, COEF);
  idct8x8(COEF, RECO_RES, BLOCK, 0);
  const { width } = frame;
  const src = frame.planes[planeIndex];
  const x0 = bx * BLOCK;
  const y0 = by * BLOCK;
  let ssd = 0;
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      const v = clamp8(pred[y * BLOCK + x] + RECO_RES[y * BLOCK + x]);
      const d = src[(y0 + y) * width + x0 + x] - v;
      ssd += d * d;
    }
  }
  return ssd;
}

export { clamp8 };
