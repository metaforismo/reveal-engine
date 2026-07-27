import type { Rational } from './rational.js';

export const CONTRACT_VERSION = 'reveal-engine/commit-v1' as const;
export type OutcomeId = string;
export interface EvidenceEvent {
  readonly index: number;
  readonly target: number;
  readonly favour: bigint;
  readonly other: bigint;
  readonly label: string;
}
export interface EvidenceSchedule {
  readonly eventCount: number;
  derive(seedHex: string, context: RoundContext, truth: number): readonly EvidenceEvent[];
}
export interface RoundContext {
  readonly gameId: string;
  readonly roundId: string;
  readonly contractVersion: typeof CONTRACT_VERSION;
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
  readonly id: string;
  readonly outcomes: readonly OutcomeId[];
  readonly priorWeights: readonly bigint[];
  readonly evidence: EvidenceSchedule;
  readonly pricing: PricingPolicy;
  readonly risk: RiskPolicy;
}
export interface Posterior {
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
