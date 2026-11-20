// BMPP-1 container and file header.
//
// File layout (multi-byte integers little-endian; header is byte aligned):
//
//   offset size field
//   0      4    magic "BMPP"
//   4      1    version (=1)
//   5      1    flags: bit0 source was gray8 (else RGB24)
//   6      2    reserved (0)
//   8      2    width  (1..1920)
//   10     2    height (1..1920)
//   12     1    block size (=8)
//   13     1    components (1 or 3)
//   14     1    search radius used to produce the stream (informational)
//   15     1    frames per second (1..255, informational)
//   16     4    frame count
//   20     4    payload bit length (excludes final byte padding)
//   24     4    crc32 of the padded payload bytes
//   28     4    total file size in bytes
//   32     ...  payload bitstream
//
// The payload is a bitstream. Every frame starts byte aligned so a decoder can
// also restart at a frame boundary without replaying earlier bits.

import { FormatError } from './bitstream.js';
import {
  MAGIC,
  VERSION,
  HEADER_SIZE,
  BLOCK,
  MAX_DIM,
  MAX_FRAMES,
} from './constants.js';

export const FLAG_GRAY = 1;

// ---- CRC32 (IEEE 802.3 polynomial, reflected) ----------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function writeHeader({
  width,
  height,
  components,
  searchRadius,
  fps,
  frameCount,
  payloadBits,
  payloadCrc,
  totalSize,
  graySource,
}) {
  if (!Number.isInteger(width) || width < 1 || width > MAX_DIM) throw new RangeError('bad width');
  if (!Number.isInteger(height) || height < 1 || height > MAX_DIM) throw new RangeError('bad height');
  if (components !== 1 && components !== 3) throw new RangeError('bad components');
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > MAX_FRAMES) {
    throw new RangeError('bad frame count');
  }
  if (searchRadius < 0 || searchRadius > 255) throw new RangeError('bad search radius');
  if (fps < 1 || fps > 255) throw new RangeError('bad fps');
  const header = new Uint8Array(HEADER_SIZE);
  header.set(MAGIC, 0);
  header[4] = VERSION;
  header[5] = graySource ? FLAG_GRAY : 0;
  header[12] = BLOCK;
  header[13] = components;
  header[14] = searchRadius;
  header[15] = fps;
  const view = new DataView(header.buffer);
  view.setUint16(8, width, true);
  view.setUint16(10, height, true);
  view.setUint32(16, frameCount, true);
  view.setUint32(20, payloadBits, true);
  view.setUint32(24, payloadCrc >>> 0, true);
  view.setUint32(28, totalSize, true);
  return header;
}

export function parseHeader(bytes) {
  if (bytes.length < HEADER_SIZE) throw new FormatError('file shorter than header');
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i]) throw new FormatError('bad magic (not a BMPP-1 file)');
  }
  if (bytes[4] !== VERSION) throw new FormatError(`unsupported version ${bytes[4]}`);
  const flags = bytes[5];
  if ((flags & 0b11111110) !== 0) throw new FormatError('reserved header flags set');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(6, true) !== 0) throw new FormatError('reserved header bytes non-zero');
  const width = view.getUint16(8, true);
  const height = view.getUint16(10, true);
  const block = bytes[12];
  const components = bytes[13];
  const searchRadius = bytes[14];
  const fps = bytes[15];
  const frameCount = view.getUint32(16, true);
  const payloadBits = view.getUint32(20, true);
  const payloadCrc = view.getUint32(24, true);
  const totalSize = view.getUint32(28, true);
  if (width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM) {
    throw new FormatError('invalid dimensions');
  }
  if (block !== BLOCK) throw new FormatError(`unsupported block size ${block}`);
  if (components !== 1 && components !== 3) throw new FormatError('invalid component count');
  if (frameCount < 1 || frameCount > MAX_FRAMES) throw new FormatError('invalid frame count');
  if (fps < 1) throw new FormatError('invalid fps');
  if (totalSize !== bytes.length) throw new FormatError('file size field mismatch');
  const payloadBytes = Math.ceil(payloadBits / 8);
  if (HEADER_SIZE + payloadBytes !== bytes.length) {
    throw new FormatError('payload length does not match file size');
  }
  return {
    version: bytes[4],
    width,
    height,
    components,
    block,
    searchRadius,
    fps,
    frameCount,
    payloadBits,
    payloadCrc: payloadCrc >>> 0,
    totalSize,
    graySource: (flags & FLAG_GRAY) !== 0,
  };
}

export { HEADER_SIZE };
