#!/usr/bin/env node
// Command-line helper for the block-prediction lab.
//
// The graphical interface (src/ui/index.html) is the primary entry point; this
// CLI exists to produce/verify .bmpp files and to run the strategy comparison
// headlessly. See docs/FORMAT.md for the bitstream and docs/UI.md for the GUI.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Frame, meanSquaredError, psnr } from '../src/core/image.js';
import { encodeVideo } from '../src/core/encoder.js';
import { decodeVideo } from '../src/core/decode.js';
import { parseHeader } from '../src/core/container.js';
import { generateSequence, attachFrameClass, SCENARIOS } from '../src/core/scenarios.js';
import { compareStrategies, summarise } from '../src/core/bench.js';
import { SEARCH_LABELS, SEARCH_STRATEGIES } from '../src/core/constants.js';

const USAGE = `BMPP-1 block prediction lab (CLI helper)

  encode <scenario> <out.bmpp> [--qp N] [--radius N] [--strategy full|spiral|diamond]
                                   [--frames N] [--width N] [--height N]
                                   [--rgb] [--fps N]
  decode <in.bmpp> [--verify] [--out raw.rgb]
  bench  <scenario> [--qp N] [--radius N] [--frames N] [--width N] [--height N]
  info   <in.bmpp>

Scenarios: ${Object.keys(SCENARIOS).join(', ')}

The graphical interface is the primary entry point: open src/ui/index.html
through the bundled server (npm start) and use "块预测实验界面".
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function num(flags, name, fallback) {
  if (flags[name] === undefined) return fallback;
  const value = Number(flags[name]);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
}

async function loadScenario(name, flags) {
  if (!SCENARIOS[name]) throw new Error(`unknown scenario "${name}"`);
  const width = num(flags, 'width', 64);
  const height = num(flags, 'height', 48);
  const frames = num(flags, 'frames', 8);
  const components = flags.rgb ? 3 : 1;
  const raw = generateSequence(name, { width, height, frames, components });
  return attachFrameClass(raw, Frame);
}

async function writeOutput(path, bytes) {
  const abs = resolve(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return abs;
}

function strategyOf(flags) {
  const strategy = flags.strategy ? String(flags.strategy) : 'full';
  if (!Object.values(SEARCH_STRATEGIES).includes(strategy)) {
    throw new Error(`--strategy must be one of ${Object.values(SEARCH_STRATEGIES).join(', ')}`);
  }
  const radius = num(flags, 'radius', 12);
  if (radius < 0 || radius > 255) throw new Error('--radius must be 0..255');
  return { strategy, radius };
}

async function cmdEncode(positional, flags) {
  const [scenario, outPath] = positional;
  if (!scenario || !outPath) throw new Error('encode needs <scenario> <out.bmpp>');
  const seq = await loadScenario(scenario, flags);
  const { strategy, radius } = strategyOf(flags);
  const qp = num(flags, 'qp', 24);
  const fps = num(flags, 'fps', 12);
  const result = encodeVideo({
    frames: seq.frames,
    qp,
    radius,
    strategy,
    fps,
    graySource: !flags.rgb,
  });
  const abs = await writeOutput(outPath, result.bytes);
  let sse = 0;
  let count = 0;
  for (let i = 0; i < seq.frames.length; i++) {
    const m = meanSquaredError(seq.frames[i], result.perFrame[i].recon);
    sse += m.sse;
    count += m.count;
  }
  const overall = sse === 0 ? Infinity : 10 * Math.log10((255 * 255 * count) / sse);
  console.log(`wrote ${abs}`);
  console.log(`  ${result.bytes.length} bytes, ${seq.frames.length} frames, ${result.header.width}x${result.header.height}`);
  console.log(`  strategy=${strategy} qp=${qp} radius=${radius} crc32=0x${result.header.crc32.toString(16)}`);
  console.log(`  blocks: ${result.stats.interBlocks} inter / ${result.stats.intraBlocks} intra`);
  console.log(`  candidates evaluated: ${result.stats.candidates}`);
  console.log(`  reconstruction PSNR: ${overall === Infinity ? '无损 (SSE=0)' : overall.toFixed(2) + ' dB'}`);
}

async function cmdDecode(positional, flags) {
  const [inPath] = positional;
  if (!inPath) throw new Error('decode needs <in.bmpp>');
  const bytes = new Uint8Array(await readFile(resolve(inPath)));
  const header = parseHeader(bytes);
  const decoded = decodeVideo(bytes);
  console.log(`decoded ${decoded.frames.length} frames, ${header.width}x${header.height}, ${header.components} component(s)`);
  console.log(`  payload bits ${header.payloadBits}, crc ok`);
  if (flags.verify) {
    console.log('  CRC verified; all frames reconstructed');
    // Round-trip guarantee: re-encode is not required, but we report per-frame
    // checksums so the reader can compare against encoder output.
    for (let i = 0; i < decoded.frames.length; i++) {
      const sum = checksum(decoded.frames[i].planes[0]);
      console.log(`  frame ${i}: luma checksum ${sum}`);
    }
  }
  if (flags.out) {
    const { width, height, components } = header;
    const out = new Uint8Array(width * height * components * decoded.frames.length);
    let offset = 0;
    for (const frame of decoded.frames) {
      for (let c = 0; c < components; c++) {
        out.set(frame.planes[c], offset);
        offset += width * height;
      }
    }
    const abs = await writeOutput(flags.out, out);
    console.log(`  raw planes written to ${abs}`);
  }
}

function checksum(plane) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < plane.length; i++) {
    h ^= plane[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

async function cmdBench(positional, flags) {
  const [scenario] = positional;
  if (!scenario) throw new Error('bench needs <scenario>');
  const seq = await loadScenario(scenario, flags);
  const qp = num(flags, 'qp', 24);
  const radius = num(flags, 'radius', 12);
  const rows = summarise(compareStrategies({ frames: seq.frames, qp, radius }));
  console.log(`strategy comparison: ${scenario}, qp=${qp}, radius=${radius}, ${seq.frames.length} frames`);
  const header = ['strategy', 'evals/frame', 'bytes', 'bpp', 'PSNR', 'RD cost', 'encode ms'];
  console.log(header.join('\t'));
  for (const row of rows) {
    console.log(
      [
        row.strategy,
        row.evaluationsPerFrame,
        row.bytes,
        row.bitsPerPixel,
        row.psnr === null ? '无损 (SSE=0)' : row.psnr,
        row.rdCost,
        row.encodeMs.toFixed(1),
      ].join('\t'),
    );
  }
}

async function cmdInfo(positional) {
  const [inPath] = positional;
  if (!inPath) throw new Error('info needs <in.bmpp>');
  const bytes = new Uint8Array(await readFile(resolve(inPath)));
  const header = parseHeader(bytes);
  for (const [key, value] of Object.entries(header)) console.log(`${key}: ${value}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case 'encode':
      return cmdEncode(positional, flags);
    case 'decode':
      return cmdDecode(positional, flags);
    case 'bench':
      return cmdBench(positional, flags);
    case 'info':
      return cmdInfo(positional, flags);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
});
