import test from 'node:test';
import assert from 'node:assert/strict';

import { Frame } from '../../src/core/image.js';
import { ReferenceStore } from '../../src/lab/refstore.js';
import {
  writeTile,
  parseTile,
  decodeTile,
  resumeBlock,
  resumeAll,
  LAB_MODE_INTRA,
  LAB_INTRA_DC,
  TILE_MAGIC,
  TILE_HEADER_SIZE,
} from '../../src/lab/tile.js';
import { TileAssembler } from '../../src/lab/assembler.js';
import { buildSplitTileFixture } from '../../src/lab/fixture.js';

function makeResidual(fill) {
  const residual = new Int32Array(64);
  residual.fill(fill);
  return residual;
}

test('tile syntax round-trips mode, refId, half-pel vector and residual', () => {
  const blocks = [
    { bx: 0, by: 0, mode: LAB_MODE_INTRA, residual: makeResidual(5) },
    { bx: 1, by: 0, mode: 1, refId: 3, hmvx: -7, hmvy: 5, residual: makeResidual(-9) },
  ];
  const bytes = writeTile({ width: 16, height: 8, tileIndex: 0, tileTotal: 1, blocks });
  assert.deepEqual(Array.from(bytes.slice(0, 4)), TILE_MAGIC);
  assert.equal(bytes.length >= TILE_HEADER_SIZE, true);

  const parsed = parseTile(bytes);
  assert.equal(parsed.blocks.length, 2);
  assert.equal(parsed.blocks[0].mode, LAB_MODE_INTRA);
  assert.equal(parsed.blocks[0].refId, null);
  assert.deepEqual(Array.from(parsed.blocks[0].residual), Array.from(blocks[0].residual));
  assert.equal(parsed.blocks[1].refId, 3);
  assert.equal(parsed.blocks[1].hmvx, -7);
  assert.equal(parsed.blocks[1].hmvy, 5);
  assert.deepEqual(Array.from(parsed.blocks[1].residual), Array.from(blocks[1].residual));
});

test('parsing never consults a reference store: an unknown refId still parses', () => {
  const blocks = [{ bx: 0, by: 0, mode: 1, refId: 42, hmvx: 1, hmvy: 1, residual: makeResidual(0) }];
  const bytes = writeTile({ width: 8, height: 8, tileIndex: 0, tileTotal: 1, blocks });
  const store = new ReferenceStore();
  const parsed = parseTile(bytes);
  assert.equal(parsed.blocks[0].refId, 42);
  const result = decodeTile(bytes, [{ bx: 0, by: 0 }], store);
  assert.equal(result.suspended.length, 1);
  assert.equal(result.blocks[0].state, 'suspended');
  assert.match(result.blocks[0].reason, /reference 42/);
});

test('intra blocks decode independently even while inter blocks are suspended', () => {
  const blocks = [
    { bx: 0, by: 0, mode: LAB_MODE_INTRA, residual: makeResidual(10) },
    { bx: 1, by: 0, mode: 1, refId: 0, hmvx: 0, hmvy: 0, residual: makeResidual(0) },
  ];
  const bytes = writeTile({ width: 16, height: 8, tileIndex: 0, tileTotal: 1, blocks });
  const store = new ReferenceStore();
  const result = decodeTile(bytes, [
    { bx: 0, by: 0 },
    { bx: 1, by: 0 },
  ], store);
  assert.equal(result.suspended.length, 1);
  const intra = result.blocks[0];
  assert.equal(intra.state, 'decoded');
  // DC 128 + residual 10 = 138, verifiable with no reference at all.
  assert.equal(result.frame.planes[0][0], LAB_INTRA_DC + 10);
  // The suspended block's pixels remain at the frame's zero fill.
  assert.equal(result.frame.planes[0][8], 0);
});

test('resumeBlock rebuilds a suspended prediction from its own syntax after the ref arrives', () => {
  const reference = new Frame(16, 8, 1);
  reference.planes[0].fill(50);
  const blocks = [{ bx: 1, by: 0, mode: 1, refId: 0, hmvx: 0, hmvy: 0, residual: makeResidual(7) }];
  const bytes = writeTile({ width: 16, height: 8, tileIndex: 0, tileTotal: 1, blocks });
  const store = new ReferenceStore();
  const result = decodeTile(bytes, [{ bx: 1, by: 0 }], store);
  assert.equal(result.suspended.length, 1);

  store.add(0, reference);
  const resumed = resumeBlock(result, result.blocks[0], store);
  assert.equal(resumed.state, 'decoded');
  assert.equal(result.suspended.length, 0);
  // Prediction 50 + residual 7 = 57.
  assert.equal(result.frame.planes[0][8], 57);
});

test('resumeAll leaves blocks whose reference is still missing suspended', () => {
  const reference = new Frame(8, 8, 1);
  reference.planes[0].fill(40);
  const blocks = [
    { bx: 0, by: 0, mode: 1, refId: 0, hmvx: 0, hmvy: 0, residual: makeResidual(0) },
    { bx: 1, by: 0, mode: 1, refId: 1, hmvx: 0, hmvy: 0, residual: makeResidual(0) },
  ];
  const bytes = writeTile({ width: 16, height: 8, tileIndex: 0, tileTotal: 1, blocks });
  const store = new ReferenceStore();
  const result = decodeTile(
    bytes,
    [
      { bx: 0, by: 0 },
      { bx: 1, by: 0 },
    ],
    store,
  );
  assert.equal(result.suspended.length, 2);
  store.add(0, reference);
  resumeAll(result, store);
  assert.equal(result.suspended.length, 1);
  assert.equal(result.suspended[0].refId, 1);
});

test('assembler: out-of-order arrival suspends, reports missing refs, and resumes identically', () => {
  const fixture = buildSplitTileFixture();
  const assembler = new TileAssembler({ width: fixture.width, height: fixture.height });

  // Motion tiles arrive before the reference tile.
  const tileA = assembler.ingest(fixture.tiles[1].bytes, fixture.tiles[1].coords);
  const tileB = assembler.ingest(fixture.tiles[2].bytes, fixture.tiles[2].coords);
  assert.deepEqual(tileA.missingRefs, [0]);
  assert.deepEqual(tileB.missingRefs, [0]);
  assert.ok(tileA.suspended > 0 && tileB.suspended === 1);
  assert.equal(assembler.isComplete(), false);
  // The report names the reference id, not just a generic failure.
  assert.ok(assembler.missingReports.every((r) => r.refId === 0));

  // The test side can independently verify the received tile's written syntax.
  const view = assembler.viewTile(2);
  const syntax = view.blocks[0];
  assert.equal(syntax.refId, fixture.refId);
  assert.equal(syntax.hmvx, fixture.hmvx);
  assert.equal(syntax.hmvy, fixture.hmvy);
  assert.equal(syntax.state, 'suspended');

  // Reference tile is decoded on its own, then registered.
  const refStore = new ReferenceStore();
  const refResult = decodeTile(fixture.tiles[0].bytes, fixture.tiles[0].coords, refStore);
  assembler.registerReference(0, refResult.frame);
  const { resumed, stillSuspended } = assembler.resumePending();
  assert.equal(stillSuspended.length, 0);
  assert.equal(resumed.length, tileA.suspended + tileB.suspended);
  assert.equal(assembler.isComplete(), true);

  // Pixels equal a decode that had the reference available from the start.
  const direct = new TileAssembler({ width: fixture.width, height: fixture.height });
  direct.registerReference(0, refResult.frame);
  direct.ingest(fixture.tiles[1].bytes, fixture.tiles[1].coords);
  direct.ingest(fixture.tiles[2].bytes, fixture.tiles[2].coords);
  for (const [tileIndex, result] of assembler.results) {
    const good = direct.results.get(tileIndex);
    assert.deepEqual(Array.from(result.frame.planes[0]), Array.from(good.frame.planes[0]));
  }
});

test('assembler: the first motion block really lives on a different tile than the reference', () => {
  const fixture = buildSplitTileFixture();
  assert.notEqual(fixture.tiles[0].tileIndex, fixture.tiles[2].tileIndex);
  const referenceTileBlockCount = fixture.tiles[0].coords.length;
  assert.equal(referenceTileBlockCount, fixture.cols * fixture.rows);
  assert.deepEqual(fixture.tiles[2].coords[0], fixture.firstMotionBlock);
});

test('tile decoder rejects foreign magic and truncated payloads', () => {
  const blocks = [{ bx: 0, by: 0, mode: LAB_MODE_INTRA, residual: makeResidual(0) }];
  const bytes = writeTile({ width: 8, height: 8, tileIndex: 0, tileTotal: 1, blocks });
  const badMagic = bytes.slice();
  badMagic[0] ^= 0xff;
  assert.throws(() => parseTile(badMagic), /magic/);
  const truncated = bytes.slice(0, bytes.length - 2);
  assert.throws(() => parseTile(truncated));
});
