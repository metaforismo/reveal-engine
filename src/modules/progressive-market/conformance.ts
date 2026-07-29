import { RevealEngineError } from '../../api/errors.js';
import type { ConformanceFailure } from '../../core/module.js';
import {
  checkModuleConformance,
  type ModuleConformanceReport,
} from '../../conformance/module-conformance.js';
import type { GameDefinition } from './contracts.js';
import { progressiveMarket } from './module.js';

export const ADAPTER_CONFORMANCE_SCHEMA = 'reveal-engine/adapter-conformance-v1' as const;

export interface ConformanceReport {
  readonly schema: typeof ADAPTER_CONFORMANCE_SCHEMA;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly fingerprint: string;
  readonly seeds: number;
  readonly transcripts: number;
  readonly ok: boolean;
  readonly failures: readonly ConformanceFailure[];
}

export type { ConformanceFailure, ModuleConformanceReport };

/** Progressive-market view of the generic module conformance report. */
export function checkAdapterConformance(game: GameDefinition, seedCount = 8): ConformanceReport {
  const report = checkModuleConformance(progressiveMarket, game, seedCount);
  return Object.freeze({
    schema: ADAPTER_CONFORMANCE_SCHEMA,
    adapterId: report.definitionId,
    adapterVersion: report.definitionVersion,
    fingerprint: report.fingerprint,
    seeds: report.seeds,
    transcripts: report.counters.transcripts ?? 0,
    ok: report.ok,
    failures: report.failures,
  });
}

export function assertAdapterConforms(game: GameDefinition, seedCount = 8): ConformanceReport {
  const report = checkAdapterConformance(game, seedCount);
  if (!report.ok)
    throw new RevealEngineError(
      'INVALID_ADAPTER',
      `Adapter conformance failed: ${report.failures.map((failure) => `${failure.code}@${failure.path}`).join(', ')}`,
    );
  return report;
}
