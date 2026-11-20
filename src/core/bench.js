// Strategy comparison: compute the operational cost and the rate-distortion
// outcome of each search strategy on the same sequence.
//
// "Computational cost" is reported as the number of block-match evaluations,
// which is the dominant term and the only hardware-independent measure. The
// "rate-distortion cost" is derived from the actual encoded stream (real
// bytes) and the actual reconstruction (real PSNR), not from estimator
// proxies, so comparing strategies compares the coder, not the metric.

import { encodeVideo } from './encoder.js';
import { decodeVideo } from './decode.js';
import { meanSquaredError } from './image.js';
import { SEARCH_LABELS, SEARCH_STRATEGIES } from './constants.js';

export function evaluateStrategy({ frames, qp, radius, strategy, fps = 12, graySource = false }) {
  const start = performance.now();
  const enc = encodeVideo({ frames, qp, radius, strategy, fps, graySource });
  const encodeMs = performance.now() - start;

  const decStart = performance.now();
  const dec = decodeVideo(enc.bytes);
  const decodeMs = performance.now() - decStart;

  let sse = 0;
  let count = 0;
  for (let i = 0; i < frames.length; i++) {
    const m = meanSquaredError(frames[i], dec.frames[i]);
    sse += m.sse;
    count += m.count;
    // The encoder's own reconstruction must equal the decoded output; if it
    // does not, the stream is not honest and we surface it here.
    const roundTrip = meanSquaredError(enc.perFrame[i].recon, dec.frames[i]);
    if (roundTrip.sse !== 0) {
      throw new Error(`strategy ${strategy}: encoder/decoder mismatch on frame ${i}`);
    }
  }
  const mse = sse / Math.max(1, count);
  const psnrOverall = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);

  // RD cost in the same units the encoder uses: SSD + lambda * bits, with
  // lambda taken from the first frame's plan (constant for a fixed QP).
  const lambdaSSD = enc.perFrame[0].lambdaSSD;
  const rdCost = sse + lambdaSSD * enc.header.payloadBits;

  return {
    strategy,
    label: SEARCH_LABELS[strategy],
    evaluations: enc.stats.candidates,
    evaluationsPerFrame: Math.round(enc.stats.candidates / frames.length),
    bytes: enc.bytes.length,
    payloadBits: enc.header.payloadBits,
    bitsPerPixel: enc.header.payloadBits / (frames.length * frames[0].width * frames[0].height),
    psnr: psnrOverall,
    rdCost,
    encodeMs,
    decodeMs,
    mvBits: enc.stats.mvBits,
    coeffBits: enc.stats.coeffBits,
    interBlocks: enc.stats.interBlocks,
    intraBlocks: enc.stats.intraBlocks,
    bytesData: enc.bytes,
    encodeResult: enc,
  };
}

// Remove the heavy per-strategy payload before returning to a UI or JSON log.
export function summarise(rows) {
  return rows.map(({ encodeResult, bytesData, ...rest }) => ({
    ...rest,
    psnr: Number.isFinite(rest.psnr) ? Number(rest.psnr.toFixed(3)) : null,
    rdCost: Math.round(rest.rdCost),
    bitsPerPixel: Number(rest.bitsPerPixel.toFixed(4)),
  }));
}

export function compareStrategies({ frames, qp, radius, fps = 12, strategies }) {
  const list = strategies || Object.values(SEARCH_STRATEGIES);
  return list.map((strategy) => evaluateStrategy({ frames, qp, radius, strategy, fps }));
}
