import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  compareBenchmarkDrift,
  compareModuleDigests,
  latencySummary,
  runtime,
  type BenchmarkArtifact,
} from './artifact-schema.js';

const BASELINE_PATH = 'artifacts/benchmark-v3.json';
const outputFlag = process.argv.indexOf('--output');
const outputPath = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined;
const updateBaseline = process.argv.includes('--update-baseline');
if (updateBaseline && outputPath !== BASELINE_PATH)
  throw new Error(`--update-baseline requires --output ${BASELINE_PATH}`);

let baseline: BenchmarkArtifact | undefined;
if (!updateBaseline) {
  if (!existsSync(BASELINE_PATH))
    throw new Error(
      `Benchmark baseline is missing at ${BASELINE_PATH}. Run npm run artifacts:update.`,
    );
  const value: unknown = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  assertBenchmarkArtifact(value);
  if (value.status !== 'pass')
    throw new Error(
      `Benchmark baseline at ${BASELINE_PATH} is not a passing baseline. Run npm run artifacts:update.`,
    );
  baseline = value;
}

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
// CPU time is what the gate judges; wall clock is recorded alongside it. This
// keeps scheduler contention visible without mistaking work done by other
// processes for work newly done by this benchmark.
const cpuStarted = process.cpuUsage();
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
const cpuUsage = process.cpuUsage(cpuStarted);
const cpuMs = (cpuUsage.user + cpuUsage.system) / 1000;
const latency = latencySummary(latencies);
const eventsPerSecond = events / (elapsedMs / 1000);
const eventsPerCpuSecond = events / (cpuMs / 1000);
const thresholds = baseline?.thresholds ?? { maxRelativeDrift: 0.2 };
const draft = {
  schema: 'reveal-engine/benchmark-v3',
  evidenceClass: 'synthetic-local-or-ci',
  // Every measured sample, market and survival alike: `events` and the latency
  // summary already cover both, and a count that covered only one would make the
  // per-sample figures unreadable.
  samples: samples + survivalSamples,
  events,
  elapsedMs,
  cpuMs,
  eventsPerSecond,
  eventsPerCpuSecond,
  latency,
  moduleDigests: {
    'progressive-market': digest.digest('hex'),
    'staged-survival': survivalDigest.digest('hex'),
  },
  thresholds,
  status: 'pass',
  runtime: runtime(),
} satisfies BenchmarkArtifact;
const failures: string[] = [];
if (baseline !== undefined) {
  if (baseline.samples !== draft.samples || baseline.events !== draft.events)
    failures.push(
      `  workload: baseline ${baseline.samples} samples / ${baseline.events} events, ` +
        `current ${draft.samples} samples / ${draft.events} events`,
    );
  failures.push(...compareModuleDigests(baseline.moduleDigests, draft.moduleDigests));
  failures.push(...compareBenchmarkDrift(baseline, draft, thresholds.maxRelativeDrift));
}
const status = failures.length === 0 ? 'pass' : 'fail';
const artifact: BenchmarkArtifact = { ...draft, status };
assertBenchmarkArtifact(artifact);
if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
}
console.log(JSON.stringify(artifact));
if (failures.length > 0)
  console.error(
    `Benchmark drifted from ${BASELINE_PATH} beyond its ` +
      `±${thresholds.maxRelativeDrift * 100}% band:\n${failures.join('\n')}\n` +
      'These anchors are CPU time and replay digests, so a busy machine does not ' +
      'move them; a real workload or algorithmic change does. Confirm the change, ' +
      'then re-take the baseline on a quiet machine with npm run artifacts:update.',
  );
if (status !== 'pass') process.exitCode = 1;
