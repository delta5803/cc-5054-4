// BMPP-1 encoder.
//
// Honesty contract: every reference used for motion search is the
// *reconstruction* of the previous frame — exactly the picture the decoder
// will hold. The original frame is used only to form residuals and evaluate
// reconstruction error; it is never placed into the reference buffer.
// planFrame() keeps a running reconstruction in raster order so intra
// prediction sees the same neighbours the decoder will see.

import {
  BLOCK,
  BLOCK_PIXELS,
  MODE_INTRA,
  MODE_INTER,
  QSTEP,
} from './constants.js';
import { Frame, blockSAD } from './image.js';
import { searchBlock } from './search.js';
import { mvBits, writeMV } from './mvcode.js';
import { BitWriter } from './bitstream.js';
import { writeCoeffBlock, coeffBlockBits, clampLevelArray } from './coeff.js';
import { writeHeader, crc32, HEADER_SIZE } from './container.js';
import {
  buildPredictionBlock,
  buildIntraBlock,
  residualFromPrediction,
  transformAndQuantize,
  reconstructBlock,
  blockSSD,
} from './blockcodec.js';

// Both lambdas derive from the quantiser step. lambdaSSD prices one bit
// against squared reconstruction error in the mode decision; lambdaSAD prices
// one bit against SAD inside motion search. Because the MV code is variable
// length, vector cost genuinely varies with displacement.
export function lambdasForQP(qp) {
  const step = QSTEP[qp];
  return {
    lambdaSSD: Math.max(1, Math.round(step * step * 0.85)),
    lambdaSAD: Math.max(1, Math.round((step * step) / 16)),
    // Spiral's early exit: stop widening the ring once the best match is
    // already within ~2 luma levels per pixel (64 px * 2). This is what makes
    // it "speed first" rather than a re-ordered full search.
    earlyExitSad: BLOCK_PIXELS * 2,
  };
}

const PRED = new Int32Array(BLOCK_PIXELS);

function hasNonZero(levels) {
  for (let i = 0; i < BLOCK_PIXELS; i++) if (levels[i] !== 0) return true;
  return false;
}

// Run one component block through the real quantiser; return the exact
// coefficient bit count and the resulting SSD against the source.
function codeComponent(frame, plane, bx, by, pred, qp) {
  const residual = residualFromPrediction(frame, plane, bx, by, pred);
  const levels = clampLevelArray(transformAndQuantize(residual, qp));
  const present = hasNonZero(levels);
  const bits = present ? 1 + coeffBlockBits(levels) : 1;
  const ssd = blockSSD(frame, null, plane, bx, by, pred, levels, qp);
  return { plane, levels, bits, coeffBits: present ? coeffBlockBits(levels) : 0, ssd, present };
}

// Decide every block of one frame. Returns the encoder-side reconstruction and
// a block list whose bit counts equal the bits writeFrame() will emit.
export function planFrame({
  frame,
  reference,
  qp,
  radius,
  strategy,
  firstFrame = false,
  recordCandidates = false,
}) {
  const { lambdaSSD, lambdaSAD, earlyExitSad } = lambdasForQP(qp);
  const cols = frame.blockCols;
  const rows = frame.blockRows;
  const recon = new Frame(frame.width, frame.height, frame.components);
  const blocks = [];
  let candidatesEvaluated = 0;

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      let search = null;
      if (!firstFrame && reference) {
        search = searchBlock({
          source: frame,
          reference,
          bx,
          by,
          radius,
          lambda: lambdaSAD,
          strategy,
          earlyExitSad,
          recordCandidates,
        });
        candidatesEvaluated += search.evaluated;
      }

      let inter = null;
      if (search) {
        const { mvx, mvy } = search.best;
        const components = [];
        let ssd = 0;
        let coeffBits = 0;
        for (let c = 0; c < frame.components; c++) {
          buildPredictionBlock(reference, c, bx, by, mvx, mvy, PRED);
          const comp = codeComponent(frame, c, bx, by, PRED, qp);
          comp.pred = Int32Array.from(PRED);
          ssd += comp.ssd;
          coeffBits += comp.bits;
          components.push(comp);
        }
        const mvCostBits = mvBits(mvx, mvy);
        const bits = 1 + mvCostBits + coeffBits;
        // SAD of the zero vector, for diagnostics: if the chosen vector has a
        // worse SAD than standing still, the decision was driven by RD cost,
        // and the UI should say so rather than imply a better match.
        const stationarySad = blockSAD(frame, reference, bx, by, 0, 0);
        inter = {
          mode: MODE_INTER,
          mvx,
          mvy,
          components,
          ssd,
          bits,
          mvBits: mvCostBits,
          coeffBits,
          cost: ssd + lambdaSSD * bits,
          search,
          stationarySad,
          searchSad: search.best.sad,
        };
      }

      const intraComponents = [];
      let intraSSD = 0;
      let intraCoeffBits = 0;
      for (let c = 0; c < frame.components; c++) {
        buildIntraBlock(recon, c, bx, by, PRED);
        const comp = codeComponent(frame, c, bx, by, PRED, qp);
        comp.pred = Int32Array.from(PRED);
        intraSSD += comp.ssd;
        intraCoeffBits += comp.bits;
        intraComponents.push(comp);
      }
      const intraBits = 1 + intraCoeffBits;
      const intra = {
        mode: MODE_INTRA,
        mvx: 0,
        mvy: 0,
        components: intraComponents,
        ssd: intraSSD,
        bits: intraBits,
        mvBits: 0,
        coeffBits: intraCoeffBits,
        cost: intraSSD + lambdaSSD * intraBits,
        search: null,
      };

      const chosen = inter && inter.cost < intra.cost ? inter : intra;

      // Commit to the running reconstruction in raster order; intra prediction
      // depends on this exact ordering.
      const reconstructed = [];
      for (const comp of chosen.components) {
        if (chosen.mode === MODE_INTER) {
          buildPredictionBlock(reference, comp.plane, bx, by, chosen.mvx, chosen.mvy, PRED);
        } else {
          buildIntraBlock(recon, comp.plane, bx, by, PRED);
        }
        reconstructBlock(recon, comp.plane, bx, by, PRED, comp.levels, qp);
        const { width } = recon;
        const planeBuf = recon.planes[comp.plane];
        const out = new Int32Array(BLOCK_PIXELS);
        for (let y = 0; y < BLOCK; y++) {
          for (let x = 0; x < BLOCK; x++) {
            out[y * BLOCK + x] = planeBuf[(by * BLOCK + y) * width + bx * BLOCK + x];
          }
        }
        reconstructed.push(out);
      }

      blocks.push({
        bx,
        by,
        mode: chosen.mode,
        mvx: chosen.mvx,
        mvy: chosen.mvy,
        bits: chosen.bits,
        mvBits: chosen.mvBits,
        coeffBits: chosen.coeffBits,
        ssd: chosen.ssd,
        cost: chosen.cost,
        intraCost: intra.cost,
        interCost: inter ? inter.cost : null,
        intraSSD: intra.ssd,
        interSSD: inter ? inter.ssd : null,
        sad: search ? search.best.sad : 0,
        stationarySad: inter ? inter.stationarySad : null,
        candidatesEvaluated: search ? search.evaluated : 0,
        searchMode: search ? search.mode : 'no-reference',
        stopRing: search ? search.stopRing : null,
        chosenCandidate: search ? search.best : null,
        candidateList: search ? search.candidates : null,
        levels: chosen.components.map((c) => c.levels),
        predicted: chosen.components.map((c) => c.pred),
        reconstruction: reconstructed,
      });
    }
  }

  return { recon, blocks, candidatesEvaluated, lambdaSSD, lambdaSAD };
}

// Serialise one planned frame; must mirror decode.js exactly.
export function writeFrame(writer, plan, frame, qp, firstFrame) {
  writer.alignToByte();
  writer.write(firstFrame ? 0 : 1, 1); // frame type
  writer.write(qp, 6);
  for (const block of plan.blocks) {
    writer.write(block.mode === MODE_INTER ? 1 : 0, 1);
    if (block.mode === MODE_INTER) writeMV(writer, block.mvx, block.mvy);
    for (let c = 0; c < frame.components; c++) {
      const levels = block.levels[c];
      const present = hasNonZero(levels);
      writer.write(present ? 1 : 0, 1);
      if (present) writeCoeffBlock(writer, levels);
    }
  }
  return writer;
}

export function encodeVideo({
  frames,
  qp = 26,
  radius = 16,
  strategy = 'full',
  fps = 12,
  graySource = false,
  recordCandidates = false,
}) {
  if (!frames.length) throw new Error('at least one frame required');
  const { width, height, components } = frames[0];
  for (const f of frames) {
    if (f.width !== width || f.height !== height || f.components !== components) {
      throw new Error('all frames must share geometry and component count');
    }
  }
  if (!Number.isInteger(qp) || qp < 0 || qp >= QSTEP.length) throw new RangeError('qp out of range');

  const payload = new BitWriter();
  const perFrame = [];

  for (let i = 0; i < frames.length; i++) {
    const firstFrame = i === 0;
    const plan = planFrame({
      frame: frames[i],
      reference: firstFrame ? null : perFrame[i - 1].recon,
      qp,
      radius,
      strategy,
      firstFrame,
      recordCandidates,
    });
    const startBits = payload.length;
    writeFrame(payload, plan, frames[i], qp, firstFrame);
    const endBits = payload.length;
    perFrame.push({
      index: i,
      recon: plan.recon,
      blocks: plan.blocks,
      candidatesEvaluated: plan.candidatesEvaluated,
      lambdaSSD: plan.lambdaSSD,
      lambdaSAD: plan.lambdaSAD,
      framePayloadBits: endBits - startBits,
    });
  }

  payload.alignToByte();
  const payloadBytes = payload.toUint8Array();
  const header = writeHeader({
    width,
    height,
    components,
    searchRadius: radius,
    fps,
    frameCount: frames.length,
    payloadBits: payload.length,
    payloadCrc: crc32(payloadBytes),
    totalSize: HEADER_SIZE + payloadBytes.length,
    graySource,
  });
  const bytes = new Uint8Array(header.length + payloadBytes.length);
  bytes.set(header, 0);
  bytes.set(payloadBytes, header.length);

  let mvBitsTotal = 0;
  let coeffBitsTotal = 0;
  let interBlocks = 0;
  let intraBlocks = 0;
  let candidatesTotal = 0;
  let ssdTotal = 0;
  for (const f of perFrame) {
    for (const b of f.blocks) {
      mvBitsTotal += b.mvBits;
      coeffBitsTotal += b.coeffBits;
      ssdTotal += b.ssd;
      if (b.mode === MODE_INTER) interBlocks += 1;
      else intraBlocks += 1;
    }
    candidatesTotal += f.candidatesEvaluated;
  }

  return {
    bytes,
    perFrame,
    header: {
      width,
      height,
      components,
      qp,
      radius,
      strategy,
      fps,
      frameCount: frames.length,
      payloadBytes: payloadBytes.length,
      payloadBits: payload.length,
      crc32: crc32(payloadBytes),
      totalBytes: bytes.length,
    },
    stats: {
      mvBits: mvBitsTotal,
      coeffBits: coeffBitsTotal,
      interBlocks,
      intraBlocks,
      candidates: candidatesTotal,
      ssd: ssdTotal,
    },
  };
}
