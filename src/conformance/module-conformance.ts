import { RevealEngineError, asRevealEngineError } from '../api/errors.js';
import { ENGINE_LIMITS } from '../api/limits.js';
import { COMMITMENT_VERSION } from '../core/versions.js';
import { CONFORMANCE_CHECK_SCOPES } from '../core/module.js';
import type {
  ConformanceFailure,
  LifecycleModule,
  LifecycleShape,
  ModuleConformanceCheck,
  ModuleConformanceContext,
  RoundIdentity,
} from '../core/module.js';

export const MODULE_CONFORMANCE_SCHEMA = 'reveal-engine/module-conformance-v1' as const;

export interface ModuleConformanceReport {
  readonly schema: typeof MODULE_CONFORMANCE_SCHEMA;
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly fingerprint: string;
  readonly seeds: number;
  /** Every declared check code, in declaration order. */
  readonly checks: readonly string[];
  /**
   * How many times each declared check actually executed.
   *
   * `checks` alone cannot distinguish "ran and passed" from "never ran": a
   * report that lists a code it did not execute is a report claiming evidence it
   * did not produce. A definition-scoped check runs once; a round-scoped check
   * runs once per seed. A zero here is a bug, not a pass.
   */
  readonly ran: Readonly<Record<string, number>>;
  readonly counters: Readonly<Record<string, number>>;
  readonly ok: boolean;
  readonly failures: readonly ConformanceFailure[];
}

export type { ConformanceFailure };

/** Deterministic conformance seeds: index 0..n-1 as 32-byte big-endian hex. */
export function conformanceSeed(index: number): string {
  return index.toString(16).padStart(64, '0');
}

/**
 * Rejects anything that is not a lifecycle module before a field is read.
 *
 * The runner is reachable with attacker-shaped input through the CLI, so a
 * malformed module is a typed `INVALID_MODULE`, never a `TypeError`.
 */
function assertLifecycleModule(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new RevealEngineError('INVALID_MODULE', 'Expected a lifecycle module object', '$.module');
  const module = value as Partial<LifecycleModule<never>>;
  if (
    typeof module.id !== 'string' ||
    typeof module.version !== 'string' ||
    typeof module.verify !== 'function' ||
    typeof module.definitions !== 'object' ||
    module.definitions === null ||
    typeof module.conformance !== 'object' ||
    module.conformance === null ||
    !Array.isArray(module.conformance.checks)
  )
    throw new RevealEngineError('INVALID_MODULE', 'Module contract is incomplete', '$.module');
}

/**
 * Runs a lifecycle module's declared conformance checks over deterministic seeds.
 *
 * The runner is module-agnostic on purpose: it supplies identity, seeds, and a
 * counter sink, and the module supplies the properties worth proving. A new
 * lifecycle module gets a conformance CLI and a report schema for free by
 * declaring its checks.
 */
export function checkModuleConformance<S extends LifecycleShape>(
  module: LifecycleModule<S>,
  definition: S['definition'],
  seedCount?: number,
): ModuleConformanceReport {
  assertLifecycleModule(module);
  const seeds = seedCount ?? module.conformance.defaultSeeds;
  const failures: ConformanceFailure[] = [];
  const counters: Record<string, number> = {};
  const ran: Record<string, number> = {};
  const count = (key: string, delta = 1): void => {
    counters[key] = (counters[key] ?? 0) + delta;
  };
  const runCheck = (
    check: ModuleConformanceCheck<S>,
    context: ModuleConformanceContext<S>,
  ): void => {
    ran[check.code] = (ran[check.code] ?? 0) + 1;
    failures.push(...check.run(context));
  };
  let identity = {
    definitionId: '<invalid>',
    definitionVersion: '<invalid>',
    fingerprint: '',
  };
  try {
    // The floor is 1. At zero every round-scoped check is skipped while the
    // report still lists its code and returns `ok: true` — a passing report that
    // proves nothing, which is exactly the overclaim this runner exists to avoid.
    if (!Number.isSafeInteger(seeds) || seeds < 1 || seeds > ENGINE_LIMITS.maxConformanceSeeds)
      throw new RevealEngineError(
        'INVALID_MODULE',
        'Conformance seed count is outside limits',
        '$.seedCount',
      );
    for (const [index, check] of module.conformance.checks.entries())
      if (!CONFORMANCE_CHECK_SCOPES.includes(check.scope))
        throw new RevealEngineError(
          'INVALID_MODULE',
          `Conformance check scope must be one of: ${CONFORMANCE_CHECK_SCOPES.join(', ')}`,
          `$.conformance.checks[${index}].scope`,
        );
    module.definitions.assert(definition);
    const resolved = module.definitions.identity(definition);
    identity = {
      definitionId: resolved.definitionId,
      definitionVersion: resolved.definitionVersion,
      fingerprint: resolved.fingerprint,
    };
    const contextFor = (seedIndex: number): ModuleConformanceContext<S> => {
      const roundId = `conformance-${seedIndex}`;
      const round: RoundIdentity = Object.freeze({
        moduleId: module.id,
        definitionId: resolved.definitionId,
        fingerprint: resolved.fingerprint,
        roundId,
        proofVersion: COMMITMENT_VERSION,
      });
      return Object.freeze({
        module,
        definition,
        seedHex: conformanceSeed(seedIndex),
        seedIndex,
        roundId,
        round,
        count,
      });
    };
    for (const check of module.conformance.checks)
      if (check.scope === 'definition') runCheck(check, contextFor(0));
    for (let seedIndex = 0; seedIndex < seeds; seedIndex += 1) {
      const context = contextFor(seedIndex);
      for (const check of module.conformance.checks)
        if (check.scope === 'round') runCheck(check, context);
    }
  } catch (error) {
    const failure =
      error instanceof RevealEngineError
        ? error
        : asRevealEngineError(error, 'INVALID_ADAPTER', 'Conformance failed');
    failures.push({ code: failure.code, path: failure.path, message: failure.message });
  }
  return Object.freeze({
    schema: MODULE_CONFORMANCE_SCHEMA,
    moduleId: module.id,
    moduleVersion: module.version,
    definitionId: identity.definitionId,
    definitionVersion: identity.definitionVersion,
    fingerprint: identity.fingerprint,
    seeds,
    checks: Object.freeze(module.conformance.checks.map((check) => check.code)),
    ran: Object.freeze({ ...ran }),
    counters: Object.freeze({ ...counters }),
    ok: failures.length === 0,
    failures: Object.freeze(failures),
  });
}

export function assertModuleConformance<S extends LifecycleShape>(
  module: LifecycleModule<S>,
  definition: S['definition'],
  seedCount?: number,
): ModuleConformanceReport {
  const report = checkModuleConformance(module, definition, seedCount);
  if (!report.ok)
    throw new RevealEngineError(
      'INVALID_ADAPTER',
      `Conformance failed: ${report.failures.map((failure) => `${failure.code}@${failure.path}`).join(', ')}`,
    );
  return report;
}
