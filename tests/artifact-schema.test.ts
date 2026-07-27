import { describe, expect, it } from 'vitest';
import { assertBenchmarkArtifact, assertStressArtifact } from '../scripts/artifact-schema.js';
describe('artifact schemas', () => {
  it('rejects incomplete machine-readable evidence', () => {
    expect(() => assertStressArtifact({ schema: 'reveal-engine/stress-v2' } as never)).toThrow();
    expect(() =>
      assertBenchmarkArtifact({ schema: 'reveal-engine/benchmark-v2' } as never),
    ).toThrow();
  });
});
