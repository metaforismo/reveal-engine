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
export function assertStressArtifact(value: unknown): asserts value is StressArtifact {
  const artifact = record(value, '$');
  exactKeys(
    artifact,
    [
      'schema',
      'evidenceClass',
      'workloadSeed',
      'rounds',
      'operations',
      'elapsedMs',
      'throughputOpsPerSecond',
      'latency',
      'heapDeltaBytes',
      'maxSnapshotBytes',
      'maxTranscriptBytes',
      'accepted',
      'rejected',
      'correctnessDigest',
      'thresholds',
      'status',
      'runtime',
    ],
    '$',
  );
  if (
    artifact.schema !== 'reveal-engine/stress-v2' ||
    artifact.evidenceClass !== 'synthetic-local-or-ci' ||
    (artifact.status !== 'pass' && artifact.status !== 'fail')
  )
    invalid('$', 'invalid stress identity');
  integer(artifact.workloadSeed, '$.workloadSeed', false);
  integer(artifact.rounds, '$.rounds', true);
  integer(artifact.operations, '$.operations', true);
  finite(artifact.elapsedMs, '$.elapsedMs', true);
  finite(artifact.throughputOpsPerSecond, '$.throughputOpsPerSecond', true);
  integer(artifact.heapDeltaBytes, '$.heapDeltaBytes', false);
  integer(artifact.maxSnapshotBytes, '$.maxSnapshotBytes', true);
  integer(artifact.maxTranscriptBytes, '$.maxTranscriptBytes', true);
  latency(artifact.latency, '$.latency');
  counts(artifact.accepted, '$.accepted');
  counts(artifact.rejected, '$.rejected');
  digest(artifact.correctnessDigest, '$.correctnessDigest');
  stressThresholds(artifact.thresholds);
  artifactRuntime(artifact.runtime);
}
export function assertBenchmarkArtifact(value: unknown): asserts value is BenchmarkArtifact {
  const artifact = record(value, '$');
  exactKeys(
    artifact,
    [
      'schema',
      'evidenceClass',
      'samples',
      'events',
      'elapsedMs',
      'eventsPerSecond',
      'latency',
      'correctnessDigest',
      'thresholds',
      'status',
      'runtime',
    ],
    '$',
  );
  if (
    artifact.schema !== 'reveal-engine/benchmark-v2' ||
    artifact.evidenceClass !== 'synthetic-local-or-ci' ||
    (artifact.status !== 'pass' && artifact.status !== 'fail')
  )
    invalid('$', 'invalid benchmark identity');
  integer(artifact.samples, '$.samples', true);
  integer(artifact.events, '$.events', true);
  finite(artifact.elapsedMs, '$.elapsedMs', true);
  finite(artifact.eventsPerSecond, '$.eventsPerSecond', true);
  latency(artifact.latency, '$.latency');
  digest(artifact.correctnessDigest, '$.correctnessDigest');
  const thresholds = record(artifact.thresholds, '$.thresholds');
  exactKeys(thresholds, ['elapsedMs', 'p99Ms', 'minimumEventsPerSecond'], '$.thresholds');
  finite(thresholds.elapsedMs, '$.thresholds.elapsedMs', true);
  finite(thresholds.p99Ms, '$.thresholds.p99Ms', true);
  finite(thresholds.minimumEventsPerSecond, '$.thresholds.minimumEventsPerSecond', true);
  artifactRuntime(artifact.runtime);
}
export function runtime(): StressArtifact['runtime'] {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    sourceRevision: process.env.GITHUB_SHA ?? 'local-working-tree',
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'expected object');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    invalid(path, 'missing or unknown field');
}
function finite(value: unknown, path: string, positive: boolean): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive ? value <= 0 : value < 0))
    invalid(path, 'expected finite bounded number');
}
function integer(value: unknown, path: string, positive: boolean): asserts value is number {
  finite(value, path, positive);
  if (!Number.isSafeInteger(value)) invalid(path, 'expected safe integer');
}
function latency(value: unknown, path: string): void {
  const summary = record(value, path);
  exactKeys(summary, ['p50Ms', 'p95Ms', 'p99Ms', 'maxMs'], path);
  finite(summary.p50Ms, `${path}.p50Ms`, false);
  finite(summary.p95Ms, `${path}.p95Ms`, false);
  finite(summary.p99Ms, `${path}.p99Ms`, false);
  finite(summary.maxMs, `${path}.maxMs`, false);
  if (
    summary.p50Ms > summary.p95Ms ||
    summary.p95Ms > summary.p99Ms ||
    summary.p99Ms > summary.maxMs
  )
    invalid(path, 'latency percentiles are not monotonic');
}
function counts(value: unknown, path: string): void {
  const entries = record(value, path);
  for (const [key, count] of Object.entries(entries)) {
    if (key.length === 0 || Buffer.byteLength(key, 'utf8') > 128)
      invalid(path, 'invalid count key');
    integer(count, `${path}.${key}`, false);
  }
}
function digest(value: unknown, path: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    invalid(path, 'expected canonical sha256');
}
function stressThresholds(value: unknown): void {
  const thresholds = record(value, '$.thresholds');
  exactKeys(thresholds, ['elapsedMs', 'p99Ms', 'heapDeltaBytes', 'snapshotBytes'], '$.thresholds');
  finite(thresholds.elapsedMs, '$.thresholds.elapsedMs', true);
  finite(thresholds.p99Ms, '$.thresholds.p99Ms', true);
  integer(thresholds.heapDeltaBytes, '$.thresholds.heapDeltaBytes', true);
  integer(thresholds.snapshotBytes, '$.thresholds.snapshotBytes', true);
}
function artifactRuntime(value: unknown): void {
  const target = record(value, '$.runtime');
  exactKeys(target, ['node', 'platform', 'arch', 'sourceRevision'], '$.runtime');
  for (const key of ['node', 'platform', 'arch', 'sourceRevision'])
    if (typeof target[key] !== 'string' || target[key].length === 0 || target[key].length > 128)
      invalid(`$.runtime.${key}`, 'expected bounded string');
}
function invalid(path: string, message: string): never {
  throw new Error(`Invalid artifact schema at ${path}: ${message}`);
}
