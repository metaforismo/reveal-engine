import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  makeTranscript,
  verifyTranscriptDetailed,
} from '../src/modules/progressive-market/fairness.js';
import { posteriorFor } from '../src/modules/progressive-market/posterior.js';
import {
  binaryBeaconReference,
  blackSignalReference,
  constellationReference,
} from '../src/modules/progressive-market/references/index.js';
import { serializeTranscript } from '../src/modules/progressive-market/transcript.js';
import {
  contractMenu,
  deriveSteps,
  deriveTruth,
  fiveRunnerReference,
  makeTranscript as makeSurvivalTranscript,
  oracleTrialReference,
  roundRefId,
  serializeTranscript as serializeSurvivalTranscript,
  stagedSurvival,
  type SurvivalChoice,
  type SurvivalDefinition,
  type SurvivalTruth,
} from '../src/modules/staged-survival/index.js';
import {
  assertBenchmarkArtifact,
  latencySummary,
  runtime,
  type BenchmarkArtifact,
} from './artifact-schema.js';

const games = [blackSignalReference, constellationReference, binaryBeaconReference];
const samples = Number(process.env.REVEAL_BENCH_SAMPLES ?? 1200);
for (let warmup = 0; warmup < 50; warmup += 1)
  makeTranscript(
    warmup.toString(16).padStart(64, '0'),
    games[warmup % games.length]!,
    `warmup-${warmup}`,
  );
const latencies: number[] = [];
const digest = createHash('sha256');
const survivalDigest = createHash('sha256');
let events = 0;
const started = performance.now();
for (let index = 0; index < samples; index += 1) {
  const game = games[index % games.length]!;
  const seed = (BigInt(index) + 1000n).toString(16).padStart(64, '0');
  const start = performance.now();
  const transcript = makeTranscript(seed, game, `benchmark-${index}`);
  const posterior = posteriorFor(game, transcript.evidence);
  const wire = serializeTranscript(transcript);
  const verification = verifyTranscriptDetailed(seed, game, wire);
  latencies.push(performance.now() - start);
  events += transcript.evidence.length;
  if (!verification.ok) throw new Error(`Benchmark verification failed: ${verification.code}`);
  digest.update(transcript.commitment).update(String(posterior.total));
}

/**
 * The staged-survival build-and-verify path.
 *
 * The comparable unit of work is one *stage*, not one round, so a survival
 * sample counts its steps into `events` exactly as a market sample counts its
 * evidence frames. Each sample rides the whole ladder with the first contract
 * the shrinking menu offers, which is the deepest path a round can take and
 * therefore the one that consumes the most of the tape.
 */
const survivalGames: readonly SurvivalDefinition[] = [fiveRunnerReference, oracleTrialReference];
const survivalSamples = Math.max(1, Math.floor(samples / 4));
function ridePath(game: SurvivalDefinition, truth: SurvivalTruth): SurvivalChoice[] {
  const choices: SurvivalChoice[] = [];
  let live = game.entities;
  for (let stage = 0; stage < game.stages && live > 0; stage += 1) {
    const menu = contractMenu(game, live);
    if (menu.length === 0) break;
    choices.push({ contractId: menu[0]!.id, banked: [] });
    live = (deriveSteps(game, truth, choices)[stage]?.survivors ?? []).length;
  }
  return choices;
}
for (let index = 0; index < survivalSamples; index += 1) {
  const game = survivalGames[index % survivalGames.length]!;
  const seed = (BigInt(index) + 5000n).toString(16).padStart(64, '0');
  const roundId = roundRefId({
    roundId: `benchmark-${index}`,
    clientEntropy: BigInt(index + 1)
      .toString(16)
      .padStart(64, '0'),
  });
  const start = performance.now();
  const choices = ridePath(game, deriveTruth(seed, game, roundId));
  const transcript = makeSurvivalTranscript(seed, game, roundId, choices);
  const wire = serializeSurvivalTranscript(transcript);
  const verification = stagedSurvival.verify(seed, game, wire);
  latencies.push(performance.now() - start);
  events += transcript.steps.length;
  if (!verification.ok) throw new Error(`Survival verification failed: ${verification.code}`);
  survivalDigest.update(transcript.commitment).update(transcript.tapeDigest);
}
const elapsedMs = performance.now() - started;
const latency = latencySummary(latencies);
const eventsPerSecond = events / (elapsedMs / 1000);
const thresholds = { elapsedMs: 20_000, p99Ms: 50, minimumEventsPerSecond: 2_000 };
const status =
  elapsedMs <= thresholds.elapsedMs &&
  latency.p99Ms <= thresholds.p99Ms &&
  eventsPerSecond >= thresholds.minimumEventsPerSecond
    ? 'pass'
    : 'fail';
const artifact: BenchmarkArtifact = {
  schema: 'reveal-engine/benchmark-v3',
  evidenceClass: 'synthetic-local-or-ci',
  // Every measured sample, market and survival alike: `events` and the latency
  // summary already cover both, and a count that covered only one would make the
  // per-sample figures unreadable.
  samples: samples + survivalSamples,
  events,
  elapsedMs,
  eventsPerSecond,
  latency,
  moduleDigests: {
    'progressive-market': digest.digest('hex'),
    'staged-survival': survivalDigest.digest('hex'),
  },
  thresholds,
  status,
  runtime: runtime(),
};
assertBenchmarkArtifact(artifact);
const outputFlag = process.argv.indexOf('--output');
if (outputFlag >= 0 && process.argv[outputFlag + 1]) {
  const path = process.argv[outputFlag + 1]!;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
}
console.log(JSON.stringify(artifact));
if (status !== 'pass') process.exitCode = 1;
