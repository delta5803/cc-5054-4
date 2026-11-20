// Coefficient entropy coding for a single 8x8 quantised block.
//
// Two forms, chosen per block by the encoder and signalled with one bit:
//
//   compact (0): a 4-bit count N <= 15 followed by N (run, level) pairs,
//                run in 4 bits, level as signed 12 bits. A pair list is only
//                used when it describes every non-zero coefficient, so the
//                coefficient array can be rebuilt exactly.
//   raw     (1): all 64 levels as signed 12 bits in zig-zag order.
//
// The raw form is a deliberate escape hatch for blocks with more than 15
// non-zero coefficients or a zero-run longer than 15; it is not a fallback
// that hides encoder bugs, because both forms are decoded by the same code.

import {
  BLOCK_PIXELS,
  ZIGZAG,
  MAX_COEF_PAIRS,
  COEF_ZERO_RUN_BITS,
  COEF_MAG_BITS,
} from './constants.js';

import { FormatError } from './bitstream.js';

const LEVEL_MIN = -(2 ** (COEF_MAG_BITS - 1));
const LEVEL_MAX = 2 ** (COEF_MAG_BITS - 1) - 1;

export function clampLevel(value) {
  if (value < LEVEL_MIN) return LEVEL_MIN;
  if (value > LEVEL_MAX) return LEVEL_MAX;
  return value;
}

export function clampLevelArray(levels) {
  for (let i = 0; i < BLOCK_PIXELS; i++) levels[i] = clampLevel(levels[i]);
  return levels;
}

function collectPairs(levels) {
  const pairs = [];
  let run = 0;
  let nonZero = 0;
  let compact = true;
  for (let i = 0; i < BLOCK_PIXELS; i++) {
    const value = levels[ZIGZAG[i]];
    if (value === 0) {
      run += 1;
      continue;
    }
    nonZero += 1;
    if (run > (1 << COEF_ZERO_RUN_BITS) - 1 || nonZero > MAX_COEF_PAIRS) {
      compact = false;
      break;
    }
    pairs.push([run, value]);
    run = 0;
  }
  // A list that is complete by construction: pairs plus the final run reach
  // exactly the end of the block, so no end-of-block marker is needed.
  return { compact, pairs };
}

export function writeCoeffBlock(writer, levels) {
  const { compact, pairs } = collectPairs(levels);
  writer.write(compact ? 0 : 1, 1);
  if (compact) {
    writer.write(pairs.length, 4);
    for (const [run, level] of pairs) {
      writer.write(run, COEF_ZERO_RUN_BITS);
      writer.writeSigned(level, COEF_MAG_BITS);
    }
  } else {
    for (let i = 0; i < BLOCK_PIXELS; i++) {
      writer.writeSigned(clampLevel(levels[ZIGZAG[i]]), COEF_MAG_BITS);
    }
  }
}

export function readCoeffBlock(reader, out) {
  const raw = reader.read(1);
  out.fill(0);
  if (raw === 0) {
    const count = reader.read(4);
    let index = 0;
    for (let i = 0; i < count; i++) {
      const run = reader.read(COEF_ZERO_RUN_BITS);
      const level = reader.readSigned(COEF_MAG_BITS);
      index += run;
      if (index >= BLOCK_PIXELS) {
        throw new FormatError('coefficient run exceeds block');
      }
      out[ZIGZAG[index]] = level;
      index += 1;
    }
    if (index > BLOCK_PIXELS) {
      throw new FormatError('coefficient list overruns block');
    }
  } else {
    for (let i = 0; i < BLOCK_PIXELS; i++) {
      out[ZIGZAG[i]] = reader.readSigned(COEF_MAG_BITS);
    }
  }
  return out;
}

// Convenience: exact bit count of writeCoeffBlock without materialising bytes.
// BitCounter implements the same writer API.
export class BitCounter {
  constructor() {
    this.length = 0;
  }
  write(value, bits) {
    if (!Number.isInteger(bits) || bits < 0) throw new RangeError('invalid bit count');
    if (value < 0 || value >= 2 ** bits) throw new RangeError('value does not fit');
    this.length += bits;
  }
  writeSigned(value, bits) {
    const half = 2 ** (bits - 1);
    if (value < -half || value >= half) throw new RangeError('value does not fit signed');
    this.length += bits;
  }
}

export function coeffBlockBits(levels) {
  const counter = new BitCounter();
  writeCoeffBlock(counter, levels);
  return counter.length;
}

export { FormatError };
