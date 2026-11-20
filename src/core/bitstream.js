// MSB-first bit reader/writer with strict bounds checking. All BMPP-1 fields
// live in this layer so the byte layout stays in one place.

export class FormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FormatError';
  }
}

export class BitWriter {
  constructor() {
    this.bytes = [];
    this.current = 0;
    this.filled = 0;
    this.length = 0;
  }

  write(value, bits) {
    if (bits < 0 || bits > 32 || !Number.isInteger(bits)) {
      throw new RangeError(`invalid bit count ${bits}`);
    }
    if (value < 0 || value >= 2 ** bits) {
      throw new RangeError(`value ${value} does not fit in ${bits} bits`);
    }
    for (let i = bits - 1; i >= 0; i--) {
      this.current = (this.current << 1) | ((value >>> i) & 1);
      this.filled += 1;
      this.length += 1;
      if (this.filled === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.filled = 0;
      }
    }
  }

  writeSigned(value, bits) {
    const half = 2 ** (bits - 1);
    if (value < -half || value >= half) {
      throw new RangeError(`value ${value} does not fit in signed ${bits} bits`);
    }
    this.write(value < 0 ? value + 2 ** bits : value, bits);
  }

  // Byte-aligned raw bytes; only legal when no partial byte is pending, so
  // the reader can rely on fixed offsets for the ISO-8859-1 header text.
  writeBytes(bytes) {
    if (this.filled !== 0) {
      throw new Error('writeBytes requires byte alignment');
    }
    for (const b of bytes) {
      if (!Number.isInteger(b) || b < 0 || b > 255) {
        throw new RangeError(`invalid byte ${b}`);
      }
      this.bytes.push(b);
    }
    this.length += bytes.length * 8;
  }

  alignToByte() {
    while (this.filled !== 0) this.write(0, 1);
  }

  toUint8Array() {
    if (this.filled !== 0) {
      throw new Error('bitstream not byte aligned');
    }
    return Uint8Array.from(this.bytes);
  }
}

export class BitReader {
  constructor(bytes, offset = 0) {
    this.bytes = bytes;
    this.offset = offset; // byte offset where payload starts
    this.pos = offset * 8;
    this.limit = bytes.length * 8;
  }

  get bitPosition() {
    return this.pos;
  }

  get bytePosition() {
    return Math.ceil(this.pos / 8);
  }

  read(bits) {
    if (bits < 0 || bits > 32 || !Number.isInteger(bits)) {
      throw new RangeError(`invalid bit count ${bits}`);
    }
    if (this.pos + bits > this.limit) {
      throw new FormatError('truncated bitstream');
    }
    let value = 0;
    for (let i = 0; i < bits; i++) {
      const byteIndex = this.pos >> 3;
      const bitIndex = 7 - (this.pos & 7);
      value = (value << 1) | ((this.bytes[byteIndex] >> bitIndex) & 1);
      this.pos += 1;
    }
    return value;
  }

  readSigned(bits) {
    const raw = this.read(bits);
    const half = 2 ** (bits - 1);
    return raw >= half ? raw - 2 ** bits : raw;
  }

  readBytes(count) {
    if (this.pos % 8 !== 0) throw new FormatError('readBytes requires byte alignment');
    const start = this.pos / 8;
    if (start + count > this.bytes.length) throw new FormatError('truncated byte field');
    const out = this.bytes.slice(start, start + count);
    this.pos += count * 8;
    return out;
  }

  alignToByte() {
    const rem = this.pos % 8;
    if (rem !== 0) this.pos += 8 - rem;
    if (this.pos > this.limit) throw new FormatError('truncated alignment padding');
  }
}

// Elias gamma code for a positive integer n >= 1:
//   floor(log2(n)) zero bits, then n itself in floor(log2(n))+1 bits.
// It is prefix-free and unambiguous, unlike a bare "unary prefix + value"
// variant. Motion-vector magnitudes and the signed mapping on top of this code
// are defined in mvcode.js.
export const GAMMA_MAX_N = 2 ** 14 - 1;

export function gammaBits(n) {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`gamma needs a positive integer, got ${n}`);
  }
  const len = Math.floor(Math.log2(n));
  return 2 * len + 1;
}

export function writeGamma(writer, n) {
  if (!Number.isInteger(n) || n < 1 || n > GAMMA_MAX_N) {
    throw new RangeError(`gamma value ${n} out of supported range`);
  }
  const len = Math.floor(Math.log2(n));
  writer.write(0, len);
  writer.write(n, len + 1);
}

export function readGamma(reader) {
  let len = 0;
  while (reader.read(1) === 0) {
    len += 1;
    if (len >= 14) throw new FormatError('gamma code too long');
  }
  if (len === 0) return 1;
  return 2 ** len + reader.read(len);
}
