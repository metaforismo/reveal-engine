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
  schema: 'reveal-engine/benchmark-v2',
  evidenceClass: 'synthetic-local-or-ci',
  samples,
  events,
  elapsedMs,
  eventsPerSecond,
  latency,
  correctnessDigest: digest.digest('hex'),
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
