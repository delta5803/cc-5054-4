// Failure-sample reducer.
//
// Delta-debugging style shrinking for lab failure cases. Given a builder that
// reproduces a fault on a geometry and a predicate that recognises the same
// fault mechanism, the reducer tries smaller pictures and smaller
// displacements greedily. The predicate is fault-specific: shrinking is only
// accepted while the original failure mechanism (wrong reference id versus
// early rounding) and its observable signature survive. A reduced case that
// "passes" is rejected even when it is smaller.

import { buildTwinRefFixture } from './fixture.js';
import { applyFault, FAULT_WRONG_REFERENCE, FAULT_EARLY_ROUNDING } from './faults.js';

// Geometry grid, smallest first so the first accepted case is the minimal one.
const GEOMETRIES = [
  { width: 16, height: 16, bx: 1, by: 1 },
  { width: 24, height: 24, bx: 1, by: 1 },
  { width: 24, height: 32, bx: 1, by: 1 },
  { width: 32, height: 32, bx: 2, by: 2 },
];

const DISPLACEMENTS = [
  { hmvx: -3, hmvy: -3 }, // odd/odd: early rounding stays observable
  { hmvx: -5, hmvy: -3 },
  { hmvx: -7, hmvy: -5 },
];

function defaultPredicate(fault) {
  return (fixture) => {
    const packet = applyFault(fixture, fault);
    if (packet.sse === 0 || packet.firstMismatch === null) return false;
    if (fault === FAULT_WRONG_REFERENCE) {
      return packet.channels.refIdChanged && !packet.channels.vectorChanged;
    }
    if (fault === FAULT_EARLY_ROUNDING) {
      // Early rounding can only diverge for a fraction on both axes, i.e. an
      // odd half-pel component in x and y, and must leave syntax untouched.
      const diagonal = fixture.hmvx % 2 !== 0 && fixture.hmvy % 2 !== 0;
      return (
        diagonal &&
        packet.channels.interpolatorChanged &&
        !packet.channels.refIdChanged &&
        !packet.channels.vectorChanged &&
        !packet.channels.residualChanged
      );
    }
    return false;
  };
}

// Reduce one fault. Returns the smallest accepted case plus a log of every
// attempt, so a test can assert the mechanism field never changed along the
// way.
export function reduceFaultSample(fault, { seed = 11, predicate = null } = {}) {
  const keepsFault = predicate || defaultPredicate(fault);
  const attempts = [];
  let accepted = null;

  geometryLoop: for (const geometry of GEOMETRIES) {
    for (const displacement of DISPLACEMENTS) {
      const params = { ...geometry, ...displacement, seed };
      const fixture = buildTwinRefFixture(params);
      const packet = applyFault(fixture, fault);
      const ok = keepsFault(fixture, packet);
      const attempt = {
        params,
        ok,
        sse: packet.sse,
        firstMismatch: packet.firstMismatch ? { ...packet.firstMismatch } : null,
        mechanism: packet.kind,
        channels: { ...packet.channels },
      };
      attempts.push(attempt);
      if (ok) {
        accepted = { fixture, packet, attempt, params };
        break geometryLoop;
      }
    }
  }

  if (!accepted) {
    throw new Error(`reducer could not shrink ${fault} while preserving its mechanism`);
  }
  return {
    fault,
    minimal: accepted.params,
    fixture: accepted.fixture,
    packet: accepted.packet,
    attempts,
    originalMechanism: fault,
    preserved: attempts
      .filter((a) => a.ok)
      .every((a) => a.mechanism === fault && a.sse > 0 && a.firstMismatch !== null),
  };
}

// Convenience used by tests and the CLI: show that reduction changed the
// picture/displacement size but not the fault's signature.
export function summariseReduction(result) {
  return {
    fault: result.fault,
    minimalGeometry: {
      width: result.minimal.width,
      height: result.minimal.height,
      hmvx: result.minimal.hmvx,
      hmvy: result.minimal.hmvy,
    },
    mechanismPreserved: result.preserved,
    firstMismatch: result.packet.firstMismatch,
    sse: result.packet.sse,
    attempts: result.attempts.length,
  };
}
