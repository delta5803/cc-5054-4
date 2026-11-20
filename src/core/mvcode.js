// Motion vector signalling.
//
// Each component is mapped to a positive integer and Elias-gamma coded, so a
// magnitude of 1 costs 3 bits while a magnitude near 40 costs 11 bits. That
// makes small displacements genuinely cheaper, which is what lets the
// rate-distortion comparison in the estimator prefer them. The bit cost is
// computed with the same functions that write the stream, so the estimator
// prices vectors exactly.

import { MV_MIN, MV_MAX } from './constants.js';
import { writeGamma, readGamma, gammaBits } from './bitstream.js';

// zig-zag style magnitude mapping: 0 -> 1, -1 -> 2, +1 -> 3, -2 -> 4, ...
export function encodeMagnitude(value) {
  return value <= 0 ? -2 * value + 1 : 2 * value;
}

export function decodeMagnitude(code) {
  if (code === 1) return 0;
  if (code % 2 === 1) return -((code - 1) / 2);
  return code / 2;
}

export function clampMV(value) {
  if (value < MV_MIN) return MV_MIN;
  if (value > MV_MAX) return MV_MAX;
  // Normalise signed zero so serialised/reported vectors are canonical.
  return value === 0 ? 0 : value;
}

export function mvComponentBits(value) {
  return gammaBits(encodeMagnitude(value));
}

export function mvBits(mvx, mvy) {
  return mvComponentBits(mvx) + mvComponentBits(mvy);
}

export function writeMV(writer, mvx, mvy) {
  if (mvx < MV_MIN || mvx > MV_MAX || mvy < MV_MIN || mvy > MV_MAX) {
    throw new RangeError('motion vector outside profile range');
  }
  writeGamma(writer, encodeMagnitude(mvx));
  writeGamma(writer, encodeMagnitude(mvy));
}

export function readMV(reader) {
  const mvx = decodeMagnitude(readGamma(reader));
  const mvy = decodeMagnitude(readGamma(reader));
  if (mvx < MV_MIN || mvx > MV_MAX || mvy < MV_MIN || mvy > MV_MAX) {
    throw new RangeError('decoded motion vector outside profile range');
  }
  return { mvx, mvy };
}
