// Synthetic test sequences.
//
// These are generated deterministically (fixed seeds) so that tests and the UI
// reproduce the same pictures. Three scenarios map directly onto the brief:
//
//   pan      a textured plane translating by a known integer offset; exercises
//            accurate vector recovery and shows MV coding cost mattering.
//   occlusion  a foreground square slides to reveal background behind it;
//            newly uncovered pixels have no temporal match, so the encoder
//            must be able to fall back to intra instead of forcing a bad MV.
//   overshoot a moving object whose displacement exceeds the search radius;
//            the encoder must clip to the border of the window, report the
//            vector as out-of-range for the intended motion, and still decode
//            identically.

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeFrame(width, height, components) {
  const buffers = Array.from({ length: components }, () => new Uint8Array(width * height));
  return { width, height, components, buffers };
}

// Smooth multi-octave texture in [0,255].
function texture(width, height, seed) {
  const rand = seededRandom(seed);
  const phases = Array.from({ length: 6 }, () => rand() * Math.PI * 2);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v =
        128 +
        46 * Math.sin(x * 0.19 + phases[0]) * Math.cos(y * 0.11 + phases[1]) +
        32 * Math.sin((x + y) * 0.07 + phases[2]) +
        18 * Math.sin(x * 0.53 - y * 0.41 + phases[3]) +
        10 * Math.sin(y * 0.9 + phases[4]);
      out[y * width + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return out;
}

function sample(plane, width, height, x, y) {
  const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
  const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
  return plane[cy * width + cx];
}

function toFrames(frames) {
  return frames;
}

export const SCENARIOS = Object.freeze({
  pan: {
    id: 'pan',
    label: '平移纹理 Pan',
    description:
      '整幅纹理按已知整数位移平移，向量应被稳定恢复；用于核对向量编码成本是否参与选择。',
    vectors: 'ground truth: +2 px/frame',
  },
  occlusion: {
    id: 'occlusion',
    label: '遮挡显露 Occlusion',
    description:
      '前景方块滑开露出背景，新显露区域无对应参考，编码器应回退到帧内而不是硬编码错误向量。',
    vectors: 'foreground +3 px/frame',
  },
  overshoot: {
    id: 'overshoot',
    label: '超范围运动 Overshoot',
    description:
      '物体每帧位移大于搜索半径，向量被钳制在窗口边界，需核对解码仍一致且报告越界。',
    vectors: 'object +14 px/frame, radius 6',
  },
});

export function generateSequence(scenarioId, { width = 64, height = 48, frames = 8, components = 1 } = {}) {
  switch (scenarioId) {
    case 'pan':
      return panSequence(width, height, frames, components);
    case 'occlusion':
      return occlusionSequence(width, height, frames, components);
    case 'overshoot':
      return overshootSequence(width, height, frames, components);
    default:
      throw new Error(`unknown scenario ${scenarioId}`);
  }
}

// A texture that scrolls right by `shift` pixels per frame. The background
// wraps, so every block has a valid temporal match.
function panSequence(width, height, frameCount, components) {
  const base = Array.from({ length: components }, (_, c) => texture(width, height, 1000 + c * 977));
  const out = [];
  for (let f = 0; f < frameCount; f++) {
    const shift = 2 * f;
    const frame = makeFrame(width, height, components);
    for (let c = 0; c < components; c++) {
      const src = base[c];
      const dst = frame.buffers[c];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          dst[y * width + x] = sample(src, width, height, (x - shift + width) % width, y);
        }
      }
    }
    out.push(frame);
  }
  return { frames: toFrames(out), scenario: 'pan' };
}

// Static background texture; a bright square travels right, revealing the
// background as it moves. Newly exposed columns have no temporal match in the
// previous frame, so an honest encoder should switch those blocks to intra.
function occlusionSequence(width, height, frameCount, components) {
  const bg = texture(width, height, 4242);
  const out = [];
  const squareSize = Math.max(12, Math.floor(width / 4));
  for (let f = 0; f < frameCount; f++) {
    const frame = makeFrame(width, height, components);
    const squareX = Math.floor((width - squareSize) * (f / Math.max(1, frameCount - 1)));
    const squareY = Math.floor(height / 2 - squareSize / 2);
    for (let c = 0; c < components; c++) {
      const dst = frame.buffers[c];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const inside =
            x >= squareX && x < squareX + squareSize && y >= squareY && y < squareY + squareSize;
          if (inside) {
            // Foreground: flat, strongly coloured, low texture so its own
            // motion is recoverable but the newly exposed strip is not.
            dst[y * width + x] = c === 0 ? 235 : c === 1 ? 210 : 120;
          } else {
            dst[y * width + x] = c === 0 ? bg[y * width + x] : Math.round(bg[y * width + x] * 0.85);
          }
        }
      }
    }
    out.push(frame);
  }
  return { frames: toFrames(out), scenario: 'occlusion' };
}

// Background texture with a textured square moving right by 14 px/frame. With
// a radius below 14 the estimator cannot represent the true displacement, so
// blocks fully inside the square clamp to the window border. The square is
// larger than one block and carries its own texture so that interior blocks
// have a clear, unique temporal match at the true (unreachable) offset.
function overshootSequence(width, height, frameCount, components) {
  const bg = texture(width, height, 777);
  const patch = texture(width, height, 991);
  const out = [];
  const squareSize = Math.max(24, Math.floor(width / 2));
  const startY = Math.floor((height - squareSize) / 2);
  const step = 14;
  for (let f = 0; f < frameCount; f++) {
    const frame = makeFrame(width, height, components);
    const squareX = 2 + step * f;
    for (let c = 0; c < components; c++) {
      const dst = frame.buffers[c];
      dst.set(bg);
      for (let y = startY; y < Math.min(height, startY + squareSize); y++) {
        for (let x = squareX; x < Math.min(width, squareX + squareSize); x++) {
          if (x < 0) continue;
          // Texture is fixed to the object, so the object's content travels
          // with it. That makes the true displacement a real -14 px, which a
          // radius of 6 cannot represent.
          const u = x - squareX;
          const v = y - startY;
          const pv = patch[v * width + u];
          dst[y * width + x] = c === 0 ? pv : Math.round(pv * (0.7 + 0.1 * c));
        }
      }
    }
    out.push(frame);
  }
  return { frames: toFrames(out), scenario: 'overshoot' };
}

// Convert raw scenario buffers to Frame instances without importing Frame here
// (keeps this module free of circular imports with image.js).
export function attachFrameClass(sequence, FrameClass) {
  return {
    ...sequence,
    frames: sequence.frames.map((raw) => {
      const frame = new FrameClass(raw.width, raw.height, raw.components);
      for (let c = 0; c < raw.components; c++) frame.planes[c].set(raw.buffers[c]);
      return frame;
    }),
  };
}
