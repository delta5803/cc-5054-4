import test from 'node:test';
import assert from 'node:assert/strict';

import { BitWriter, BitReader, writeGamma, readGamma, gammaBits } from '../src/core/bitstream.js';
import {
  writeCoeffBlock,
  readCoeffBlock,
  coeffBlockBits,
  clampLevelArray,
} from '../src/core/coeff.js';
import { writeMV, readMV, mvBits, mvComponentBits } from '../src/core/mvcode.js';
import { ZIGZAG, BLOCK_PIXELS } from '../src/core/constants.js';

test('gamma round-trips and is prefix free for magnitudes', () => {
  for (let n = 1; n <= 511; n++) {
    const w = new BitWriter();
    writeGamma(w, n);
    assert.equal(w.length, gammaBits(n), `bit length for ${n}`);
    w.alignToByte();
    const r = new BitReader(w.toUint8Array(), 0);
    assert.equal(readGamma(r), n);
  }
});

test('gamma rejects zero and out-of-range', () => {
  assert.throws(() => gammaBits(0), RangeError);
  const w = new BitWriter();
  assert.throws(() => writeGamma(w, 0), RangeError);
  assert.throws(() => writeGamma(w, 2 ** 14), RangeError);
});

test('motion vector coding is exact and cheaper for small vectors', () => {
  let prev = 0;
  for (let v = 0; v <= 64; v++) {
    const bits = mvComponentBits(v);
    assert.ok(bits >= prev, 'bit cost must be non-decreasing with magnitude');
    prev = bits;
  }
  assert.ok(mvBits(0, 0) < mvBits(40, -40), 'small vectors must cost fewer bits');

  for (const [x, y] of [[0, 0], [1, -1], [-5, 7], [255, -255], [-255, 255], [3, 0]]) {
    const w = new BitWriter();
    writeMV(w, x, y);
    assert.equal(w.length, mvBits(x, y));
    w.alignToByte();
    const r = new BitReader(w.toUint8Array(), 0);
    assert.deepEqual(readMV(r), { mvx: x, mvy: y });
  }
});

test('coefficient blocks round-trip in compact and raw forms', () => {
  const sparse = new Int32Array(BLOCK_PIXELS);
  sparse[ZIGZAG[0]] = 5;
  sparse[ZIGZAG[3]] = -2;
  sparse[ZIGZAG[10]] = 1;

  const dense = new Int32Array(BLOCK_PIXELS);
  for (let i = 0; i < BLOCK_PIXELS; i++) dense[i] = ((i * 7) % 9) - 4; // many non-zeros

  const extreme = new Int32Array(BLOCK_PIXELS);
  extreme[0] = 4095;
  extreme[1] = -4096;
  clampLevelArray(extreme);

  for (const source of [sparse, dense, extreme, new Int32Array(BLOCK_PIXELS)]) {
    const w = new BitWriter();
    writeCoeffBlock(w, source);
    assert.equal(w.length, coeffBlockBits(source));
    w.alignToByte();
    const decoded = new Int32Array(BLOCK_PIXELS);
    readCoeffBlock(new BitReader(w.toUint8Array(), 0), decoded);
    assert.deepEqual(Array.from(decoded), Array.from(source));
  }
});

test('coefficient coding rejects a run that overruns the block', () => {
  // hand-build a compact block with count=2, first (run 15, level 1),
  // second (run 15, level 1): 15+1+15+1 = 32 <= 64, so instead push the run
  // past the end with run 15 twice plus a third pair that cannot fit.
  const w = new BitWriter();
  w.write(0, 1); // compact
  w.write(4, 4); // four pairs
  for (let i = 0; i < 3; i++) {
    w.write(15, 4);
    w.writeSigned(1, 13);
  }
  // three pairs consume 48 entries; a fourth run of 15 would reach 63 then +1
  // = 64 which is exactly the end (index 63 valid). Use run 15 once more but
  // then one extra pair to overflow.
  w.write(15, 4);
  w.writeSigned(1, 13);
  w.alignToByte();
  const decoded = new Int32Array(BLOCK_PIXELS);
  // 4 pairs: indices after each are 16,32,48,64 -> the fourth lands at 63, ok.
  assert.doesNotThrow(() => readCoeffBlock(new BitReader(w.toUint8Array(), 0), decoded));

  const bad = new BitWriter();
  bad.write(0, 1);
  bad.write(5, 4);
  for (let i = 0; i < 5; i++) {
    bad.write(15, 4);
    bad.writeSigned(1, 13);
  }
  bad.alignToByte();
  assert.throws(
    () => readCoeffBlock(new BitReader(bad.toUint8Array(), 0), new Int32Array(BLOCK_PIXELS)),
    /exceeds block/,
  );
});
