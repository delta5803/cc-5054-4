// BMPP-1 decoder.
//
// This file must be able to run on its own given only a byte array: it shares
// the low-level primitive modules (bit/transform/coeff/mv code) with the
// encoder, but never imports encoder planning state. decodeVideo() is the
// function the tests and the UI use to prove that the bytes are real.

import { BitReader, FormatError } from './bitstream.js';
import { parseHeader, crc32, HEADER_SIZE } from './container.js';
import { MODE_INTRA, MODE_INTER, QSTEP } from './constants.js';
import { Frame } from './image.js';
import { readMV } from './mvcode.js';
import { readCoeffBlock } from './coeff.js';
import { buildPredictionBlock, buildIntraBlock, reconstructBlock } from './blockcodec.js';

export function decodeVideo(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new FormatError('decoder expects a Uint8Array');
  const header = parseHeader(bytes);

  // CRC over the padded payload bytes.
  const payloadBytes = bytes.subarray(HEADER_SIZE);
  const crc = crc32(payloadBytes);
  if (crc !== header.payloadCrc) {
    throw new FormatError(
      `payload CRC mismatch: header ${header.payloadCrc.toString(16)}, computed ${crc.toString(16)}`,
    );
  }

  const reader = new BitReader(bytes, HEADER_SIZE);
  const frames = [];
  const perFrame = [];
  let reference = null;

  for (let i = 0; i < header.frameCount; i++) {
    reader.alignToByte();
    const frameType = reader.read(1);
    if (i === 0 && frameType !== 0) throw new FormatError('first frame must be intra');
    if (i > 0 && frameType === 0) throw new FormatError('non-first frame may not be flagged intra-only');
    const qp = reader.read(6);
    if (qp >= QSTEP.length) throw new FormatError(`qp ${qp} out of range`);

    const frame = new Frame(header.width, header.height, header.components);
    const { blockCols, blockRows } = frame;
    const blockRecords = [];

    for (let by = 0; by < blockRows; by++) {
      for (let bx = 0; bx < blockCols; bx++) {
        const modeBit = reader.read(1);
        const mode = modeBit === 1 ? MODE_INTER : MODE_INTRA;
        let mvx = 0;
        let mvy = 0;
        if (mode === MODE_INTER) {
          if (!reference) throw new FormatError('inter block without reference frame');
          const mv = readMV(reader);
          mvx = mv.mvx;
          mvy = mv.mvy;
        }
        const componentLevels = [];
        for (let c = 0; c < header.components; c++) {
          const present = reader.read(1) === 1;
          const levels = new Int32Array(64);
          if (present) readCoeffBlock(reader, levels);
          componentLevels.push(levels);
        }

        for (let c = 0; c < header.components; c++) {
          const levels = componentLevels[c];
          if (mode === MODE_INTER) {
            buildPredictionBlock(reference, c, bx, by, mvx, mvy, PRED);
          } else {
            buildIntraBlock(frame, c, bx, by, PRED);
          }
          reconstructBlock(frame, c, bx, by, PRED, levels, qp);
        }

        blockRecords.push({
          bx,
          by,
          mode,
          mvx,
          mvy,
          present: componentLevels.map((l) => l.some((v) => v !== 0)),
        });
      }
    }

    frames.push(frame);
    perFrame.push({ index: i, frameType, qp, blocks: blockRecords });
    // The next frame always references the reconstruction just produced,
    // regardless of the frame-type flag (which only records whether inter
    // coding was allowed).
    reference = frame;
  }

  return { header, frames, perFrame, crcOk: true };
}

const PRED = new Int32Array(64);

// Convenience for callers that only need pixels.
export function decodeToRGBA(bytes) {
  const { frames, header } = decodeVideo(bytes);
  const images = frames.map((f) => f.toRGBAData());
  return { images, width: header.width, height: header.height, frames: frames.length };
}
