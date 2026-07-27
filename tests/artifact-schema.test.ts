import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertBenchmarkArtifact, assertStressArtifact } from '../scripts/artifact-schema.js';
describe('artifact schemas', () => {
  it('rejects incomplete machine-readable evidence', () => {
    expect(() => assertStressArtifact({ schema: 'reveal-engine/stress-v2' } as never)).toThrow();
    expect(() =>
      assertBenchmarkArtifact({ schema: 'reveal-engine/benchmark-v2' } as never),
    ).toThrow();
  });

  it('accepts the tracked reproducible baselines', () => {
    const read = (name: string): unknown =>
      JSON.parse(readFileSync(new URL(`../artifacts/${name}`, import.meta.url), 'utf8')) as unknown;
    expect(() => assertStressArtifact(read('stress-v2.json'))).not.toThrow();
    expect(() => assertBenchmarkArtifact(read('benchmark-v2.json'))).not.toThrow();
  });
});
