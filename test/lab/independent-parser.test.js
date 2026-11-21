import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeTile, parseTile, LAB_MODE_INTRA } from '../../src/lab/tile.js';

// A second implementation of the BMPT tile parser written directly from
// docs/LAB.md, in Python, with no code shared with this repository. It only
// validates the lab tile format — it never imports a JS module. Skipped when
// python3 is unavailable.

const PYTHON = String.raw`
import sys, struct, json

data = open(sys.argv[1], 'rb').read()
assert data[:4] == b'BMPT', 'magic'
width, height = struct.unpack_from('<HH', data, 4)
block = data[8]
tileIndex = data[9]
tileTotal = data[10]
blockCount = data[11]
payloadBits = struct.unpack_from('<I', data, 12)[0]
assert block == 8
assert 16 + (payloadBits + 7) // 8 == len(data), 'payload length'

class BR:
    def __init__(self, b, base):
        self.b = b
        self.pos = base * 8
    def read(self, n):
        v = 0
        for _ in range(n):
            v = (v << 1) | ((self.b[self.pos >> 3] >> (7 - (self.pos & 7))) & 1)
            self.pos += 1
        return v
    def gamma(self):
        k = 0
        while self.read(1) == 0:
            k += 1
        return 1 if k == 0 else (1 << k) + self.read(k)

def unmap(c):
    if c == 1:
        return 0
    return -((c - 1) // 2) if c % 2 == 1 else c // 2

r = BR(data, 16)
blocks = []
for _ in range(blockCount):
    mode = r.read(1)
    rec = {'mode': mode, 'refId': None, 'hmvx': 0, 'hmvy': 0, 'residual': []}
    if mode == 1:
        rec['refId'] = r.gamma() - 1
        rec['hmvx'] = unmap(r.gamma())
        rec['hmvy'] = unmap(r.gamma())
    for _ in range(64):
        raw = r.read(8)
        rec['residual'].append(raw - 256 if raw >= 128 else raw)
    blocks.append(rec)

print(json.dumps({
    'width': width, 'height': height, 'tileIndex': tileIndex,
    'tileTotal': tileTotal, 'blockCount': blockCount, 'blocks': blocks,
}))
`;

function pythonAvailable() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('independent Python parser agrees with the JS tile syntax parser', async (t) => {
  if (!pythonAvailable()) {
    t.skip('python3 not available');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'bmpt-py-'));
  try {
    const residualA = new Int32Array(64).fill(11);
    const residualB = new Int32Array(64);
    residualB[0] = -7;
    residualB[63] = 9;
    const blocks = [
      { bx: 0, by: 0, mode: LAB_MODE_INTRA, residual: residualA },
      { bx: 1, by: 0, mode: 1, refId: 5, hmvx: -7, hmvy: 3, residual: residualB },
    ];
    const bytes = writeTile({ width: 16, height: 8, tileIndex: 2, tileTotal: 4, blocks });

    const scriptPath = join(dir, 'parse_tile.py');
    const tilePath = join(dir, 'tile.bmpt');
    await writeFile(scriptPath, PYTHON);
    await writeFile(tilePath, bytes);

    const parsed = JSON.parse(execFileSync('python3', ['-I', scriptPath, tilePath], { encoding: 'utf8' }));
    const js = parseTile(bytes);

    assert.equal(parsed.width, 16);
    assert.equal(parsed.height, 8);
    assert.equal(parsed.tileIndex, 2);
    assert.equal(parsed.tileTotal, 4);
    assert.equal(parsed.blockCount, 2);
    for (let i = 0; i < 2; i++) {
      assert.equal(parsed.blocks[i].mode, js.blocks[i].mode);
      assert.equal(parsed.blocks[i].refId, js.blocks[i].refId);
      assert.equal(parsed.blocks[i].hmvx, js.blocks[i].hmvx);
      assert.equal(parsed.blocks[i].hmvy, js.blocks[i].hmvy);
      assert.deepEqual(parsed.blocks[i].residual, Array.from(js.blocks[i].residual));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
