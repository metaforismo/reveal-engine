export interface LatencySummary {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}
/**
 * One replay anchor per lifecycle module, keyed by module id.
 *
 * This replaced the single `correctnessDigest` of the `-v2` artifacts, which is
 * why both schemas are now `-v3`. A repository with more than one module needs
 * one digest per module rather than one digest for the run: a single digest over
 * everything moves whenever a module is *added* to the workload, which makes it
 * impossible to tell a new workload from drift in an existing one. Each module's
 * value here is the same construction the `-v2` digest used, so
 * `progressive-market` carries its 0.2 value forward unchanged.
 */
export type ModuleDigests = Readonly<Record<string, string>>;
export interface StressArtifact {
  readonly schema: 'reveal-engine/stress-v3';
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
  readonly moduleDigests: ModuleDigests;
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
  readonly schema: 'reveal-engine/benchmark-v3';
  readonly evidenceClass: 'synthetic-local-or-ci';
  readonly samples: number;
  readonly events: number;
  /** Wall clock. Recorded as information; never gated — see `cpuMs`. */
  readonly elapsedMs: number;
  /** CPU time consumed by the workload. This is what the drift band judges. */
  readonly cpuMs: number;
  /** Wall-clock throughput. Recorded as information; never gated. */
  readonly eventsPerSecond: number;
  /** Throughput per CPU-second. This is what the drift band judges. */
  readonly eventsPerCpuSecond: number;
  /** Per-sample wall-clock latency. Recorded as information; never gated. */
  readonly latency: LatencySummary;
  readonly moduleDigests: ModuleDigests;
  readonly thresholds: {
    /** Symmetric drift band around the committed local baseline. */
    readonly maxRelativeDrift: number;
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
      'moduleDigests',
      'thresholds',
      'status',
      'runtime',
    ],
    '$',
  );
  if (
    artifact.schema !== 'reveal-engine/stress-v3' ||
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
  moduleDigests(artifact.moduleDigests, '$.moduleDigests');
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
      'cpuMs',
      'eventsPerSecond',
      'eventsPerCpuSecond',
      'latency',
      'moduleDigests',
      'thresholds',
      'status',
      'runtime',
    ],
    '$',
  );
  if (
    artifact.schema !== 'reveal-engine/benchmark-v3' ||
    artifact.evidenceClass !== 'synthetic-local-or-ci' ||
    (artifact.status !== 'pass' && artifact.status !== 'fail')
  )
    invalid('$', 'invalid benchmark identity');
  integer(artifact.samples, '$.samples', true);
  integer(artifact.events, '$.events', true);
  finite(artifact.elapsedMs, '$.elapsedMs', true);
  finite(artifact.cpuMs, '$.cpuMs', true);
  finite(artifact.eventsPerSecond, '$.eventsPerSecond', true);
  finite(artifact.eventsPerCpuSecond, '$.eventsPerCpuSecond', true);
  latency(artifact.latency, '$.latency');
  moduleDigests(artifact.moduleDigests, '$.moduleDigests');
  const thresholds = record(artifact.thresholds, '$.thresholds');
  exactKeys(thresholds, ['maxRelativeDrift'], '$.thresholds');
  finite(thresholds.maxRelativeDrift, '$.thresholds.maxRelativeDrift', true);
  if (thresholds.maxRelativeDrift > 1)
    invalid('$.thresholds.maxRelativeDrift', 'expected a fraction no greater than one');
  artifactRuntime(artifact.runtime);
}

/**
 * Compares the benchmark's CPU-cost signals against one recorded run.
 *
 * Deliberately CPU time and not wall clock. Wall clock measures how busy the
 * machine was, not only what this code costs. Gating scheduler contention would
 * tempt exactly the wrong fix — re-baselining a starved run, or widening the
 * band until contention fits inside it. CPU cost instead targets the work this
 * process newly does, or newly stopped doing.
 *
 * The band is symmetric because these figures are evidence of one local machine
 * state, not portable capacity promises. A much cheaper run is as much a change
 * of workload as a much dearer one and should ask for an explicit re-baseline.
 *
 * Wall clock, wall-clock throughput, and the latency summary stay in the
 * artifact as information — read them, do not gate on them.
 */
export function compareBenchmarkDrift(
  baseline: Pick<BenchmarkArtifact, 'cpuMs' | 'eventsPerCpuSecond'>,
  current: Pick<BenchmarkArtifact, 'cpuMs' | 'eventsPerCpuSecond'>,
  tolerance: number,
): readonly string[] {
  const metrics = [
    ['cpuMs', baseline.cpuMs, current.cpuMs],
    ['eventsPerCpuSecond', baseline.eventsPerCpuSecond, current.eventsPerCpuSecond],
  ] as const;
  return metrics.flatMap(([name, expected, observed]) => {
    const drift = Math.abs(observed - expected) / expected;
    return drift <= tolerance
      ? []
      : [
          `  ${name}: baseline ${expected}, current ${observed}, relative drift ${(drift * 100).toFixed(2)}%`,
        ];
  });
}
/**
 * Compares a run's replay anchors against a baseline's, in both directions.
 *
 * Returns one human-readable line per disagreement, empty when they agree
 * exactly. The comparison is over the **union** of the two key sets on purpose:
 * a module the baseline anchors and the run no longer produces is drift (the
 * workload silently lost a module), and a module the run produces and the
 * baseline does not anchor is also drift (the workload silently gained one, and
 * nothing is gating it). Both demand the same deliberate `artifacts:update`.
 */
export function compareModuleDigests(
  baseline: ModuleDigests,
  current: ModuleDigests,
): readonly string[] {
  const absent = '(absent from this run)';
  const unanchored = '(not anchored by the baseline)';
  return [...new Set([...Object.keys(baseline), ...Object.keys(current)])]
    .sort()
    .filter((moduleId) => baseline[moduleId] !== current[moduleId])
    .map(
      (moduleId) =>
        `  ${moduleId}: baseline ${baseline[moduleId] ?? unanchored}, current ${current[moduleId] ?? absent}`,
    );
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
/**
 * A non-empty map of module id to replay anchor.
 *
 * Empty is rejected: an artifact with no anchors is a run that measured timings
 * and proved nothing, and it would sail past the baseline comparison because
 * there would be no shared key left to compare.
 */
function moduleDigests(value: unknown, path: string): void {
  const entries = record(value, path);
  const keys = Object.keys(entries);
  if (keys.length === 0) invalid(path, 'expected at least one module digest');
  for (const key of keys) {
    if (key.length === 0 || Buffer.byteLength(key, 'utf8') > 128)
      invalid(path, 'invalid module id');
    digest(entries[key], `${path}.${key}`);
  }
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
