// Lab tile bitstream.
//
// A deliberately small, self-describing fragment format used only by the lab
// (magic "BMPT"). It reuses the core bit/gamma primitives but is independent
// of the BMPP-1 container: a tile names the reference frame by an explicit id
// instead of inheriting "the previous frame", so the assembler can discover a
// missing reference without guessing.
//
// Header (16 bytes, little-endian):
//   0  4  magic "BMPT"
//   4  2  width
//   6  2  height
//   8  1  block size (=8)
//   9  1  tile index
//   10 1  tile total
//   11 1  block count in this tile
//   12 4  payload bit length
// Payload: per block
//   1 bit   mode (0 intra, 1 inter)
//   if inter: gamma refId, gamma hmvx map, gamma hmvy map (half-pel units)
//   8 bits  residual[0..63], signed -128..127
//
// Intra blocks are context-free (DC predictor fixed at 128), so any single
// tile can be decoded and verified without neighbours or other tiles.

import { BitWriter, BitReader, writeGamma, readGamma, GAMMA_MAX_N, FormatError } from '../core/bitstream.js';
import { BLOCK } from '../core/constants.js';
import { Frame } from '../core/image.js';
import { buildSubpelBlock } from './subpel.js';

export const TILE_MAGIC = [0x42, 0x4d, 0x50, 0x54]; // "BMPT"
export const TILE_HEADER_SIZE = 16;
export const LAB_MODE_INTRA = 0;
export const LAB_MODE_INTER = 1;
export const LAB_INTRA_DC = 128;

// Signed mapping for half-pel vector components: 0 -> 1, -1 -> 2, +1 -> 3 ...
const mapSigned = (v) => (v <= 0 ? -2 * v + 1 : 2 * v);
const unmapSigned = (c) => (c === 1 ? 0 : c % 2 === 1 ? -((c - 1) / 2) : c / 2);

function writeBlockSyntax(writer, block) {
  writer.write(block.mode === LAB_MODE_INTER ? 1 : 0, 1);
  if (block.mode === LAB_MODE_INTER) {
    if (!Number.isInteger(block.refId) || block.refId < 0) {
      throw new RangeError('inter block needs a non-negative integer refId');
    }
    if (block.refId + 1 > GAMMA_MAX_N) throw new RangeError(`refId ${block.refId} outside gamma range`);
    writeGamma(writer, block.refId + 1); // gamma codes n >= 1
    writeGamma(writer, mapSigned(block.hmvx));
    writeGamma(writer, mapSigned(block.hmvy));
  }
  if (block.residual.length !== BLOCK * BLOCK) throw new RangeError('residual must be 64 samples');
  for (const r of block.residual) {
    if (!Number.isInteger(r) || r < -128 || r > 127) {
      throw new RangeError(`residual sample ${r} outside signed 8 bits`);
    }
    writer.write(r < 0 ? r + 256 : r, 8);
  }
}

export function writeTile({ width, height, tileIndex, tileTotal, blocks }) {
  if (width < 1 || height < 1) throw new RangeError('bad tile geometry');
  if (!Array.isArray(blocks) || blocks.length === 0) throw new RangeError('tile needs blocks');
  for (const b of blocks) {
    if (!Number.isInteger(b.bx) || !Number.isInteger(b.by)) throw new RangeError('block needs bx/by');
  }
  const writer = new BitWriter();
  for (const block of blocks) writeBlockSyntax(writer, block);
  writer.alignToByte();
  const payload = writer.toUint8Array();

  const header = new Uint8Array(TILE_HEADER_SIZE);
  header.set(TILE_MAGIC, 0);
  const view = new DataView(header.buffer);
  view.setUint16(4, width, true);
  view.setUint16(6, height, true);
  header[8] = BLOCK;
  header[9] = tileIndex;
  header[10] = tileTotal;
  header[11] = blocks.length;
  view.setUint32(12, writer.length, true);

  const bytes = new Uint8Array(TILE_HEADER_SIZE + payload.length);
  bytes.set(header, 0);
  bytes.set(payload, TILE_HEADER_SIZE);
  return bytes;
}

export function parseTileHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < TILE_HEADER_SIZE) {
    throw new FormatError('tile shorter than header');
  }
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== TILE_MAGIC[i]) throw new FormatError('bad tile magic (not a BMPT tile)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(4, true);
  const height = view.getUint16(6, true);
  const blockSize = bytes[8];
  if (blockSize !== BLOCK) throw new FormatError(`unsupported tile block size ${blockSize}`);
  const payloadBits = view.getUint32(12, true);
  if (TILE_HEADER_SIZE + Math.ceil(payloadBits / 8) !== bytes.length) {
    throw new FormatError('tile payload length mismatch');
  }
  return {
    width,
    height,
    tileIndex: bytes[9],
    tileTotal: bytes[10],
    blockCount: bytes[11],
    payloadBits,
  };
}

// Parse only the syntax (modes, ref ids, half-pel vectors, residuals). This
// never touches a reference store, so a tile with an unknown refId still
// parses completely — the test side can verify what was actually written.
export function parseTile(bytes) {
  const header = parseTileHeader(bytes);
  const reader = new BitReader(bytes, TILE_HEADER_SIZE);
  const blocks = [];
  for (let i = 0; i < header.blockCount; i++) {
    const mode = reader.read(1) === 1 ? LAB_MODE_INTER : LAB_MODE_INTRA;
    let refId = null;
    let hmvx = 0;
    let hmvy = 0;
    if (mode === LAB_MODE_INTER) {
      refId = readGamma(reader) - 1;
      hmvx = unmapSigned(readGamma(reader));
      hmvy = unmapSigned(readGamma(reader));
    }
    const residual = new Int32Array(BLOCK * BLOCK);
    for (let p = 0; p < BLOCK * BLOCK; p++) {
      const raw = reader.read(8);
      residual[p] = raw >= 128 ? raw - 256 : raw;
    }
    blocks.push({ bx: null, by: null, mode, refId, hmvx, hmvy, residual });
  }
  return {
    width: header.width,
    height: header.height,
    tileIndex: header.tileIndex,
    tileTotal: header.tileTotal,
    payloadBits: header.payloadBits,
    blocks,
  };
}

const PRED = new Int32Array(BLOCK * BLOCK);
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function paintBlock(frame, bx, by, pred, residual) {
  const { width } = frame;
  const x0 = bx * BLOCK;
  const y0 = by * BLOCK;
  const plane = frame.planes[0];
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      const px = x0 + x;
      const py = y0 + y;
      if (px >= frame.width || py >= frame.height) continue;
      plane[py * width + px] = clamp8(pred[y * BLOCK + x] + residual[y * BLOCK + x]);
    }
  }
}

// Decode one tile against a reference store. Inter blocks whose refId is not
// in the store are SUSPENDED, not fatal: their syntax stays available and the
// returned frame simply leaves those blocks unpainted. Intra blocks and inter
// blocks with present references are always reconstructed.
export function decodeTile(bytes, coords, store, { earlyRounding = false } = {}) {
  const parsed = parseTile(bytes);
  if (coords.length !== parsed.blocks.length) {
    throw new FormatError('coordinate list length does not match the tile');
  }
  const frame = new Frame(parsed.width, parsed.height, 1);
  const records = [];
  const suspended = [];

  for (let i = 0; i < parsed.blocks.length; i++) {
    const syntax = parsed.blocks[i];
    const { bx, by } = coords[i];
    const base = {
      bx,
      by,
      mode: syntax.mode,
      refId: syntax.refId,
      hmvx: syntax.hmvx,
      hmvy: syntax.hmvy,
      residual: syntax.residual,
      state: 'decoded',
    };
    if (syntax.mode === LAB_MODE_INTRA) {
      PRED.fill(LAB_INTRA_DC);
      paintBlock(frame, bx, by, PRED, syntax.residual);
      base.prediction = Int32Array.from(PRED);
      records.push(base);
      continue;
    }
    if (!store.has(syntax.refId)) {
      base.state = 'suspended';
      base.reason = `missing reference ${syntax.refId}`;
      suspended.push(base);
      records.push(base);
      continue;
    }
    const reference = store.get(syntax.refId);
    buildSubpelBlock(reference, bx, by, syntax.hmvx, syntax.hmvy, PRED, earlyRounding);
    paintBlock(frame, bx, by, PRED, syntax.residual);
    base.prediction = Int32Array.from(PRED);
    records.push(base);
  }

  return {
    header: {
      width: parsed.width,
      height: parsed.height,
      tileIndex: parsed.tileIndex,
      tileTotal: parsed.tileTotal,
      payloadBits: parsed.payloadBits,
    },
    frame,
    blocks: records,
    suspended,
    tileIndex: parsed.tileIndex,
    tileTotal: parsed.tileTotal,
  };
}

// Resume one suspended block after its reference has arrived. The block's own
// syntax (vector and residual) is taken from the suspension record, so the
// prediction is rebuilt exactly as it would have been on the first pass.
export function resumeBlock(result, block, store, { earlyRounding = false } = {}) {
  if (block.state !== 'suspended') return block;
  if (!store.has(block.refId)) {
    const err = new Error(`reference ${block.refId} still unavailable`);
    err.name = 'MissingReference';
    throw err;
  }
  const reference = store.get(block.refId);
  buildSubpelBlock(reference, block.bx, block.by, block.hmvx, block.hmvy, PRED, earlyRounding);
  paintBlock(result.frame, block.bx, block.by, PRED, block.residual);
  block.prediction = Int32Array.from(PRED);
  block.state = 'decoded';
  block.reason = null;
  const idx = result.suspended.indexOf(block);
  if (idx >= 0) result.suspended.splice(idx, 1);
  return block;
}

export function resumeAll(result, store, opts) {
  // Blocks whose reference is still absent stay suspended; resumeBlock itself
  // throws on a missing reference, so check availability here.
  for (const block of result.suspended.slice()) {
    if (store.has(block.refId)) resumeBlock(result, block, store, opts);
  }
  return result;
}
