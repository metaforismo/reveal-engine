import type { Rational } from './rational.js';

export const ENGINE_API_VERSION = 'reveal-engine/api-v1' as const;
export const LEGACY_COMMITMENT_VERSION = 'reveal-engine/commit-v1' as const;
export const COMMITMENT_VERSION = 'reveal-engine/commit-v2' as const;
/** @deprecated Use COMMITMENT_VERSION. */
export const CONTRACT_VERSION = COMMITMENT_VERSION;
export type CommitmentVersion = typeof LEGACY_COMMITMENT_VERSION | typeof COMMITMENT_VERSION;
export type OutcomeId = string;
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
  readonly schema: 'reveal-engine/transcript-v2';
  readonly adapterVersion: string;
  readonly context: RoundContext;
  readonly truth: number;
  readonly evidence: readonly EvidenceEvent[];
  readonly commitment: string;
}
export interface Payable {
  readonly theoretical: Rational;
  readonly credited: bigint;
  readonly capped: boolean;
}

export interface VerificationSuccess {
  readonly ok: true;
  readonly proofVersion: CommitmentVersion;
  readonly commitment: string;
}

export interface VerificationFailure {
  readonly ok: false;
  readonly code:
    | 'INVALID_TRANSCRIPT'
    | 'UNSUPPORTED_VERSION'
    | 'ADAPTER_MISMATCH'
    | 'DERIVATION_FAILED'
    | 'TRANSCRIPT_MISMATCH'
    | 'COMMITMENT_MISMATCH';
  readonly message: string;
  readonly path: string;
}

export type VerificationResult = VerificationSuccess | VerificationFailure;
