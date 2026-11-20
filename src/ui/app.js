// BMPP-1 experiment UI.
//
// Everything shown here comes from the shared core modules:
//   - the picture on "解码重建" is produced by decodeVideo(bytes), i.e. the
//     same function a third party would run;
//   - the prediction and residual canvases are the encoder's own prediction
//     and quantised residual for the selected block;
//   - the candidate scatter plots the recorded candidates with their real
//     SAD and transmitted-bit cost.
//
// The UI never fabricates a result: if encoding or decoding throws, the error
// is surfaced in the alert region instead of a picture.

import { Frame } from '../core/image.js';
import { encodeVideo } from '../core/encoder.js';
import { decodeVideo } from '../core/decode.js';
import { parseHeader } from '../core/container.js';
import { compareStrategies, summarise } from '../core/bench.js';
import { generateSequence, attachFrameClass, SCENARIOS } from '../core/scenarios.js';
import { searchBlock } from '../core/search.js';
import { lambdasForQP } from '../core/encoder.js';
import { BLOCK, MODE_INTER, MODE_INTRA, SEARCH_LABELS, STRATEGY_NOTES, SEARCH_STRATEGIES } from '../core/constants.js';

const $ = (id) => document.getElementById(id);

const state = {
  sequence: null,
  encode: null,
  decoded: null,
  strategy: 'full',
  radius: 12,
  frameIndex: 0,
  block: { bx: 0, by: 0 },
  busy: false,
};

// ---- canvas helpers ------------------------------------------------------

function setupCanvas(canvas, frame, zoom = 1) {
  const dpr = window.devicePixelRatio || 1;
  const displayW = frame.width * zoom;
  const displayH = frame.height * zoom;
  canvas.width = Math.max(1, Math.round(displayW * dpr));
  canvas.height = Math.max(1, Math.round(displayH * dpr));
  canvas.style.aspectRatio = `${frame.width} / ${frame.height}`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  return { ctx, displayW, displayH };
}

function drawFrame(canvas, frame, options = {}) {
  const { ctx, displayW, displayH } = setupCanvas(canvas, frame, options.zoom || 1);
  const rgba = frame.toRGBAData();
  const image = new ImageData(new Uint8ClampedArray(rgba), frame.width, frame.height);
  const off = document.createElement('canvas');
  off.width = frame.width;
  off.height = frame.height;
  off.getContext('2d').putImageData(image, 0, 0);
  ctx.clearRect(0, 0, displayW, displayH);
  ctx.drawImage(off, 0, 0, displayW, displayH);

  if (options.grid) {
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= frame.width; x += BLOCK) {
      const px = Math.round((x / frame.width) * displayW) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, displayH);
      ctx.stroke();
    }
    for (let y = 0; y <= frame.height; y += BLOCK) {
      const py = Math.round((y / frame.height) * displayH) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(displayW, py);
      ctx.stroke();
    }
  }

  if (options.block) {
    const { bx, by } = options.block;
    const x = (bx * BLOCK * displayW) / frame.width;
    const y = (by * BLOCK * displayH) / frame.height;
    const w = (BLOCK * displayW) / frame.width;
    const h = (BLOCK * displayH) / frame.height;
    ctx.strokeStyle = options.blockColor || '#4aa3ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    if (options.showVector) {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const scale = displayW / frame.width;
      const arrowX = cx + options.showVector.mvx * scale;
      const arrowY = cy + options.showVector.mvy * scale;
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(arrowX, arrowY);
      ctx.stroke();
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.arc(arrowX, arrowY, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (options.vectors) {
    drawVectorField(ctx, frame, displayW, displayH, options.vectors);
  }
}

function drawVectorField(ctx, frame, displayW, displayH, blocks) {
  const sx = displayW / frame.width;
  const sy = displayH / frame.height;
  ctx.lineWidth = 1;
  for (const block of blocks) {
    if (block.mode !== MODE_INTER || (block.mvx === 0 && block.mvy === 0)) continue;
    const x = (block.bx * BLOCK + BLOCK / 2) * sx;
    const y = (block.by * BLOCK + BLOCK / 2) * sy;
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.85)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + block.mvx * sx, y + block.mvy * sy);
    ctx.stroke();
  }
}

function drawBlockMini(canvas, values, { signed = false, size = 8 } = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const display = 128;
  canvas.width = display * dpr;
  canvas.height = display * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cell = display / size;
  ctx.fillStyle = '#05080c';
  ctx.fillRect(0, 0, display, display);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = values[y * size + x];
      let color;
      if (signed) {
        // residual: neutral grey at 0, red positive, blue negative
        const t = Math.max(-1, Math.min(1, v / 128));
        const r = Math.round(128 + t * 120);
        const b = Math.round(128 - t * 120);
        color = `rgb(${r},${128 - Math.abs(t) * 60},${b})`;
      } else {
        const c = Math.max(0, Math.min(255, Math.round(v)));
        color = `rgb(${c},${c},${c})`;
      }
      ctx.fillStyle = color;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  for (let i = 1; i < size; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell + 0.5, 0);
    ctx.lineTo(i * cell + 0.5, display);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * cell + 0.5);
    ctx.lineTo(display, i * cell + 0.5);
    ctx.stroke();
  }
}

// Candidate scatter: x = mvx, y = mvy (image-down positive), colour by cost.
function drawCandidates(canvas, search, radius) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const size = 360;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.aspectRatio = '1 / 1';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#05080c';
  ctx.fillRect(0, 0, size, size);

  if (!search || !search.candidates || search.candidates.length === 0) {
    ctx.fillStyle = '#9aa7b6';
    ctx.font = '13px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('该块无搜索候选（帧内模式或首帧）', size / 2, size / 2);
    return;
  }

  const candidates = search.candidates;
  const span = Math.max(radius, 1) * 2 + 1;
  const pad = 28;
  const scale = (size - pad * 2) / span;
  const toX = (mvx) => pad + (mvx + radius) * scale + scale / 2;
  const toY = (mvy) => pad + (mvy + radius) * scale + scale / 2;

  let minCost = Infinity;
  let maxCost = -Infinity;
  for (const c of candidates) {
    minCost = Math.min(minCost, c.cost);
    maxCost = Math.max(maxCost, c.cost);
  }

  // radial grid
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gx = pad + (i / 4) * (size - pad * 2);
    ctx.beginPath();
    ctx.moveTo(gx, pad);
    ctx.lineTo(gx, size - pad);
    ctx.stroke();
    const gy = pad + (i / 4) * (size - pad * 2);
    ctx.beginPath();
    ctx.moveTo(pad, gy);
    ctx.lineTo(size - pad, gy);
    ctx.stroke();
  }

  const range = Math.max(1, maxCost - minCost);
  for (const c of candidates) {
    const t = (c.cost - minCost) / range;
    const hue = 210 - t * 190; // blue (good) to red (bad)
    const alpha = 0.28 + 0.6 * (1 - t);
    const dot = Math.max(1.6, scale * 0.42);
    ctx.fillStyle = `hsla(${hue}, 85%, 60%, ${alpha})`;
    ctx.beginPath();
    ctx.arc(toX(c.mvx), toY(c.mvy), dot, 0, Math.PI * 2);
    ctx.fill();
  }

  const winner = search.best;
  if (winner) {
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(toX(winner.mvx), toY(winner.mvy), Math.max(5, scale * 0.55), 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffd166';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`(${winner.mvx},${winner.mvy})`, toX(winner.mvx) + 8, toY(winner.mvy) - 8);
  }

  ctx.fillStyle = '#9aa7b6';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('mvx →', size / 2, size - 8);
  ctx.save();
  ctx.translate(12, size / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('mvy ↓', 0, 0);
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.fillText(`代价范围 ${Math.round(minCost)} … ${Math.round(maxCost)}`, pad, pad - 10);
  ctx.fillStyle = '#4aa3ff';
  ctx.fillText(`${candidates.length} 候选`, size - pad - 78, pad - 10);
}

// ---- data plumbing -------------------------------------------------------

function currentSourceFrame() {
  return state.decoded ? state.sequence.frames[state.frameIndex] : null;
}

function currentReconFrame() {
  return state.decoded ? state.decoded.frames[state.frameIndex] : null;
}

function currentPlanFrame() {
  return state.encode ? state.encode.perFrame[state.frameIndex] : null;
}

function currentBlock() {
  const plan = currentPlanFrame();
  if (!plan) return null;
  const { bx, by } = state.block;
  return plan.blocks.find((b) => b.bx === bx && b.by === by) || null;
}

// Re-run the search for the selected block with candidate recording enabled,
// so the UI can show every candidate even when the full encode skipped it.
function inspectBlockSearch() {
  const plan = currentPlanFrame();
  if (!plan) return null;
  const { bx, by } = state.block;
  const reference = state.encode.perFrame[state.frameIndex - 1]?.recon;
  if (!reference) return null;
  const { lambdaSAD, earlyExitSad } = lambdasForQP(Number($('qp').value));
  return searchBlock({
    source: state.sequence.frames[state.frameIndex],
    reference,
    bx,
    by,
    radius: state.radius,
    lambda: lambdaSAD,
    strategy: state.strategy,
    earlyExitSad,
    recordCandidates: true,
  });
}

// ---- alert helpers -------------------------------------------------------

function clearAlerts() {
  $('alerts').replaceChildren();
}

function addAlert(kind, text) {
  const el = document.createElement('div');
  el.className = `alert alert-${kind}`;
  el.textContent = text;
  $('alerts').appendChild(el);
}

// ---- rendering -----------------------------------------------------------

function setBadge(text, kind) {
  const el = $('badge-state');
  el.textContent = text;
  el.className = `badge ${kind || ''}`;
}

function scenarioHint() {
  const meta = SCENARIOS[$('scenario').value];
  $('scenario-hint').textContent = meta ? `${meta.description} ${meta.vectors}` : '';
}

function strategyHint() {
  const strategy = $('strategy').value;
  $('strategy-hint').textContent = STRATEGY_NOTES[strategy] || '';
}

function renderFrame() {
  if (!state.decoded) return;
  const frame = currentSourceFrame();
  const recon = currentReconFrame();
  const plan = currentPlanFrame();
  const block = currentBlock();
  const total = state.decoded.frames.length;

  $('frame-label').textContent = `第 ${state.frameIndex + 1} / ${total} 帧`;
  $('frame-slider').value = String(state.frameIndex);

  drawFrame($('canvas-source'), frame, {
    grid: true,
    block: state.block,
    blockColor: '#4aa3ff',
  });
  drawFrame($('canvas-recon'), recon, {
    grid: true,
    block: state.block,
    blockColor: '#3fb950',
    vectors: plan ? plan.blocks : null,
  });

  if (plan && block) {
    const predictionFrame = buildPredictionFrame(plan, frame);
    drawFrame($('canvas-pred'), predictionFrame, {
      grid: true,
      block: { bx: block.bx, by: block.by },
      blockColor: '#c792ea',
      showVector:
        block.mode === MODE_INTER ? { mvx: block.mvx, mvy: block.mvy } : null,
    });
    $('pred-meta').textContent =
      block.mode === MODE_INTER
        ? `MV (${block.mvx}, ${block.mvy}) · 自重建参考帧 ${state.frameIndex}`
        : '帧内块 · DC 预测（无运动补偿）';

    renderResidualCanvas(block, predictionFrame);
    renderBlockInspector(block, plan);
  }
  renderFrameSummary();
}

// Tile the encoder's own prediction for every block into a full frame. For
// inter blocks this is the motion-compensated reference block; for intra
// blocks it is the DC predictor. Using the recorded prediction (not source)
// is what makes the residual viewer show the prediction residual the encoder
// actually transformed.
function buildPredictionFrame(plan, source) {
  const pred = new Frame(source.width, source.height, source.components);
  for (const block of plan.blocks) {
    if (!block.predicted) continue;
    const x0 = block.bx * BLOCK;
    const y0 = block.by * BLOCK;
    for (let c = 0; c < source.components; c++) {
      const values = block.predicted[c];
      if (!values) continue;
      const plane = pred.planes[c];
      for (let y = 0; y < BLOCK; y++) {
        const gy = y0 + y;
        if (gy >= source.height) break;
        for (let x = 0; x < BLOCK; x++) {
          const gx = x0 + x;
          if (gx >= source.width) break;
          plane[gy * source.width + gx] = values[y * BLOCK + x];
        }
      }
    }
  }
  return pred;
}

function renderResidualCanvas(block, predictionFrame) {
  // Prediction residual = source - prediction, per pixel, as a signed image.
  // This is exactly the signal handed to the transform (before quantisation).
  const source = currentSourceFrame();
  const canvas = $('canvas-resid');
  const dpr = window.devicePixelRatio || 1;
  const zoom = 4;
  canvas.width = source.width * dpr * zoom;
  canvas.height = source.height * dpr * zoom;
  canvas.style.aspectRatio = `${source.width} / ${source.height}`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const off = document.createElement('canvas');
  off.width = source.width;
  off.height = source.height;
  const offCtx = off.getContext('2d');
  const img = offCtx.createImageData(source.width, source.height);
  let sum = 0;
  for (let i = 0; i < source.width * source.height; i++) {
    const d = source.planes[0][i] - predictionFrame.planes[0][i];
    sum += Math.abs(d);
    const t = Math.max(-1, Math.min(1, d / 48));
    img.data[i * 4] = Math.round(128 + t * 120);
    img.data[i * 4 + 1] = Math.round(128 - Math.abs(t) * 70);
    img.data[i * 4 + 2] = Math.round(128 - t * 120);
    img.data[i * 4 + 3] = 255;
  }
  offCtx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, source.width * zoom, source.height * zoom);
  ctx.strokeStyle = '#4aa3ff';
  ctx.lineWidth = 2;
  const x = block.bx * BLOCK * zoom + 1;
  const y = block.by * BLOCK * zoom + 1;
  ctx.strokeRect(x, y, BLOCK * zoom - 2, BLOCK * zoom - 2);

  const meanAbs = sum / (source.width * source.height);
  $('resid-meta').textContent = `预测残差平均 |源−预测| ${meanAbs.toFixed(2)}`;
}

function blockLevels(block, plane = 0) {
  return block.levels ? block.levels[plane] : null;
}

function blockPrediction(block, plane = 0) {
  return block.predicted ? block.predicted[plane] : null;
}

function renderBlockInspector(block, plan) {
  $('block-label').textContent = `块 (${block.bx}, ${block.by}) · ${block.mode === MODE_INTER ? '帧间' : '帧内'}`;

  const source = currentSourceFrame();
  const W = source.width;
  const srcBlock = new Int32Array(64);
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      const gx = Math.min(source.width - 1, block.bx * BLOCK + x);
      const gy = Math.min(source.height - 1, block.by * BLOCK + y);
      srcBlock[y * BLOCK + x] = source.planes[0][gy * W + gx];
    }
  }
  const pred = blockPrediction(block);
  const recon = block.reconstruction ? block.reconstruction[0] : null;
  const resid = new Int32Array(64);
  if (pred) for (let i = 0; i < 64; i++) resid[i] = srcBlock[i] - pred[i];

  drawBlockMini($('mini-source'), srcBlock);
  drawBlockMini($('mini-pred'), pred || new Int32Array(64));
  drawBlockMini($('mini-resid'), resid, { signed: true });
  drawBlockMini($('mini-recon'), recon || new Int32Array(64));

  const facts = [
    ['模式', block.mode === MODE_INTER ? '帧间 INTER' : '帧内 INTRA'],
    ['运动矢量', block.mode === MODE_INTER ? `(${block.mvx}, ${block.mvy})` : '—'],
    ['SAD', String(block.sad)],
    ['静止 SAD', block.stationarySad === null ? '—' : String(block.stationarySad)],
    ['块比特', `${block.bits} bit`],
    ['其中向量', `${block.mvBits} bit`],
    ['其中系数', `${block.coeffBits} bit`],
    ['块 SSD', String(block.ssd)],
    ['候选数', String(block.candidatesEvaluated)],
    ['搜索模式', block.searchMode],
    ['RD 代价', block.cost.toFixed(0)],
    ['帧内代价', block.intraCost.toFixed(0)],
    ['帧间代价', block.interCost === null ? '—' : block.interCost.toFixed(0)],
  ];
  const wrap = $('block-facts');
  wrap.replaceChildren();
  for (const [k, v] of facts) {
    const cell = document.createElement('div');
    cell.className = 'fact';
    const kk = document.createElement('span');
    kk.className = 'k';
    kk.textContent = k;
    const vv = document.createElement('span');
    vv.className = 'v';
    vv.textContent = v;
    cell.append(kk, vv);
    wrap.appendChild(cell);
  }

  renderCandidates(block);
}

function renderCandidates(block) {
  // Use the recorded candidates from a fresh search when possible; otherwise
  // fall back to the encode-time winner only.
  let search = null;
  try {
    search = inspectBlockSearch();
  } catch (error) {
    search = null;
  }
  if (!search && state.encode && block.candidateList) {
    search = { best: block.chosenCandidate, candidates: block.candidateList };
  }

  const summary = $('candidate-summary');
  const body = $('candidates-body');
  body.replaceChildren();

  if (!search || !search.candidates || search.candidates.length === 0) {
    summary.textContent = block.mode === MODE_INTER
      ? `该块为帧间模式，但未记录候选（${block.candidatesEvaluated} 次评估）`
      : '该块为帧内模式，未执行运动搜索';
    drawCandidates($('canvas-candidates'), null, state.radius);
    return;
  }

  summary.textContent = `${search.candidates.length} 个候选 · 策略 ${SEARCH_LABELS[state.strategy]} · 半径 ${state.radius} · 最终选择按 SAD + λ·bits`;
  drawCandidates($('canvas-candidates'), search, state.radius);

  const winner = search.best;
  const sorted = [...search.candidates].sort((a, b) => a.cost - b.cost).slice(0, 40);
  for (const c of sorted) {
    const tr = document.createElement('tr');
    const isWinner = winner && c.mvx === winner.mvx && c.mvy === winner.mvy;
    if (isWinner) tr.className = 'winner';
    for (const value of [`(${c.mvx}, ${c.mvy})`, c.sad, c.bits, Math.round(c.cost), isWinner ? '★' : '']) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

function renderStreamFacts() {
  if (!state.encode) return;
  const header = parseHeader(state.encode.bytes);
  const wrap = $('stream-facts');
  wrap.replaceChildren();
  const facts = [
    ['文件字节', String(state.encode.bytes.length)],
    ['magic', 'BMPP'],
    ['版本', String(header.version)],
    ['几何', `${header.width}×${header.height}×${header.components}`],
    ['帧数', String(header.frameCount)],
    ['payload 位', String(header.payloadBits)],
    ['CRC32', `0x${header.payloadCrc.toString(16)}`],
    ['码率', `${(header.payloadBits / (header.frameCount * header.width * header.height)).toFixed(3)} bpp`],
    ['向量 bits', String(state.encode.stats.mvBits)],
    ['系数 bits', String(state.encode.stats.coeffBits)],
    ['块', `${state.encode.stats.interBlocks} inter / ${state.encode.stats.intraBlocks} intra`],
    ['候选评估', String(state.encode.stats.candidates)],
  ];
  for (const [k, v] of facts) {
    const cell = document.createElement('div');
    cell.className = 'fact';
    const kk = document.createElement('span');
    kk.className = 'k';
    kk.textContent = k;
    const vv = document.createElement('span');
    vv.className = 'v';
    vv.textContent = v;
    cell.append(kk, vv);
    wrap.appendChild(cell);
  }

  const head = state.encode.bytes.slice(0, 32);
  const lines = [];
  for (let offset = 0; offset < head.length; offset += 8) {
    const chunk = Array.from(head.slice(offset, offset + 8))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    lines.push(`${offset.toString(16).padStart(4, '0')}  ${chunk}`);
  }
  $('header-hex').textContent = lines.join('\n');
}

// Per-frame behaviour for the whole sequence, so no single block is mistaken
// for the sequence's behaviour.
function renderFrameSummary() {
  const wrap = $('frame-summary');
  wrap.replaceChildren();
  if (!state.encode) return;

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th>帧</th><th>模式</th><th>Inter</th><th>Intra</th>
    <th>平均 MV</th><th>最大 |MV|</th><th>SSD</th><th>payload 位</th>
  </tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');

  let totalInter = 0;
  let totalIntra = 0;
  let totalSsd = 0;
  let totalBits = 0;

  state.encode.perFrame.forEach((plan, index) => {
    const interBlocks = plan.blocks.filter((b) => b.mode === MODE_INTER);
    const intraBlocks = plan.blocks.length - interBlocks.length;
    let mvSumX = 0;
    let mvSumY = 0;
    let maxAbs = 0;
    for (const b of interBlocks) {
      mvSumX += b.mvx;
      mvSumY += b.mvy;
      maxAbs = Math.max(maxAbs, Math.abs(b.mvx), Math.abs(b.mvy));
    }
    const ssd = plan.blocks.reduce((n, b) => n + b.ssd, 0);
    totalInter += interBlocks.length;
    totalIntra += intraBlocks;
    totalSsd += ssd;
    totalBits += plan.framePayloadBits;

    const tr = document.createElement('tr');
    if (index === state.frameIndex) tr.style.background = 'rgba(74,163,255,0.10)';
    const avgMv = interBlocks.length
      ? `${(mvSumX / interBlocks.length).toFixed(1)}, ${(mvSumY / interBlocks.length).toFixed(1)}`
      : '—';
    const cells = [
      `#${index}${index === 0 ? ' (首帧)' : ''}`,
      index === 0 ? 'intra-only' : 'inter-capable',
      interBlocks.length,
      intraBlocks,
      avgMv,
      maxAbs,
      ssd,
      plan.framePayloadBits,
    ];
    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });

  const totalRow = document.createElement('tr');
  totalRow.style.fontWeight = '600';
  const totalCells = [
    `合计 ${state.encode.perFrame.length} 帧`,
    '—',
    totalInter,
    totalIntra,
    '—',
    '—',
    totalSsd,
    totalBits,
  ];
  for (const value of totalCells) {
    const td = document.createElement('td');
    td.textContent = String(value);
    totalRow.appendChild(td);
  }
  tbody.appendChild(totalRow);
  table.appendChild(tbody);
  wrap.replaceChildren(table);
}

function renderFrameStrip() {
  const strip = $('frame-strip');
  strip.replaceChildren();
  if (!state.decoded) return;
  state.decoded.frames.forEach((_, index) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `frame-chip${index === state.frameIndex ? ' active' : ''}`;
    chip.textContent = `#${index}`;
    chip.addEventListener('click', () => {
      state.frameIndex = index;
      renderFrame();
      renderFrameStrip();
    });
    strip.appendChild(chip);
  });
}

function updateNav() {
  const total = state.decoded ? state.decoded.frames.length : 0;
  $('prev').disabled = !state.decoded || state.frameIndex <= 0;
  $('next').disabled = !state.decoded || state.frameIndex >= total - 1;
  $('prev-block').disabled = !state.decoded;
  $('next-block').disabled = !state.decoded;
  $('download').disabled = !state.encode;
  $('compare').disabled = !state.decoded || state.busy;
  $('frame-slider').disabled = !state.decoded;
}

// ---- pipeline ------------------------------------------------------------

async function runEncode() {
  if (state.busy) return;
  state.busy = true;
  clearAlerts();
  setBadge('编码中…', '');
  updateNav();

  try {
    const width = clampInt($('width').value, 8, 256, 64);
    const height = clampInt($('height').value, 8, 192, 48);
    const frames = clampInt($('frames').value, 2, 24, 6);
    const qp = clampInt($('qp').value, 0, 51, 24);
    const radius = clampInt($('radius').value, 0, 64, 12);
    const rgb = $('rgb').checked;
    $('width').value = width;
    $('height').value = height;
    $('frames').value = frames;
    $('qp').value = qp;
    $('radius').value = radius;

    const strategy = $('strategy').value;
    const scenario = $('scenario').value;
    const raw = generateSequence(scenario, { width, height, frames, components: rgb ? 3 : 1 });
    const seq = attachFrameClass(raw, Frame);

    const encode = encodeVideo({
      frames: seq.frames,
      qp,
      radius,
      strategy,
      fps: 12,
      graySource: !rgb,
    });
    // Decode in the browser from the bytes alone; this is the actual proof
    // that the format is decodable.
    const decoded = decodeVideo(encode.bytes);

    let mismatch = 0;
    for (let i = 0; i < frames; i++) {
      if (!framesEqual(encode.perFrame[i].recon, decoded.frames[i])) mismatch += 1;
    }
    if (mismatch > 0) {
      throw new Error(`编码器重建与解码器输出不一致（${mismatch} 帧），这是内部错误`);
    }

    state.sequence = seq;
    state.encode = encode;
    state.decoded = decoded;
    state.strategy = strategy;
    state.radius = radius;
    // Land on the first frame that has a reference so the prediction, residual
    // and candidate views are immediately meaningful. Frame 0 is necessarily
    // intra and has no motion search.
    state.frameIndex = frames > 1 ? 1 : 0;
    state.block = pickInterBlock(encode.perFrame[state.frameIndex]) || { bx: 0, by: 0 };

    setBadge('已编码 · 解码校验通过', 'state-ok');
    addAlert(
      'good',
      `编码完成并通过独立解码：${encode.bytes.length} 字节，${frames} 帧逐像素一致。`,
    );

    detectAnomalies(encode, decoded, radius, frames);

    $('frame-slider').max = String(frames - 1);
    $('frame-slider').value = String(state.frameIndex);
    renderFrameStrip();
    renderFrame();
    renderStreamFacts();
  } catch (error) {
    console.error(error);
    state.encode = null;
    state.decoded = null;
    setBadge('编码失败', 'state-bad');
    addAlert('bad', `编码或解码失败：${error.message}`);
    $('frame-label').textContent = '—';
  } finally {
    state.busy = false;
    updateNav();
  }
}

function detectAnomalies(encode, decoded, radius, frameCount) {
  // 1) Any vector at the search border is suspicious: the true motion may lie
  //    outside the window, so prediction is probably poor there.
  let border = 0;
  let worstBorderSad = 0;
  for (let f = 1; f < frameCount; f++) {
    for (const b of encode.perFrame[f].blocks) {
      if (b.mode !== MODE_INTER) continue;
      if (Math.abs(b.mvx) === radius || Math.abs(b.mvy) === radius) {
        border += 1;
        worstBorderSad = Math.max(worstBorderSad, b.sad);
      }
    }
  }
  if (border > 0) {
    addAlert(
      'warn',
      `${border} 个块的运动矢量落在搜索窗口边界（±${radius}），最大 SAD ${worstBorderSad}。` +
        `真实位移可能超出范围，预测质量因此受限；可增大搜索半径重新编码对比。`,
    );
  }

  // 2) First frame must be fully intra. Anything else means a reference was
  //    used where none can exist.
  const firstIntra = encode.perFrame[0].blocks.every((b) => b.mode === MODE_INTRA);
  if (!firstIntra) {
    addAlert('bad', '首帧出现帧间块：没有参考帧就不可能这样编码，这是内部错误。');
  }

  // 3) Wrong-vector signal: a block moved but its SAD is worse than standing
  //    still. That is legitimate under an RD objective, but it must be stated
  //    so nobody mistakes it for a better pixel match.
  let worse = 0;
  for (let f = 1; f < frameCount; f++) {
    for (const b of encode.perFrame[f].blocks) {
      if (
        b.mode === MODE_INTER &&
        (b.mvx !== 0 || b.mvy !== 0) &&
        b.stationarySad !== null &&
        b.sad > b.stationarySad
      ) {
        worse += 1;
      }
    }
  }
  if (worse > 0) {
    addAlert(
      'info',
      `${worse} 个块的运动矢量 SAD 高于静止候选，选择由率失真代价（SAD + λ·向量比特）驱动，` +
        `说明矢量编码成本确实参与了决策，而不是只取像素差最小。`,
    );
  }

  // 4) High mean SSD after motion compensation means the sequence is not being
  //    predicted well; report the number so the reader can judge.
  let totalSsd = 0;
  let count = 0;
  for (let f = 1; f < frameCount; f++) {
    for (const b of encode.perFrame[f].blocks) {
      totalSsd += b.ssd;
      count += 1;
    }
  }
  const meanSsd = count ? totalSsd / count : 0;
  if (meanSsd > 4000) {
    addAlert(
      'warn',
      `帧间块平均 SSD ${meanSsd.toFixed(0)} 偏高，运动补偿效果有限；可调整 QP、半径或策略。`,
    );
  }

  // 5) Revealed background: intra blocks inside an inter frame are expected in
  //    occlusion, and their presence is a feature, not a failure. Surface the
  //    count only when there are many, so it is not mistaken for a bug either.
  let intraInInter = 0;
  for (let f = 1; f < frameCount; f++) {
    intraInInter += encode.perFrame[f].blocks.filter((b) => b.mode === MODE_INTRA).length;
  }
  if (intraInInter > 0) {
    addAlert(
      'info',
      `帧间帧内有 ${intraInInter} 个块选择了帧内模式（无匹配参考时报文内），这是遮挡显露等场景的正确行为。`,
    );
  }
}

function clampInt(raw, min, max, fallback) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

// Choose a block that actually demonstrates motion prediction: an inter block
// with a non-zero vector, preferring one with many evaluated candidates.
function pickInterBlock(plan) {
  if (!plan) return null;
  let best = null;
  for (const block of plan.blocks) {
    if (block.mode !== MODE_INTER) continue;
    const score = (block.mvx !== 0 || block.mvy !== 0 ? 100000 : 0) + block.candidatesEvaluated;
    if (!best || score > best.score) best = { score, block };
  }
  return best ? { bx: best.block.bx, by: best.block.by } : null;
}

function framesEqual(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.components !== b.components) return false;
  for (let c = 0; c < a.components; c++) {
    const pa = a.planes[c];
    const pb = b.planes[c];
    if (pa.length !== pb.length) return false;
    for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return false;
  }
  return true;
}

async function compareAll() {
  if (!state.sequence || state.busy) return;
  state.busy = true;
  $('compare').disabled = true;
  const out = $('compare-output');
  out.innerHTML = '<p class="empty-state">正在以真实编码运行三种策略…</p>';
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const qp = clampInt($('qp').value, 0, 51, 24);
    const radius = clampInt($('radius').value, 0, 64, 12);
    const rows = summarise(
      compareStrategies({ frames: state.sequence.frames, qp, radius }),
    );

    const bestRd = Math.min(...rows.map((r) => r.rdCost));
    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr>
          <th>策略</th><th>块匹配/帧</th><th>字节</th><th>bpp</th>
          <th>PSNR</th><th>RD 代价</th><th>编码 ms</th>
        </tr>
      </thead>`;
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      if (row.rdCost === bestRd) tr.className = 'best';
      const cells = [
        SEARCH_LABELS[row.strategy],
        row.evaluationsPerFrame.toLocaleString(),
        row.bytes,
        row.bitsPerPixel.toFixed(3),
        row.psnr === null ? '无损 (SSE=0)' : row.psnr.toFixed(2),
        row.rdCost.toLocaleString(),
        row.encodeMs.toFixed(0),
      ];
      for (const value of cells) {
        const td = document.createElement('td');
        td.textContent = String(value);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    out.replaceChildren(table);

    const full = rows.find((r) => r.strategy === SEARCH_STRATEGIES.FULL);
    const diamond = rows.find((r) => r.strategy === SEARCH_STRATEGIES.DIAMOND);
    if (full && diamond) {
      const ratio = (diamond.evaluationsPerFrame / Math.max(1, full.evaluationsPerFrame)) * 100;
      addAlert(
        'info',
        `对比完成：菱形搜索计算量为全搜索的 ${ratio.toFixed(1)}%，` +
          `RD 代价 ${diamond.rdCost.toLocaleString()} vs ${full.rdCost.toLocaleString()}。`,
      );
    }
  } catch (error) {
    console.error(error);
    out.innerHTML = '';
    addAlert('bad', `策略对比失败：${error.message}`);
  } finally {
    state.busy = false;
    updateNav();
  }
}

// ---- block selection -----------------------------------------------------

function canvasToBlock(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * state.decoded.frames[0].width;
  const y = ((event.clientY - rect.top) / rect.height) * state.decoded.frames[0].height;
  const bx = Math.max(0, Math.min(state.decoded.frames[0].blockCols - 1, Math.floor(x / BLOCK)));
  const by = Math.max(0, Math.min(state.decoded.frames[0].blockRows - 1, Math.floor(y / BLOCK)));
  state.block = { bx, by };
  renderFrame();
}

function stepBlock(delta) {
  if (!state.decoded) return;
  const frame = state.decoded.frames[0];
  const total = frame.blockCols * frame.blockRows;
  const current = state.block.by * frame.blockCols + state.block.bx;
  const next = (current + delta + total) % total;
  state.block = { bx: next % frame.blockCols, by: Math.floor(next / frame.blockCols) };
  renderFrame();
}

// ---- wiring --------------------------------------------------------------

function bind() {
  for (const id of ['canvas-source', 'canvas-recon', 'canvas-pred', 'canvas-resid']) {
    $(id).addEventListener('click', (event) => {
      if (!state.decoded) return;
      canvasToBlock($(id), event);
    });
  }

  $('scenario').addEventListener('change', scenarioHint);
  $('strategy').addEventListener('change', strategyHint);
  $('run').addEventListener('click', runEncode);
  $('compare').addEventListener('click', compareAll);

  $('prev').addEventListener('click', () => {
    if (state.frameIndex > 0) {
      state.frameIndex -= 1;
      renderFrame();
      renderFrameStrip();
      updateNav();
    }
  });
  $('next').addEventListener('click', () => {
    if (state.decoded && state.frameIndex < state.decoded.frames.length - 1) {
      state.frameIndex += 1;
      renderFrame();
      renderFrameStrip();
      updateNav();
    }
  });
  $('frame-slider').addEventListener('input', (event) => {
    state.frameIndex = Number(event.target.value);
    renderFrame();
    renderFrameStrip();
    updateNav();
  });
  $('prev-block').addEventListener('click', () => stepBlock(-1));
  $('next-block').addEventListener('click', () => stepBlock(1));

  $('download').addEventListener('click', () => {
    if (!state.encode) return;
    const blob = new Blob([state.encode.bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `sequence-${state.strategy}-qp${$('qp').value}.bmpp`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  window.addEventListener('keydown', (event) => {
    if (!state.decoded) return;
    if (event.key === 'ArrowLeft') $('prev').click();
    if (event.key === 'ArrowRight') $('next').click();
  });
}

function init() {
  scenarioHint();
  strategyHint();
  bind();
  setBadge('未编码', '');
  addAlert(
    'info',
    '选择参数后点击「编码并重建」。画面中的重建来自浏览器内对 .bmpp 字节的真实解码。',
  );
  // Kick off one predictable run so the interface is never empty on load.
  runEncode();
}

init();
