import type { Rational } from '../../core/rational.js';
import {
  COMMITMENT_VERSION,
  ENGINE_API_VERSION,
  LEGACY_COMMITMENT_VERSION,
  type CommitmentVersion,
} from '../../core/versions.js';

/** Identity of the progressive-market lifecycle module. */
export const PROGRESSIVE_MARKET_MODULE_ID = 'progressive-market' as const;
export const PROGRESSIVE_MARKET_MODULE_VERSION = '1.0.0' as const;

export const TRANSCRIPT_SCHEMA = 'reveal-engine/transcript-v2' as const;
export const LEGACY_TRANSCRIPT_SCHEMA = 'reveal-engine/transcript-v1' as const;
export const ROUND_BOOK_SCHEMA = 'reveal-engine/round-book-v1' as const;

export { COMMITMENT_VERSION, ENGINE_API_VERSION, LEGACY_COMMITMENT_VERSION };
export type { CommitmentVersion };

/** @deprecated Use COMMITMENT_VERSION. */
export const CONTRACT_VERSION = COMMITMENT_VERSION;

export type OutcomeId = string;

/**
 * One Bayesian evidence event.
 *
 * `favour` multiplies the targeted outcome's weight and `other` multiplies every
 * remaining outcome's weight. Both are exact positive BigInts, so a likelihood
 * ratio is never a float and never drifts across replays.
 */
export interface EvidenceEvent {
  readonly index: number;
  readonly target: number;
  readonly favour: bigint;
  readonly other: bigint;
  readonly label: string;
}

export interface EvidenceSchedule {
  /** Adapter-owned version for the deterministic evidence algorithm. */
  readonly modelVersion: string;
  readonly eventCount: number;
  derive(seedHex: string, context: RoundContext, truth: number): readonly EvidenceEvent[];
}

export interface RoundContext {
  readonly gameId: string;
  readonly roundId: string;
  readonly proofVersion: CommitmentVersion;
}

export interface PricingPolicy {
  readonly firstEntryRtp: Rational;
  readonly liquidationSpread: Rational;
  readonly rounding: 'floor';
}

export interface RiskPolicy {
  readonly maxWinMultiple: bigint;
  readonly continuation?: { readonly maxRides: number; readonly rtpFloor: Rational };
}

export interface GameDefinition {
  readonly apiVersion: typeof ENGINE_API_VERSION;
  /** Adapter-owned immutable version. Change when replay-visible behavior changes. */
  readonly adapterVersion: string;
  readonly id: string;
  readonly outcomes: readonly OutcomeId[];
  readonly priorWeights: readonly bigint[];
  readonly evidence: EvidenceSchedule;
  readonly pricing: PricingPolicy;
  readonly risk: RiskPolicy;
}

export interface Posterior {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly adapterFingerprint: string;
  readonly weights: readonly bigint[];
  readonly total: bigint;
}

export interface PriceQuote {
  readonly frameRevision: number;
  readonly outcome: number;
  readonly firstEntry: boolean;
  readonly multiplier: Rational;
}

export interface Transcript {
  readonly schema: typeof TRANSCRIPT_SCHEMA;
  readonly adapterVersion: string;
  readonly context: RoundContext;
  readonly truth: number;
  readonly evidence: readonly EvidenceEvent[];
  readonly commitment: string;
}
