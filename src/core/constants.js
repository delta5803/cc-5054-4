// Shared constants for the BMPP-1 ("Block Motion Prediction, profile 1")
// experimental bitstream. Every value here is normative for the encoder and
// the decoder alike; nothing in this file may depend on the host platform.

export const MAGIC = [0x42, 0x4d, 0x50, 0x50]; // "BMPP"
export const VERSION = 1;
export const HEADER_SIZE = 32;

export const BLOCK = 8;
export const BLOCK_PIXELS = BLOCK * BLOCK;

export const MODE_INTRA = 0;
export const MODE_INTER = 1;

export const MV_MIN = -255;
export const MV_MAX = 255;

export const MAX_DIM = 1920;
export const MAX_FRAMES = 4096;

// Quantiser step per QP (0..51), floored to integers so that encoder and
// decoder agree bit-for-bit on every platform.
export const QSTEP = [
  1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 6, 6, 7, 8, 9, 10, 11, 13, 14,
  16, 18, 20, 23, 25, 29, 32, 36, 40, 45, 51, 57, 64, 72, 81, 91, 102, 114, 128,
  144, 161, 181, 203, 228, 256, 287, 323, 362,
];

// Dead-zone divisor: coefficients with |c| < 0.75*step are zeroed.
export const DEADZONE_DIVISOR = 4;

// Interleaved 8x8 zig-zag order, given as raster indices.
export const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48,
  41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22,
  15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
];

export const MAX_COEF_PAIRS = 15;
export const COEF_ZERO_RUN_BITS = 4;
// 13 signed bits cover the full forward-DCT range for 8-bit residuals
// (worst-case coefficient for this basis is 2062).
export const COEF_MAG_BITS = 13;

export const QP_BITS = 6;

export const SEARCH_STRATEGIES = Object.freeze({
  FULL: 'full',
  SPIRAL: 'spiral',
  DIAMOND: 'diamond',
});

export const SEARCH_LABELS = Object.freeze({
  full: '全搜索 Full',
  spiral: '同心螺旋 Spiral',
  diamond: '菱形细化 Diamond',
});

export const STRATEGY_NOTES = Object.freeze({
  full: '穷举搜索窗内全部候选，SAD 理论最优但计算量最大，作为率失真基准。',
  spiral: '由内向外同心环扫描，命中近完美匹配后提前停止，速度优先。',
  diamond: '大步长菱形粗定位、小步长细化、±1 精修，计算量居中。',
});
