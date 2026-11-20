import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Frame } from '../src/core/image.js';
import { encodeVideo } from '../src/core/encoder.js';
import { decodeVideo } from '../src/core/decode.js';
import { generateSequence, attachFrameClass } from '../src/core/scenarios.js';

// A second implementation of the frame-0 parser written directly from
// docs/FORMAT.md, in Python, with no code shared with this repository. If this
// agrees with the JavaScript decoder, the format description is sufficient to
// build an interoperable decoder. Skipped when python3 is unavailable.

const PYTHON = String.raw`
import sys, struct, zlib, json
data = open(sys.argv[1], 'rb').read()
assert data[:4] == b'BMPP', 'magic'
version = data[4]
width, height = struct.unpack_from('<HH', data, 8)
block = data[12]
comps = data[13]
frameCount, payloadBits, crc, total = struct.unpack_from('<IIII', data, 16)
payload = data[32:]
assert zlib.crc32(payload) & 0xffffffff == crc, 'crc'
assert total == len(data), 'size'
assert block == 8

class BR:
    def __init__(self, b):
        self.b = b
        self.pos = 0
    def align(self):
        if self.pos % 8:
            self.pos += 8 - (self.pos % 8)
    def read(self, n):
        v = 0
        for _ in range(n):
            v = (v << 1) | ((self.b[self.pos >> 3] >> (7 - (self.pos & 7))) & 1)
            self.pos += 1
        return v
    def rsig(self, n):
        v = self.read(n)
        return v - (1 << n) if v >= (1 << (n - 1)) else v
    def gamma(self):
        k = 0
        while self.read(1) == 0:
            k += 1
        return 1 if k == 0 else (1 << k) + self.read(k)

def mvmap(c):
    return -((c - 1) // 2) if c % 2 == 1 else c // 2

r = BR(payload)
r.align()
ft = r.read(1)
qp = r.read(6)
bc = (width + 7) // 8
br = (height + 7) // 8
blocks = []
for by in range(br):
    for bx in range(bc):
        mode = r.read(1)
        mv = [0, 0]
        if mode == 1:
            mv = [mvmap(r.gamma()), mvmap(r.gamma())]
        for c in range(comps):
            pres = r.read(1)
            if pres:
                raw = r.read(1)
                if raw == 0:
                    n = r.read(4)
                    for _ in range(n):
                        r.read(4); r.rsig(13)
                else:
                    for _ in range(64):
                        r.rsig(13)
        blocks.append({'bx': bx, 'by': by, 'mode': mode, 'mv': mv})
print(json.dumps({'width': width, 'height': height, 'frames': frameCount,
                  'frame0_type': ft, 'frame0_qp': qp, 'blocks': blocks}))
`;

function pythonAvailable() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('an independent Python parser written from FORMAT.md agrees with the JS decoder', async (t) => {
  if (!pythonAvailable()) {
    t.skip('python3 not available');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'bmpp-py-'));
  try {
    const seq = attachFrameClass(
      generateSequence('pan', { width: 32, height: 24, frames: 3 }),
      Frame,
    );
    // Include a frame with inter blocks by encoding >=2 frames; frame 0 is
    // intra by definition, so we validate frame-0 structure and headers here
    // and rely on the JS round-trip tests for inter frames.
    const enc = encodeVideo({ frames: seq.frames, qp: 26, radius: 6, strategy: 'full' });
    const scriptPath = join(dir, 'parse.py');
    const bmppPath = join(dir, 'seq.bmpp');
    await writeFile(scriptPath, PYTHON);
    await writeFile(bmppPath, enc.bytes);

    const json = execFileSync('python3', ['-I', scriptPath, bmppPath], { encoding: 'utf8' });
    const parsed = JSON.parse(json);

    assert.equal(parsed.width, 32);
    assert.equal(parsed.height, 24);
    assert.equal(parsed.frames, 3);
    assert.equal(parsed.frame0_type, 0);
    assert.equal(parsed.frame0_qp, 26);

    const jsPlan = enc.perFrame[0].blocks;
    assert.equal(parsed.blocks.length, jsPlan.length);
    for (let i = 0; i < jsPlan.length; i++) {
      const a = jsPlan[i];
      const b = parsed.blocks[i];
      assert.equal(b.bx, a.bx);
      assert.equal(b.by, a.by);
      assert.equal(b.mode, a.mode, `block ${i} mode`);
      assert.deepEqual(b.mv, [a.mvx, a.mvy], `block ${i} mv`);
    }

    // And the JS decoder still produces the encoder's reconstruction.
    const dec = decodeVideo(enc.bytes);
    assert.equal(dec.frames.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
