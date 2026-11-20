// Frame representation.
//
// A frame is stored as one plane per component (1 = luma only, 3 = R, G, B).
// There is deliberately no colour-space transform: BMPP-1 codes the planes it
// is given, so an RGB source round-trips as the same RGB values. Motion
// estimation only ever looks at plane 0, but distortion and coding cover all
// planes.

import { BLOCK } from './constants.js';
import { FormatError } from './bitstream.js';

export class Frame {
  constructor(width, height, components, fill = 0) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError('invalid frame dimensions');
    }
    if (components !== 1 && components !== 3) {
      throw new RangeError('components must be 1 or 3');
    }
    this.width = width;
    this.height = height;
    this.components = components;
    this.blockCols = Math.ceil(width / BLOCK);
    this.blockRows = Math.ceil(height / BLOCK);
    this.planes = Array.from({ length: components }, () => new Uint8Array(width * height));
    if (fill !== 0) this.planes.forEach((p) => p.fill(fill));
  }

  static fromRGBA(rgba, width, height, components = 3) {
    const frame = new Frame(width, height, components);
    if (rgba.length < width * height * 4) throw new RangeError('RGBA buffer too small');
    for (let i = 0, p = 0; i < width * height; i++, p += 4) {
      frame.planes[0][i] = rgba[p];
      if (components === 3) {
        frame.planes[1][i] = rgba[p + 1];
        frame.planes[2][i] = rgba[p + 2];
      }
    }
    return frame;
  }

  static fromGray(gray, width, height) {
    if (gray.length < width * height) throw new RangeError('gray buffer too small');
    const frame = new Frame(width, height, 1);
    frame.planes[0].set(gray.subarray(0, width * height));
    return frame;
  }

  static fromRGB(rgb, width, height) {
    if (rgb.length < width * height * 3) throw new RangeError('RGB buffer too small');
    const frame = new Frame(width, height, 3);
    for (let i = 0, p = 0; i < width * height; i++, p += 3) {
      frame.planes[0][i] = rgb[p];
      frame.planes[1][i] = rgb[p + 1];
      frame.planes[2][i] = rgb[p + 2];
    }
    return frame;
  }

  clone() {
    const copy = new Frame(this.width, this.height, this.components);
    for (let c = 0; c < this.components; c++) copy.planes[c].set(this.planes[c]);
    return copy;
  }

  toRGBAData(target) {
    const out = target || new Uint8ClampedArray(this.width * this.height * 4);
    const { width, height } = this;
    const lum = this.planes[0];
    const u = this.components === 3 ? this.planes[1] : null;
    const v = this.components === 3 ? this.planes[2] : null;
    for (let i = 0, p = 0; i < width * height; i++, p += 4) {
      if (u) {
        out[p] = lum[i];
        out[p + 1] = u[i];
        out[p + 2] = v[i];
      } else {
        out[p] = out[p + 1] = out[p + 2] = lum[i];
      }
      out[p + 3] = 255;
    }
    return out;
  }

  grayPlane() {
    return this.planes[0];
  }
}

// Edge replication is the defined behaviour for any reference fetch outside
// the reference picture (used when a motion vector points past the border).
export function clampIndex(value, limit) {
  if (value < 0) return 0;
  if (value >= limit) return limit - 1;
  return value;
}

export function fetchRef(plane, width, height, x, y) {
  return plane[clampIndex(y, height) * width + clampIndex(x, width)];
}

// SAD over luma, restricted to destination pixels inside the picture. This is
// the cheap phase of motion search; it never touches out-of-frame source
// pixels, which do not exist.
export function blockSAD(source, ref, bx, by, mvx, mvy) {
  const { width, height } = source;
  const src = source.planes[0];
  const refPlane = ref.planes[0];
  const x0 = bx * BLOCK;
  const y0 = by * BLOCK;
  let sad = 0;
  const maxY = Math.min(BLOCK, height - y0);
  const maxX = Math.min(BLOCK, width - x0);
  for (let yy = 0; yy < maxY; yy++) {
    const sy = y0 + yy;
    const ry = sy + mvy;
    const rowBase = sy * width;
    const refRow = clampIndex(ry, height) * width;
    for (let xx = 0; xx < maxX; xx++) {
      const sx = x0 + xx;
      const rx = clampIndex(sx + mvx, width);
      sad += Math.abs(src[rowBase + sx] - refPlane[refRow + rx]);
    }
  }
  return sad;
}

export function meanSquaredError(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.components !== b.components) {
    throw new FormatError('cannot compare frames with different geometry');
  }
  let sum = 0;
  let count = 0;
  for (let c = 0; c < a.components; c++) {
    const pa = a.planes[c];
    const pb = b.planes[c];
    for (let i = 0; i < pa.length; i++) {
      const d = pa[i] - pb[i];
      sum += d * d;
    }
    count += pa.length;
  }
  return { sse: sum, mse: sum / count, count };
}

export function psnr(a, b) {
  const { mse } = meanSquaredError(a, b);
  if (mse === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / mse);
}

export function blockResidualEnergy(frame, bx, by) {
  const { width, height } = frame;
  const x0 = bx * BLOCK;
  const y0 = by * BLOCK;
  const maxY = Math.min(BLOCK, height - y0);
  const maxX = Math.min(BLOCK, width - x0);
  let energy = 0;
  let maxAbs = 0;
  let count = 0;
  for (let c = 0; c < frame.components; c++) {
    const plane = frame.planes[c];
    for (let yy = 0; yy < maxY; yy++) {
      for (let xx = 0; xx < maxX; xx++) {
        const v = plane[(y0 + yy) * width + x0 + xx];
        energy += v * v;
        maxAbs = Math.max(maxAbs, v);
        count += 1;
      }
    }
  }
  return { energy, maxAbs, count };
}
