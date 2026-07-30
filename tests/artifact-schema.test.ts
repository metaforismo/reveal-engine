import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assertBenchmarkArtifact,
  assertStressArtifact,
  compareBenchmarkDrift,
  compareModuleDigests,
} from '../scripts/artifact-schema.js';
describe('artifact schemas', () => {
  it('rejects incomplete machine-readable evidence', () => {
    expect(() => assertStressArtifact({ schema: 'reveal-engine/stress-v3' } as never)).toThrow();
    expect(() =>
      assertBenchmarkArtifact({ schema: 'reveal-engine/benchmark-v3' } as never),
    ).toThrow();
  });

  it('accepts the tracked reproducible baselines', () => {
    const read = (name: string): unknown =>
      JSON.parse(readFileSync(new URL(`../artifacts/${name}`, import.meta.url), 'utf8')) as unknown;
    expect(() => assertStressArtifact(read('stress-v3.json'))).not.toThrow();
    expect(() => assertBenchmarkArtifact(read('benchmark-v3.json'))).not.toThrow();
  });

  it('anchors every shipped module and refuses an artifact that anchors none', () => {
    const read = (name: string): { moduleDigests: Record<string, string> } =>
      JSON.parse(readFileSync(new URL(`../artifacts/${name}`, import.meta.url), 'utf8')) as {
        moduleDigests: Record<string, string>;
      };
    // The point of the `-v3` schema: a repository with two lifecycle modules
    // needs one replay anchor each. A baseline that dropped one would otherwise
    // still pass every gate while proving nothing about the module it dropped.
    for (const name of ['stress-v3.json', 'benchmark-v3.json'])
      expect(Object.keys(read(name).moduleDigests).sort(), name).toEqual([
        'progressive-market',
        'staged-survival',
      ]);
    const stress = read('stress-v3.json') as unknown as Record<string, unknown>;
    for (const broken of [{}, { 'staged-survival': 'not-a-digest' }])
      expect(() => assertStressArtifact({ ...stress, moduleDigests: broken })).toThrow();
  });

  it('compares replay anchors in both directions', () => {
    // The gate reads the union of both key sets. Comparing only the baseline's
    // keys would leave a module the baseline does not anchor completely ungated;
    // comparing only the run's would let a dropped module retire its own anchor.
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(compareModuleDigests({ market: a, survival: b }, { market: a, survival: b })).toEqual(
      [],
    );
    expect(compareModuleDigests({ market: a }, { market: b })).toEqual([
      `  market: baseline ${a}, current ${b}`,
    ]);
    expect(compareModuleDigests({ market: a, survival: b }, { market: a })).toEqual([
      `  survival: baseline ${b}, current (absent from this run)`,
    ]);
    expect(compareModuleDigests({ market: a }, { market: a, survival: b })).toEqual([
      `  survival: baseline (not anchored by the baseline), current ${b}`,
    ]);
  });

  it('compares benchmark CPU cost and CPU throughput within the declared drift band', () => {
    const baseline = { cpuMs: 100, eventsPerCpuSecond: 1_000 };
    expect(
      compareBenchmarkDrift(baseline, { cpuMs: 120, eventsPerCpuSecond: 800 }, 0.2),
    ).toEqual([]);
    expect(
      compareBenchmarkDrift(baseline, { cpuMs: 121, eventsPerCpuSecond: 790 }, 0.2).map((line) =>
        line.trim().split(':')[0],
      ),
    ).toEqual(['cpuMs', 'eventsPerCpuSecond']);
  });

  /**
   * The regression that keeps the gate honest about what it measures.
   *
   * Wall clock is recorded but must never be gated. This synthetic pair models
   * identical CPU cost under very different scheduler delay; if a future
   * revision reintroduces wall clock into the drift comparison, this fails.
   */
  it('ignores wall-clock spread that leaves CPU cost unchanged', () => {
    const quiet = { cpuMs: 4_250, eventsPerCpuSecond: 12_400, elapsedMs: 3_720 };
    const starved = { cpuMs: 4_310, eventsPerCpuSecond: 12_270, elapsedMs: 298_410 };
    expect(compareBenchmarkDrift(quiet, starved, 0.2)).toEqual([]);
  });
});
