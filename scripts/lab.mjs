#!/usr/bin/env node
// Headless entry point for the fault-injection lab. The lab itself is a set of
// library modules under src/lab; this command only prints deterministic
// reports so the failure packets, reducer output and replay traces can be
// inspected without a browser.

import { buildTwinRefFixture, buildAliasFixture, buildSplitTileFixture } from '../src/lab/fixture.js';
import {
  applyFault,
  packetForAlias,
  FAULT_WRONG_REFERENCE,
  FAULT_EARLY_ROUNDING,
} from '../src/lab/faults.js';
import { ReferenceStore } from '../src/lab/refstore.js';
import { TileAssembler } from '../src/lab/assembler.js';
import { decodeTile } from '../src/lab/tile.js';
import { classifyPacket, similarPixelError, classifyAlias } from '../src/lab/diagnose.js';
import { reduceFaultSample, summariseReduction } from '../src/lab/reducer.js';
import { replayPacket, replayAliasPropagation, isEquivalentReconstruction } from '../src/lab/replay.js';

function storeFrom(fixture) {
  const store = new ReferenceStore();
  for (const [id, frame] of fixture.refs) store.add(id, frame);
  return store;
}

function cmdFaults() {
  const fixture = buildTwinRefFixture();
  const packets = [
    applyFault(fixture, FAULT_WRONG_REFERENCE),
    applyFault(fixture, FAULT_EARLY_ROUNDING),
  ];
  console.log(`twin-reference fixture: block (${fixture.bx},${fixture.by}), half-pel vector (${fixture.hmvx},${fixture.hmvy})`);
  console.log(`occluder value ${fixture.occluderValue}, rects ${JSON.stringify(fixture.rects)}`);
  for (const packet of packets) {
    console.log('---');
    console.log(`fault: ${packet.kind} -> channel ${classifyPacket(packet)}`);
    console.log(`  written refId=${packet.written.refId} hmv=(${packet.written.hmvx},${packet.written.hmvy})`);
    console.log(`  sse=${packet.sse} sad=${packet.sad} differingPixels=${packet.differingPixels}`);
    console.log(`  firstMismatch=${JSON.stringify(packet.firstMismatch)}`);
    console.log(`  channels=${JSON.stringify(packet.channels)}`);
  }
  console.log('---');
  console.log(`similar pixel error (within 4x band): ${similarPixelError(packets[0], packets[1])}`);
}

function cmdReduce() {
  for (const fault of [FAULT_WRONG_REFERENCE, FAULT_EARLY_ROUNDING]) {
    const summary = summariseReduction(reduceFaultSample(fault));
    console.log(`${fault}:`, JSON.stringify(summary));
  }
}

function cmdReplay() {
  const fixture = buildTwinRefFixture();
  const store = storeFrom(fixture);
  for (const fault of [FAULT_WRONG_REFERENCE, FAULT_EARLY_ROUNDING]) {
    const trace = replayPacket(applyFault(fixture, fault), store);
    console.log(`--- replay ${trace.kind} block (${trace.block.bx},${trace.block.by})`);
    for (const step of trace.steps) {
      if (step.step === 'compare-pixels') {
        const bad = step.pixelSteps.filter((p) => p.differs).length;
        console.log(`  step ${step.step}: ${bad} differing pixels, first=${JSON.stringify(step.firstMismatch)}`);
      } else if (step.step === 'apply-residual') {
        console.log(`  step ${step.step}: reconstructed block ready`);
      } else {
        console.log(`  step ${step.step}: ${step.note}`);
      }
    }
  }
}

function cmdTiles() {
  const fixture = buildSplitTileFixture();
  const assembler = new TileAssembler({ width: fixture.width, height: fixture.height });
  const a = assembler.ingest(fixture.tiles[1].bytes, fixture.tiles[1].coords);
  const b = assembler.ingest(fixture.tiles[2].bytes, fixture.tiles[2].coords);
  console.log(`first motion block ${JSON.stringify(fixture.firstMotionBlock)} is on tile ${fixture.tiles[2].tileIndex}`);
  console.log(`tile 1 -> missing refs ${JSON.stringify(a.missingRefs)}, suspended ${a.suspended}, decoded ${a.decoded}`);
  console.log(`tile 2 -> missing refs ${JSON.stringify(b.missingRefs)}, suspended ${b.suspended}, decoded ${b.decoded}`);
  const refStore = new ReferenceStore();
  const refResult = decodeTile(fixture.tiles[0].bytes, fixture.tiles[0].coords, refStore);
  assembler.registerReference(0, refResult.frame);
  const { resumed, stillSuspended } = assembler.resumePending();
  console.log(`after reference arrival: resumed ${resumed.length}, still suspended ${stillSuspended.length}, complete=${assembler.isComplete()}`);
}

function cmdAlias() {
  const fixture = buildAliasFixture();
  const store = storeFrom(fixture);
  for (const candidate of fixture.candidates) {
    const verdict = classifyAlias(fixture, candidate.name);
    const packet = packetForAlias(fixture, candidate.name);
    console.log(`--- ${candidate.name}: ${verdict.conclusion}`);
    console.log(`  tuple refId=${packet.written.refId} hmv=(${packet.written.hmvx},${packet.written.hmvy}), current pixels match=${packet.currentPixelsMatch}`);
    console.log(`  next-frame chain residual energy=${verdict.chainResidualEnergy}, stale-R1 energy=${verdict.staleResidualEnergy}`);
  }
  const [c0, c1] = fixture.candidates;
  const equivalent = isEquivalentReconstruction(
    store,
    { refId: c0.refId, hmvx: c0.hmvx, hmvy: c0.hmvy },
    { refId: c1.refId, hmvx: c1.hmvx, hmvy: c1.hmvy },
    fixture.bx,
    fixture.by,
    fixture.currentBlock,
  );
  console.log('---');
  console.log(`different tuples, equivalent legal reconstruction: ${equivalent.legal}`);
  const propagation = replayAliasPropagation(fixture);
  console.log(`drift starts at ${JSON.stringify(propagation.driftStartsAt)}`);
}

const USAGE = `BMPP lab fault-injection reports

  lab faults   two similar-magnitude faults on the twin-reference fixture
  lab reduce   shrink each failure case while preserving its mechanism
  lab replay   step-by-step replay traces from the failure packets
  lab tiles    split-tile arrival, suspension, missing-ref report and resume
  lab alias    equivalent vectors, legal alternative vs later drift
`;

const [command] = process.argv.slice(2);
switch (command) {
  case 'faults':
    cmdFaults();
    break;
  case 'reduce':
    cmdReduce();
    break;
  case 'replay':
    cmdReplay();
    break;
  case 'tiles':
    cmdTiles();
    break;
  case 'alias':
    cmdAlias();
    break;
  default:
    process.stdout.write(USAGE);
    process.exitCode = command ? 2 : 0;
}
