import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Frame, meanSquaredError } from '../src/core/image.js';
import { encodeVideo } from '../src/core/encoder.js';
import { decodeVideo } from '../src/core/decode.js';
import { parseHeader } from '../src/core/container.js';
import { generateSequence, attachFrameClass } from '../src/core/scenarios.js';

// End-to-end at the file level: write real bytes to disk, read them back in a
// fresh call, decode. This is what a third party would do, and it proves the
// format is a file format rather than an in-memory object graph.

test('a .bmpp file on disk decodes back to the encoder reconstruction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bmpp-'));
  try {
    const seq = attachFrameClass(
      generateSequence('pan', { width: 48, height: 32, frames: 4 }),
      Frame,
    );
    const enc = encodeVideo({ frames: seq.frames, qp: 26, radius: 8, strategy: 'diamond' });
    const path = join(dir, 'pan.bmpp');
    await writeFile(path, enc.bytes);

    const onDisk = new Uint8Array(await readFile(path));
    assert.deepEqual(Array.from(onDisk), Array.from(enc.bytes));
    assert.equal(onDisk[0], 0x42); // 'B'
    assert.equal(onDisk[1], 0x4d); // 'M'
    assert.equal(onDisk[2], 0x50); // 'P'
    assert.equal(onDisk[3], 0x50); // 'P'

    const header = parseHeader(onDisk);
    assert.equal(header.width, 48);
    assert.equal(header.height, 32);
    assert.equal(header.frameCount, 4);

    const dec = decodeVideo(onDisk);
    assert.equal(dec.frames.length, 4);
    for (let i = 0; i < 4; i++) {
      assert.equal(meanSquaredError(enc.perFrame[i].recon, dec.frames[i]).sse, 0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('header codec string is not a real standard codec name', () => {
  const seq = attachFrameClass(
    generateSequence('pan', { width: 16, height: 16, frames: 2 }),
    Frame,
  );
  const enc = encodeVideo({ frames: seq.frames, qp: 30, radius: 4, strategy: 'full' });
  const magic = String.fromCharCode(...enc.bytes.slice(0, 4));
  assert.equal(magic, 'BMPP');
  // Guard against someone later claiming this is a known standard: the magic
  // and the docs must not contain standard codec identifiers.
  for (const known of ['H264', 'HEVC', 'AVC1', 'AV01', 'VP09']) {
    assert.ok(!magic.includes(known));
  }
});
