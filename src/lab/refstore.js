// Reference picture store with explicit identities for the lab.
//
// The core codec has exactly one implicit reference ("the previous frame").
// The lab needs to reason about *which* reference a block was built from, so
// references are keyed by an explicit numeric id. Two frames may carry
// identical pixels under different ids: `get(id)` returns the right picture,
// while pixel-level comparison alone cannot tell them apart — that is exactly
// the situation the wrong-reference fault exploits.

import { Frame } from '../core/image.js';

export class ReferenceStore {
  constructor() {
    this.frames = new Map();
    this.order = [];
  }

  add(id, frame) {
    if (!Number.isInteger(id) || id < 0) throw new RangeError('reference id must be a non-negative integer');
    if (!(frame instanceof Frame)) throw new TypeError('reference must be a Frame');
    if (!this.frames.has(id)) this.order.push(id);
    this.frames.set(id, frame);
    return this;
  }

  has(id) {
    return this.frames.has(id);
  }

  get(id) {
    const frame = this.frames.get(id);
    if (!frame) {
      const err = new Error(`reference ${id} is not available in the store`);
      err.name = 'MissingReference';
      err.missingRef = id;
      throw err;
    }
    return frame;
  }

  get ids() {
    return this.order.slice();
  }

  get size() {
    return this.frames.size;
  }
}
