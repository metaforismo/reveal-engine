import { writeFileSync, mkdirSync } from 'node:fs';
import { constellationReference, initialPosterior, RoundBook } from '../src/index.js';
const rounds = 200;
const starts = performance.now();
let credits = 0n;
for (let i = 0; i < rounds; i += 1) {
  const book = new RoundBook(constellationReference, initialPosterior(constellationReference));
  const [a, b] = await Promise.all([
    book.open({ idempotencyKey: `open-${i}`, expectedRevision: 0, outcome: i % 3, stake: 1000n }),
    book.open({ idempotencyKey: `open-${i}`, expectedRevision: 0, outcome: i % 3, stake: 1000n }),
  ]);
  if (a.revision !== b.revision) throw new Error('idempotency failure');
  const result = await book.settle(`settle-${i}`, i % 3);
  credits += result.credited;
}
const elapsedMs = performance.now() - starts;
if (elapsedMs > 10_000) throw new Error(`Stress threshold exceeded: ${elapsedMs}ms`);
mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/stress.json',
  JSON.stringify({ rounds, elapsedMs, credits: credits.toString(), thresholdMs: 10000 }, null, 2),
);
console.log(`stress: ${rounds} rounds in ${elapsedMs.toFixed(1)}ms`);
