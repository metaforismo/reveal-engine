export interface LatencySummary {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}
export interface StressArtifact {
  readonly schema: 'reveal-engine/stress-v2';
  readonly evidenceClass: 'synthetic-local-or-ci';
  readonly workloadSeed: number;
  readonly rounds: number;
  readonly operations: number;
  readonly elapsedMs: number;
  readonly throughputOpsPerSecond: number;
  readonly latency: LatencySummary;
  readonly heapDeltaBytes: number;
  readonly maxSnapshotBytes: number;
  readonly maxTranscriptBytes: number;
  readonly accepted: Readonly<Record<string, number>>;
  readonly rejected: Readonly<Record<string, number>>;
  readonly correctnessDigest: string;
  readonly thresholds: {
    readonly elapsedMs: number;
    readonly p99Ms: number;
    readonly heapDeltaBytes: number;
    readonly snapshotBytes: number;
  };
  readonly status: 'pass' | 'fail';
  readonly runtime: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
    readonly sourceRevision: string;
  };
}
export interface BenchmarkArtifact {
  readonly schema: 'reveal-engine/benchmark-v2';
  readonly evidenceClass: 'synthetic-local-or-ci';
  readonly samples: number;
  readonly events: number;
  readonly elapsedMs: number;
  readonly eventsPerSecond: number;
  readonly latency: LatencySummary;
  readonly correctnessDigest: string;
  readonly thresholds: {
    readonly elapsedMs: number;
    readonly p99Ms: number;
    readonly minimumEventsPerSecond: number;
  };
  readonly status: 'pass' | 'fail';
  readonly runtime: StressArtifact['runtime'];
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}
export function latencySummary(values: readonly number[]): LatencySummary {
  return {
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: Math.max(0, ...values),
  };
}
export function assertStressArtifact(value: StressArtifact): void {
  if (
    value.schema !== 'reveal-engine/stress-v2' ||
    value.rounds <= 0 ||
    value.operations <= 0 ||
    !/^[0-9a-f]{64}$/u.test(value.correctnessDigest) ||
    !Number.isFinite(value.latency.p99Ms) ||
    value.maxSnapshotBytes <= 0 ||
    value.maxTranscriptBytes <= 0
  )
    throw new Error('Invalid stress artifact schema');
}
export function assertBenchmarkArtifact(value: BenchmarkArtifact): void {
  if (
    value.schema !== 'reveal-engine/benchmark-v2' ||
    value.samples <= 0 ||
    value.events <= 0 ||
    !/^[0-9a-f]{64}$/u.test(value.correctnessDigest) ||
    !Number.isFinite(value.eventsPerSecond)
  )
    throw new Error('Invalid benchmark artifact schema');
}
export function runtime(): StressArtifact['runtime'] {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    sourceRevision: process.env.GITHUB_SHA ?? 'local-working-tree',
  };
}
