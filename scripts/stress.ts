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
  assertStressArtifact,
  latencySummary,
  runtime,
  type StressArtifact,
} from './artifact-schema.js';

const rounds = Number(process.env.REVEAL_STRESS_ROUNDS ?? 500);
const workloadSeed = 0x5eed_2026;
const latencies: number[] = [];
const accepted: Record<string, number> = {};
const rejected: Record<string, number> = {};
const digest = createHash('sha256');
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
function record(receipt: Receipt): void {
  count(accepted, receipt.action);
  digest.update(
    [
      receipt.commandFingerprint,
      receipt.action,
      String(receipt.debited),
      String(receipt.credited),
      String(receipt.frameRevision),
    ].join('|'),
  );
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
  schema: 'reveal-engine/stress-v2',
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
  correctnessDigest: digest.digest('hex'),
  thresholds,
  status,
  runtime: runtime(),
};
assertStressArtifact(artifact);

/**
 * Compares the correctness digest against the committed baseline.
 *
 * The digest hashes every receipt and every final snapshot in the workload, so
 * it is the strongest replay anchor in the repository — and it was previously
 * printed and never checked. Timings are machine-dependent and stay
 * informational; the digest is not, and a mismatch on the same workload seed and
 * round count fails the run.
 */
const BASELINE_PATH = 'artifacts/stress-v2.json';
if (existsSync(BASELINE_PATH)) {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as StressArtifact;
  if (baseline.workloadSeed === workloadSeed && baseline.rounds === rounds) {
    if (baseline.correctnessDigest !== artifact.correctnessDigest) {
      console.error(
        `Stress correctness digest drifted from ${BASELINE_PATH}:\n` +
          `  baseline ${baseline.correctnessDigest}\n` +
          `  current  ${artifact.correctnessDigest}\n` +
          'Replay-visible behaviour changed. Make a version decision, then run npm run artifacts:update.',
      );
      process.exitCode = 1;
    }
  } else {
    console.error(
      `Skipped digest comparison: baseline workload is ${baseline.rounds} rounds at seed ${baseline.workloadSeed}.`,
    );
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
