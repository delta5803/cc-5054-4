// Tile assembler.
//
// Models a transport layer that hands the decoder one tile at a time, with
// tiles possibly arriving out of order and reference pictures travelling on a
// separate channel. The contract:
//
//   - a tile whose inter blocks name an unknown reference id is accepted and
//     parsed immediately, but the affected predictions are SUSPENDED; the
//     assembler reports the missing ids instead of throwing;
//   - tiles that need only available references (and any intra tile) are
//     reconstructed on arrival, so the test side can verify them while other
//     tiles are still pending;
//   - when the missing reference is registered later, resumePending() rebuilds
//     the held predictions from the blocks' own transmitted syntax.

import { parseTile, decodeTile, resumeAll, LAB_MODE_INTER } from './tile.js';
import { ReferenceStore } from './refstore.js';

export class TileAssembler {
  constructor({ width, height, earlyRounding = false } = {}) {
    this.width = width;
    this.height = height;
    this.earlyRounding = earlyRounding;
    this.store = new ReferenceStore();
    this.results = new Map(); // tileIndex -> decodeTile result
    this.missingReports = []; // { tileIndex, refId, blockCount }
    this.arrivalOrder = [];
  }

  // Coordinates map the k-th block syntax entry of a tile to a (bx, by) grid
  // position. The assembler does not assume raster order inside a tile.
  ingest(bytes, coords) {
    const parsed = parseTile(bytes);
    const missing = new Map();
    for (const block of parsed.blocks) {
      if (block.mode === LAB_MODE_INTER && !this.store.has(block.refId)) {
        missing.set(block.refId, (missing.get(block.refId) || 0) + 1);
      }
    }
    const result = decodeTile(bytes, coords, this.store, { earlyRounding: this.earlyRounding });
    this.results.set(parsed.tileIndex, result);
    this.arrivalOrder.push(parsed.tileIndex);
    for (const [refId, blockCount] of missing) {
      const report = { tileIndex: parsed.tileIndex, refId, blockCount };
      this.missingReports.push(report);
    }
    return {
      tileIndex: parsed.tileIndex,
      missingRefs: [...missing.keys()],
      suspended: result.suspended.length,
      decoded: result.blocks.length - result.suspended.length,
      result,
    };
  }

  registerReference(id, frame) {
    const wasMissing = new Set(this.missingReports.map((r) => r.refId));
    this.store.add(id, frame);
    return { id, unblocks: wasMissing.has(id) };
  }

  // Rebuild every still-suspended block whose reference has since arrived.
  // Blocks whose reference is still absent stay suspended and are returned.
  resumePending() {
    const resumed = [];
    const stillSuspended = [];
    for (const result of this.results.values()) {
      for (const block of result.suspended.slice()) {
        if (this.store.has(block.refId)) resumed.push(block);
        else stillSuspended.push(block);
      }
      resumeAll(result, this.store, { earlyRounding: this.earlyRounding });
    }
    return { resumed, stillSuspended };
  }

  get pendingCount() {
    let n = 0;
    for (const result of this.results.values()) n += result.suspended.length;
    return n;
  }

  // Independent verification view: the tile a tester can check without
  // waiting for anything else — its parsed syntax plus the blocks that were
  // reconstructible on arrival.
  viewTile(tileIndex) {
    const result = this.results.get(tileIndex);
    if (!result) throw new Error(`tile ${tileIndex} has not arrived`);
    return {
      tileIndex,
      blocks: result.blocks.map((b) => ({
        bx: b.bx,
        by: b.by,
        mode: b.mode,
        refId: b.refId,
        hmvx: b.hmvx,
        hmvy: b.hmvy,
        residual: b.residual,
        state: b.state,
      })),
    };
  }

  // A full picture only exists once every block of every received tile has
  // been reconstructed.
  isComplete() {
    return this.pendingCount === 0;
  }
}
