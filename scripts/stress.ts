import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RevealEngineError } from '../src/api/errors.js';
import {
  makeTranscript,
  verifyTranscriptDetailed,
} from '../src/modules/progressive-market/fairness.js';
import { initialPosterior } from '../src/modules/progressive-market/posterior.js';
import { RoundBook, type Receipt } from '../src/modules/progressive-market/round-book.js';
import {
  binaryBeaconReference,
  constellationReference,
} from '../src/modules/progressive-market/references/index.js';
import {
  serializeTranscript,
  transcriptToWire,
} from '../src/modules/progressive-market/transcript.js';
import {
  SurvivalBook,
  fiveRunnerReference,
  makeTranscript as makeSurvivalTranscript,
  oracleTrialReference,
  roundRefId,
  serializeTranscript as serializeSurvivalTranscript,
  stagedSurvival,
  transcriptToWire as survivalToWire,
  type SurvivalChoice,
  type SurvivalStep,
} from '../src/modules/staged-survival/index.js';
import {
  assertStressArtifact,
  compareModuleDigests,
  latencySummary,
  runtime,
  type StressArtifact,
} from './artifact-schema.js';

const rounds = Number(process.env.REVEAL_STRESS_ROUNDS ?? 500);
const workloadSeed = 0x5eed_2026;
const latencies: number[] = [];
const accepted: Record<string, number> = {};
const rejected: Record<string, number> = {};
/**
 * One digest per module, not one for the run.
 *
 * `progressive-market`'s is built exactly as the `-v2` `correctnessDigest` was,
 * over the same workload in the same order, so it carries the 0.2 value forward
 * and adding a second module to this script cannot disturb it. That separation
 * is the whole reason the artifact schema moved to `-v3`.
 */
const digest = createHash('sha256');
const survivalDigest = createHash('sha256');
let operations = 0;
let maxSnapshotBytes = 0;
let maxTranscriptBytes = 0;
const heapStart = process.memoryUsage().heapUsed;
const started = performance.now();

async function timed<T>(operation: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await operation();
  } finally {
    latencies.push(performance.now() - start);
    operations += 1;
  }
}
function count(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}
interface AnyReceipt {
  readonly commandFingerprint: string;
  readonly action: string;
  readonly debited: bigint;
  readonly credited: bigint;
  readonly frameRevision: number;
}
function fields(receipt: AnyReceipt): string {
  return [
    receipt.commandFingerprint,
    receipt.action,
    String(receipt.debited),
    String(receipt.credited),
    String(receipt.frameRevision),
  ].join('|');
}
function record(receipt: Receipt): void {
  count(accepted, receipt.action);
  digest.update(fields(receipt));
}
/** The same construction against the second module's own anchor. */
function recordSurvival(receipt: AnyReceipt): void {
  count(accepted, `survival:${receipt.action}`);
  survivalDigest.update(fields(receipt));
}

for (let round = 0; round < rounds; round += 1) {
  const game = round % 4 === 0 ? constellationReference : binaryBeaconReference;
  const seedHex = ((BigInt(workloadSeed) << 32n) + BigInt(round)).toString(16).padStart(64, '0');
  const transcript = makeTranscript(seedHex, game, `stress-${round}`);
  maxTranscriptBytes = Math.max(
    maxTranscriptBytes,
    Buffer.byteLength(serializeTranscript(transcript)),
  );
  let book = new RoundBook(game, initialPosterior(game));
  const pick = round % 3 === 0 ? transcript.truth : (transcript.truth + 1) % game.outcomes.length;
  const duplicate = await timed(() =>
    Promise.all([
      book.open({
        idempotencyKey: `open-${round}`,
        expectedFrameRevision: 0,
        outcome: pick,
        stake: 1000n,
      }),
      book.open({
        idempotencyKey: `open-${round}`,
        expectedFrameRevision: 0,
        outcome: pick,
        stake: 1000n,
      }),
    ]),
  );
  record(duplicate[0]);
  count(accepted, 'duplicate-replay');
  for (const event of transcript.evidence) {
    await timed(() => book.advanceFrame(event));
    count(accepted, 'frame');
    if (event.index === 0) {
      try {
        await timed(() =>
          book.sell({ idempotencyKey: `stale-${round}`, expectedFrameRevision: 0 }),
        );
      } catch (error) {
        count(rejected, error instanceof RevealEngineError ? error.code : 'UNKNOWN');
      }
    }
    if (event.index + 1 === Math.ceil(transcript.evidence.length / 2) && round % 3 === 0) {
      const sold = await timed(() =>
        book.sell({ idempotencyKey: `sell-${round}`, expectedFrameRevision: book.frame.revision }),
      );
      record(sold);
      if (sold.credited > 0n) {
        const reopened = await timed(() =>
          book.open({
            idempotencyKey: `reopen-${round}`,
            expectedFrameRevision: book.frame.revision,
            outcome: transcript.truth,
            stake: sold.credited,
          }),
        );
        record(reopened);
      }
    }
    if (event.index + 1 === Math.ceil(transcript.evidence.length / 2) && round % 10 === 0) {
      const serialized = book.serialize();
      maxSnapshotBytes = Math.max(maxSnapshotBytes, Buffer.byteLength(serialized));
      book = RoundBook.restore(game, serialized);
      count(accepted, 'reconnect');
    }
  }
  if (round % 17 === 0) {
    const wire = transcriptToWire(transcript);
    const tampered = { ...wire, commitment: '00'.repeat(32) };
    const verification = verifyTranscriptDetailed(seedHex, game, tampered);
    if (verification.ok || verification.code !== 'COMMITMENT_MISMATCH')
      throw new Error('Tamper oracle failed');
    count(rejected, verification.code);
  }
  const settlement = await timed(() =>
    book.settle({
      idempotencyKey: `settle-${round}`,
      expectedFrameRevision: book.frame.revision,
      revealedSeed: seedHex,
      transcript,
    }),
  );
  record(settlement);
  const replay = await timed(() =>
    book.settle({
      idempotencyKey: `settle-${round}`,
      expectedFrameRevision: book.frame.revision,
      revealedSeed: seedHex,
      transcript,
    }),
  );
  if (replay.commandFingerprint !== settlement.commandFingerprint)
    throw new Error('Settlement replay mismatch');
  count(accepted, 'duplicate-replay');
  const cap = 1000n * game.risk.maxWinMultiple;
  if (!book.terminal || book.liquidBalance > cap) throw new Error('Terminal/cap invariant failed');
  const finalSnapshot = book.serialize();
  maxSnapshotBytes = Math.max(maxSnapshotBytes, Buffer.byteLength(finalSnapshot));
  digest.update(finalSnapshot);
}

/**
 * The staged-survival workload: bounded load, and a replay anchor of its own.
 *
 * Every round funds the whole field, walks the stage ladder choosing a contract
 * from the live menu *before* each stage resolves, banks a subset at some
 * boundaries, reconnects through a snapshot, settles against the revealed seed,
 * and is held to the round cap. It is deliberately shorter than the market
 * workload — a survival round is a full ladder rather than one open/settle pair,
 * so the operation count per round is several times higher.
 */
const survivalRounds = Math.max(1, Math.floor(rounds / 5));
for (let round = 0; round < survivalRounds; round += 1) {
  const game = round % 3 === 0 ? oracleTrialReference : fiveRunnerReference;
  const seedHex = ((BigInt(workloadSeed) << 40n) + BigInt(round)).toString(16).padStart(64, '0');
  const roundId = roundRefId({
    roundId: `survival-${round}`,
    clientEntropy: BigInt(round + 1)
      .toString(16)
      .padStart(64, '0'),
  });
  let book = new SurvivalBook(game);
  for (let entity = 0; entity < game.entities; entity += 1)
    recordSurvival(await timed(() => book.enter(`enter-${round}-${entity}`, entity, 1_000n)));

  for (let stage = 0; stage < game.stages; stage += 1) {
    if (book.live.length === 0) break;
    if (stage > 0 && round % 2 === 0 && book.live.length > 1) {
      const target = book.live[0] as number;
      recordSurvival(await timed(() => book.bank(`bank-${round}-${stage}`, [target])));
    }
    const menu = book.menu();
    if (menu.length === 0) break;
    const contractId = menu[(round + stage) % menu.length] as string;
    recordSurvival(await timed(() => book.choose(`choose-${round}-${stage}`, contractId)));
    const staged = makeSurvivalTranscript(seedHex, game, roundId, book.choices);
    maxTranscriptBytes = Math.max(
      maxTranscriptBytes,
      Buffer.byteLength(serializeSurvivalTranscript(staged)),
    );
    const step = staged.steps[stage] as SurvivalStep;
    await timed(() => book.resolve(step));
    count(accepted, 'survival:stage');
    if (stage === 0) {
      // Replaying a step for a stage that has already resolved must be refused,
      // not silently applied a second time.
      try {
        await timed(() => book.resolve(step));
      } catch (error) {
        count(rejected, error instanceof RevealEngineError ? error.code : 'UNKNOWN');
      }
      if (round % 4 === 0) {
        const serialized = JSON.stringify(book.snapshot());
        maxSnapshotBytes = Math.max(maxSnapshotBytes, Buffer.byteLength(serialized));
        book = SurvivalBook.restore(game, serialized);
        count(accepted, 'survival:reconnect');
      }
    }
  }

  const proof = makeSurvivalTranscript(
    seedHex,
    game,
    roundId,
    book.choices as readonly SurvivalChoice[],
  );
  if (round % 7 === 0) {
    const wire = survivalToWire(proof) as Record<string, unknown>;
    const verification = stagedSurvival.verify(seedHex, game, {
      ...wire,
      commitment: '00'.repeat(32),
    });
    if (verification.ok || verification.code !== 'COMMITMENT_MISMATCH')
      throw new Error('Survival tamper oracle failed');
    count(rejected, verification.code);
  }
  const settlement = await timed(() => book.settle(`settle-${round}`, seedHex, proof));
  recordSurvival(settlement);
  const replay = await timed(() => book.settle(`settle-${round}`, seedHex, proof));
  if (replay.commandFingerprint !== settlement.commandFingerprint)
    throw new Error('Survival settlement replay mismatch');
  count(accepted, 'survival:duplicate-replay');
  const basis = book.capBasisStake ?? 0n;
  if (!book.terminal || book.liquidBalance > basis * game.risk.maxWinMultiple)
    throw new Error('Survival terminal/cap invariant failed');
  const finalSnapshot = JSON.stringify(book.snapshot());
  maxSnapshotBytes = Math.max(maxSnapshotBytes, Buffer.byteLength(finalSnapshot));
  survivalDigest.update(finalSnapshot);
}

const elapsedMs = performance.now() - started;
const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapStart);
const latency = latencySummary(latencies);
const thresholds = {
  elapsedMs: 30_000,
  p99Ms: 100,
  heapDeltaBytes: 256 * 1024 * 1024,
  snapshotBytes: 8 * 1024 * 1024,
};
const status =
  elapsedMs <= thresholds.elapsedMs &&
  latency.p99Ms <= thresholds.p99Ms &&
  heapDeltaBytes <= thresholds.heapDeltaBytes &&
  maxSnapshotBytes <= thresholds.snapshotBytes
    ? 'pass'
    : 'fail';
const artifact: StressArtifact = {
  schema: 'reveal-engine/stress-v3',
  evidenceClass: 'synthetic-local-or-ci',
  workloadSeed,
  rounds,
  operations,
  elapsedMs,
  throughputOpsPerSecond: operations / (elapsedMs / 1000),
  latency,
  heapDeltaBytes,
  maxSnapshotBytes,
  maxTranscriptBytes,
  accepted,
  rejected,
  moduleDigests: {
    'progressive-market': digest.digest('hex'),
    'staged-survival': survivalDigest.digest('hex'),
  },
  thresholds,
  status,
  runtime: runtime(),
};
assertStressArtifact(artifact);

/**
 * Compares every module's replay anchor against the committed baseline.
 *
 * Each digest hashes every receipt and every final snapshot of that module's
 * workload, so they are the strongest replay anchors in the repository.
 * `compareModuleDigests` reads the union of both key sets, so a module the
 * baseline anchors and this run no longer produces fails just as a changed
 * digest does — dropping a module from the workload would otherwise silently
 * retire its anchor while the run still reported `pass`.
 *
 * The baseline is put through `assertStressArtifact` before it is trusted. A
 * malformed or truncated baseline is a *failure*, not a reason to skip: a gate
 * that quietly stops gating when its own input is broken is not a gate. The only
 * cases that skip are the two honest ones — no baseline committed yet, and a
 * baseline taken at a different workload identity — and each says so.
 */
const BASELINE_PATH = 'artifacts/stress-v3.json';
function readBaseline(path: string): StressArtifact {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assertStressArtifact(value);
  return value;
}
if (!existsSync(BASELINE_PATH)) {
  console.error(`Skipped digest comparison: no baseline at ${BASELINE_PATH}.`);
} else {
  let baseline: StressArtifact | undefined;
  try {
    baseline = readBaseline(BASELINE_PATH);
  } catch (error) {
    console.error(
      `Stress baseline at ${BASELINE_PATH} is not a valid ${artifact.schema} artifact: ` +
        `${(error as Error).message}\n` +
        'Nothing was gated. Run npm run artifacts:update.',
    );
    process.exitCode = 1;
  }
  if (baseline === undefined) {
    // Already reported.
  } else if (baseline.workloadSeed !== workloadSeed || baseline.rounds !== rounds) {
    console.error(
      `Skipped digest comparison: baseline workload is ${baseline.rounds} rounds at seed ${baseline.workloadSeed}.`,
    );
  } else {
    const drift = compareModuleDigests(baseline.moduleDigests, artifact.moduleDigests);
    if (drift.length > 0) {
      console.error(
        `Stress correctness digests drifted from ${BASELINE_PATH}:\n${drift.join('\n')}\n` +
          'Replay-visible behaviour changed. Make a version decision, then run npm run artifacts:update.',
      );
      process.exitCode = 1;
    }
  }
}

const outputFlag = process.argv.indexOf('--output');
if (outputFlag >= 0 && process.argv[outputFlag + 1]) {
  const path = process.argv[outputFlag + 1]!;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
}
console.log(JSON.stringify(artifact));
if (status !== 'pass') process.exitCode = 1;
