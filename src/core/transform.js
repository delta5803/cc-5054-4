// Integer forward/inverse DCT for 8x8 residual blocks.
//
// This is a plain DCT-II / DCT-III pair with an explicit integer basis and a
// 1/256^2 scale. It is intentionally not the AAN or integer-lifting transform
// used by any published video standard; the only requirement is that the
// encoder and the decoder in this repository agree exactly, which they do
// because both sides call these same functions.

import { BLOCK, BLOCK_PIXELS, QSTEP, DEADZONE_DIVISOR } from './constants.js';

const SCALE = 256;
const SCALE_SQ = SCALE * SCALE;

// basis[u][x] = round(256 * c(u) * cos((2x+1)u*pi/16))
const BASIS = [
  [91, 91, 91, 91, 91, 91, 91, 91],
  [126, 106, 71, 25, -25, -71, -106, -126],
  [118, 49, -49, -118, -118, -49, 49, 118],
  [106, -25, -126, -71, 71, 126, 25, -106],
  [91, -91, -91, 91, 91, -91, -91, 91],
  [71, -126, 25, 106, -106, -25, 126, -71],
  [49, -118, 118, -49, -49, 118, -118, 49],
  [25, -71, 106, -126, 126, -106, 71, -25],
];

// Scratch buffers: every call is synchronous and single-threaded in both the
// browser and Node, so reuse is safe and avoids 64-element allocations per
// block in the rate-distortion inner loop.
const tmpF = new Int32Array(BLOCK_PIXELS);
const tmpI = new Int32Array(BLOCK_PIXELS);

function divRound(value, divisor) {
  // Round-half-away-from-zero; Math.round alone rounds -0.5 toward +inf.
  return value >= 0
    ? Math.floor((value + divisor / 2) / divisor)
    : -Math.floor((-value + divisor / 2) / divisor);
}

export function fdct8x8(src, srcStride, srcOffset, out) {
  for (let u = 0; u < BLOCK; u++) {
    const row = BASIS[u];
    for (let x = 0; x < BLOCK; x++) {
      let sum = 0;
      for (let y = 0; y < BLOCK; y++) {
        sum += row[y] * src[srcOffset + y * srcStride + x];
      }
      tmpF[u * BLOCK + x] = sum;
    }
  }
  for (let u = 0; u < BLOCK; u++) {
    for (let v = 0; v < BLOCK; v++) {
      let sum = 0;
      for (let x = 0; x < BLOCK; x++) {
        sum += tmpF[u * BLOCK + x] * BASIS[v][x];
      }
      out[u * BLOCK + v] = divRound(sum, SCALE_SQ);
    }
  }
  return out;
}

export function idct8x8(coef, out, outStride, outOffset) {
  for (let a = 0; a < BLOCK; a++) {
    for (let x = 0; x < BLOCK; x++) {
      let sum = 0;
      for (let u = 0; u < BLOCK; u++) {
        sum += BASIS[u][a] * coef[u * BLOCK + x];
      }
      tmpI[a * BLOCK + x] = sum;
    }
  }
  for (let a = 0; a < BLOCK; a++) {
    for (let b = 0; b < BLOCK; b++) {
      let sum = 0;
      for (let x = 0; x < BLOCK; x++) {
        sum += tmpI[a * BLOCK + x] * BASIS[x][b];
      }
      out[outOffset + a * outStride + b] = divRound(sum, SCALE_SQ);
    }
  }
  return out;
}

export function quantize(coef, qp, out) {
  const step = QSTEP[qp];
  const dead = Math.floor(step / DEADZONE_DIVISOR);
  for (let i = 0; i < BLOCK_PIXELS; i++) {
    const c = coef[i];
    const magnitude = Math.abs(c);
    if (magnitude < step - dead) {
      out[i] = 0;
    } else {
      const q = Math.floor((magnitude + dead) / step);
      out[i] = c < 0 ? -q : q;
    }
  }
  return out;
}

export function dequantize(levels, qp, out) {
  const step = QSTEP[qp];
  for (let i = 0; i < BLOCK_PIXELS; i++) out[i] = levels[i] * step;
  return out;
}
