import { writeFileSync, mkdirSync } from 'node:fs';
import { blackSignalReference, makeTranscript, posteriorFor } from '../src/index.js';
const samples = 100;
const starts = performance.now();
let events = 0;
for (let i = 0; i < samples; i += 1) {
  const tx = makeTranscript(
    `${i.toString(16).padStart(2, '0').repeat(32)}`,
    blackSignalReference,
    `bench-${i}`,
    i % 4,
  );
  posteriorFor(blackSignalReference, tx.evidence);
  events += tx.evidence.length;
}
const elapsedMs = performance.now() - starts;
const artifact = {
  schema: 'reveal-engine-benchmark/v1',
  samples,
  events,
  elapsedMs,
  eventsPerSecond: events / (elapsedMs / 1000),
  thresholdMs: 5000,
  status: elapsedMs <= 5000 ? 'pass' : 'fail',
};
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/benchmark.json', JSON.stringify(artifact, null, 2));
if (artifact.status !== 'pass') throw new Error('Benchmark threshold exceeded');
console.log(JSON.stringify(artifact));
