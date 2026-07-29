import type { Rational } from '../../core/rational.js';
import {
  COMMITMENT_VERSION,
  ENGINE_API_VERSION,
  type CommitmentVersion,
} from '../../core/versions.js';

/** Identity of the sequential-cards lifecycle module. */
export const SEQUENTIAL_CARDS_MODULE_ID = 'sequential-cards' as const;
export const SEQUENTIAL_CARDS_MODULE_VERSION = '1.0.0' as const;

export const CARDS_TRANSCRIPT_SCHEMA = 'reveal-engine/cards-transcript-v1' as const;
export const CARDS_BOOK_SCHEMA = 'reveal-engine/cards-book-v1' as const;

/** Receipt actions this module mints. */
export const CARDS_ACTIONS = Object.freeze([
  'open',
  'reveal',
  'switch',
  'split',
  'cash',
  'settle',
] as const);
export type CardsAction = (typeof CARDS_ACTIONS)[number];

export { COMMITMENT_VERSION, ENGINE_API_VERSION };
export type { CommitmentVersion };

/**
 * Machine-readable rejection reasons.
 *
 * `src/api/errors.ts` owns the engine-wide code list and this module does not
 * extend it: every failure here is raised with one of the existing public codes
 * and carries its module-specific reason in `RevealEngineError.details.reason`.
 * `docs/modules/sequential-cards.md` maps every reason to the code it travels
 * under, so a host branches on `(code, details.reason)` and never on message
 * text.
 */
export const CARDS_REJECTION_REASONS = Object.freeze([
  'ACTION_NOT_OFFERED',
  'ANALYSIS_SPACE_TOO_LARGE',
  'BACKED_SELECTION_REQUIRED',
  'CAP_WOULD_BIND',
  'CHOICE_CONFLICT',
  'CHOICE_REQUIRED',
  'DECISION_ALREADY_TAKEN',
  'DUPLICATE_SELECTION',
  'INVALID_LADDER',
  'INVALID_LIQUIDATION_SPREAD',
  'INVALID_REVEAL_SPEC',
  'INVALID_ROUNDING_POLICY',
  'INVALID_SIDE_MARKET',
  'INVALID_STAKE_LATTICE',
  'MISSING_CLIENT_ENTROPY',
  'POSITION_ALREADY_BACKED',
  'POSITION_SETTLED',
  'REBACK_REJECTED',
  'ROUND_ALREADY_OPEN',
  'ROUND_NOT_OPEN',
  'SELECTION_NOT_LIVE',
  'STAKE_BELOW_MINIMUM',
  'UNDECLARED_FIELD',
  'UNKNOWN_MARKET',
  'UNKNOWN_SELECTION',
  'UNPRICEABLE_OUTCOME',
] as const);
export type CardsRejectionReason = (typeof CARDS_REJECTION_REASONS)[number];

/** How a hand of `dealt` distinct ranks is scored into the position that wins. */
export type CardsObjective = 'middle' | 'highest' | 'lowest';

/**
 * The declared finite deck.
 *
 * `size` ranks, one card each, dealt without replacement, so a hand is always
 * pairwise distinct and the order statistic `objective` names is a total
 * function. There is no tie rule anywhere in this module because there can be
 * no ties; `assertCardsDefinition` is what makes that a construction guarantee
 * rather than a convention.
 */
export interface LadderSpec {
  readonly size: number;
  readonly dealt: number;
  readonly objective: CardsObjective;
}

export interface RevealSpec {
  /** Adapter-owned version of the deterministic reveal algorithm. */
  readonly modelVersion: string;
  readonly count: number;
  /** `'unbacked'` excludes every logged backed position from the eligible set. */
  readonly eligibility: 'unbacked' | 'any';
  /** Whether the still-hidden positions are publicly ordered by rank after a reveal. */
  readonly sortRemaining: boolean;
}

export interface BackingSpec {
  /**
   * Positions a player may back before the reveals resolve.
   *
   * Under `eligibility: 'unbacked'` the eligible set at reveal `i` is
   * `dealt - i - maxOpenBeforeReveal`, and the definition is refused unless that
   * stays at least 1 for every reveal — the selector is an index into that set
   * and is sealed with the deal, before there is a backed position to adapt to.
   */
  readonly maxOpenBeforeReveal: number;
  /** `'move'` admits a pre-reveal switch (a re-back); `'reject'` refuses it. */
  readonly rebackMode: 'move' | 'reject';
}

/** A market that settles from the objective rank alone, with no live position. */
export interface SideMarket {
  readonly id: string;
  /** Objective ranks that win this selection: non-empty, sorted, unique, reachable. */
  readonly winningRanks: readonly number[];
}

/**
 * How an exact rational claim becomes an integer number of credits.
 *
 * The type carries all three candidates so a definition written against a rule
 * this version does not implement is a typed definition-time rejection rather
 * than a compile error in a host. Only `'floor'` is implemented; see
 * `docs/adr/0005-sequential-cards-scope-and-the-credit-boundary.md`.
 */
export type CardsRounding = 'floor' | 'ceiling' | 'stochastic';

export interface CardsPricingPolicy {
  /** Theoretical return, charged once per fresh external stake. */
  readonly entryRtp: Rational;
  /**
   * Post-reveal spread. **This version accepts only exactly zero.**
   *
   * The field is declared, fingerprinted, and validated so a definition that
   * wants a second margin says so explicitly and is refused explicitly. A
   * non-zero spread would break the property every published figure rests on —
   * with `σ = 0` every offered action has the identical exact value, so *every*
   * legal policy returns `entryRtp` and the argmin over the policy space needs
   * no search. Above zero the extremes diverge and finding the true argmin needs
   * an information-state search this module does not perform, so it refuses the
   * definition rather than reporting a number that is not the extreme it claims
   * to be.
   */
  readonly liquidationSpread: Rational;
  readonly rounding: CardsRounding;
  /** Smallest accepted stake per market selection, in credits. */
  readonly minStakeCredits: bigint;
  /** Stake dial granularity, in credits. Must divide `minStakeCredits` exactly. */
  readonly stakeStepCredits: bigint;
  /** In-round actions the definition offers at a decision point. */
  readonly actions: readonly ('switch' | 'split' | 'cash')[];
  /** `'even'`: a split pays the same amount on every hedged position. */
  readonly splitMode: 'even';
}

export interface CardsRiskPolicy {
  readonly maxWinMultiple: bigint;
  /**
   * When true, `defineCardsGame` proves by exhaustion that the cap sits strictly
   * above every payout the definition can reach, and refuses it otherwise. A
   * binding cap silently reduces the published return.
   */
  readonly capMustNotBind: boolean;
}

export interface CardsSeedPolicy {
  /** `'per-round'`: a fresh operator seed is committed for every round. */
  readonly operatorSeedScope: 'per-round';
  /** Whether `composeRoundSeed` refuses to derive without player entropy. */
  readonly clientEntropy: 'required' | 'optional';
  /** Bytes of client seed the host must supply when entropy is required. */
  readonly clientSeedBytes: number;
}

export interface TicketSpec {
  /** A ticket with no backed selection has no eligible set for the reveal. */
  readonly requiresBackedMarket: boolean;
  /** `'per-selection'`: every row carries its own stake and its own credit event. */
  readonly stakeScope: 'per-selection';
}

export interface SequentialCardsDefinition {
  readonly apiVersion: typeof ENGINE_API_VERSION;
  readonly moduleId: typeof SEQUENTIAL_CARDS_MODULE_ID;
  readonly id: string;
  /** Definition-owned immutable version. Bump when replay-visible behaviour changes. */
  readonly version: string;
  readonly ladder: LadderSpec;
  readonly reveal: RevealSpec;
  readonly backing: BackingSpec;
  readonly sideMarkets: readonly SideMarket[];
  readonly ticket: TicketSpec;
  readonly pricing: CardsPricingPolicy;
  readonly risk: CardsRiskPolicy;
  readonly seed: CardsSeedPolicy;
}

/**
 * The hidden truth: a committed deal plus the reveal selectors sealed with it.
 *
 * `selectors[i]` indexes the eligible set at reveal `i` **in ascending board
 * order**. That set's size does not depend on which position the player backs
 * — only on how many positions a definition lets them back — so the selector
 * can be sealed before any decision exists. That is what makes a dealer who
 * chooses the reveal with knowledge of the hidden cards unavailable rather than
 * merely detectable.
 */
export interface Deal {
  readonly ranks: readonly number[];
  readonly selectors: readonly number[];
}

/** One reveal: a card turns face up and the still-hidden cards are re-sorted. */
export interface RevealStep {
  readonly index: number;
  readonly position: number;
  readonly rank: number;
  /**
   * Still-hidden positions in ascending rank order, or empty when the definition
   * does not sort. This is the only information about the hidden cards a reveal
   * discloses.
   */
  readonly sorted: readonly number[];
  readonly label: string;
}

/** A logged decision. Backing is the only kind this version models. */
export interface PlayerChoice {
  readonly index: number;
  readonly kind: 'back';
  readonly position: number;
}

/**
 * One priced claim event.
 *
 * A position claim pays when the objective card sits on any of its covered
 * positions — one position for a plain claim, several after an even split. A
 * market claim pays when the objective **rank** is one the market names.
 */
export type CardsClaim =
  | { readonly kind: 'position'; readonly positions: readonly number[] }
  | { readonly kind: 'market'; readonly marketId: string };

export interface CardsTranscript {
  readonly schema: typeof CARDS_TRANSCRIPT_SCHEMA;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly definitionFingerprint: string;
  readonly roundId: string;
  /** Published before the round accepted its first decision. */
  readonly seedCommitment: string;
  readonly deal: Deal;
  readonly choices: readonly PlayerChoice[];
  readonly steps: readonly RevealStep[];
  readonly commitment: string;
}
