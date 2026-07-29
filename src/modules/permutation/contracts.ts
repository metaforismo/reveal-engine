import type { Rational } from '../../core/rational.js';

/**
 * Identity, wire schemas, and the declarative shapes of the permutation module.
 *
 * The hidden truth of a round is a permutation of `n` labeled items: which item
 * settles into which position. Claims are priced by exact factorial counting
 * over the orderings still consistent with what has been revealed, never by a
 * flat weight vector — `5!` alone is already twice `ENGINE_LIMITS.maxOutcomes`.
 */

export const PERMUTATION_MODULE_ID = 'permutation' as const;
export const PERMUTATION_MODULE_VERSION = '1.0.0' as const;
export const PERMUTATION_TRANSCRIPT_SCHEMA = 'reveal-engine/permutation-transcript-v1' as const;
export const PERMUTATION_BOOK_SCHEMA = 'reveal-engine/permutation-book-v1' as const;

/** Receipt actions this module's book mints. */
export const PERMUTATION_ACTIONS = Object.freeze(['place', 'settle'] as const);
export type PermutationAction = (typeof PERMUTATION_ACTIONS)[number];

/**
 * Supported draw sizes.
 *
 * The floor is 3: at `n = 2` the item space is degenerate (`first`, `last` and
 * `stack` all collapse onto the same two outcomes) and the truth carries one
 * bit, which is the progressive market's shape, not this one.
 *
 * The ceiling is 8 because every proof this module ships is **exhaustive**:
 * conformance enumerates all `n!` truths and all `n!` Fisher-Yates draw vectors,
 * and `8! = 40,320` is the largest space that stays enumerable inside a CI step.
 * A larger draw could only ever be sampled, and a sampled proof reported as an
 * exhaustive one is exactly the overclaim this repository refuses to make.
 */
export const MIN_ITEMS = 3;
export const MAX_ITEMS = 8;

/**
 * Simultaneous open bets the module admits, whatever a definition declares.
 *
 * A definition may be stricter (`maxOpenBets`) and never looser; core bounds
 * both against `ENGINE_LIMITS.maxRoundClaims`.
 */
export const MAX_OPEN_BETS = 32;

/** Position within the settled order. Position 0 settles first. */
export type Position = number;
/** Index into `definition.items`. */
export type Item = number;

/**
 * The hidden truth: `order[position]` is the item that settles into `position`.
 *
 * The inverse view (`position of item`) is derived where it is needed and is
 * never a second source of truth.
 */
export type PermutationOrder = readonly Item[];

/**
 * One observable progression step: position `position` settled with `item`.
 *
 * A round emits `n - 1` steps, one per position in settle order. The final
 * position carries no information — exactly one item remains and it is forced —
 * so it is not a step. See `docs/modules/permutation.md`; the settled order in
 * full is the truth, bound into the commitment body and carried on the wire.
 */
export interface PermutationStep {
  readonly position: Position;
  readonly item: Item;
}

/**
 * The five bet families, as SET bets against a published paytable.
 *
 * Every family is a claim about the permutation and nothing else, and every one
 * is resolved by the same mechanism: a disjunction of pairwise-exclusive
 * position-to-item assignments (`bets.ts`). The codes match the AETHER ORDER
 * catalogue in `aether-order/docs/MATH.md` §3 so an adapter can carry them
 * straight through.
 */
export type PermutationBet =
  /** The complete settled order, item for item. `1 / n!`. */
  | { readonly code: 'full'; readonly order: PermutationOrder }
  /** One item into one named position. `1 / n`. */
  | { readonly code: 'slot'; readonly item: Item; readonly position: Position }
  /** One item settles first. `slot` at position 0; `1 / n`. */
  | { readonly code: 'first'; readonly item: Item }
  /** One item settles last. `slot` at position `n - 1`; `1 / n`. */
  | { readonly code: 'last'; readonly item: Item }
  /** `before` settles into the position immediately preceding `after`. `1 / n`. */
  | { readonly code: 'stack'; readonly before: Item; readonly after: Item };

export type PermutationBetCode = PermutationBet['code'];

/** Declaration order; also the canonical order the fingerprint binds. */
export const PERMUTATION_BET_CODES = Object.freeze([
  'full',
  'slot',
  'first',
  'last',
  'stack',
] as const satisfies readonly PermutationBetCode[]);

/** Total-return multiplier per bet code. A winning line returns `stake x multiplier`. */
export type PermutationPaytable = Readonly<Record<PermutationBetCode, Rational>>;

export interface PermutationDefinition {
  readonly id: string;
  readonly version: string;
  /** Unique printable item labels; `items.length` is `n`. */
  readonly items: readonly string[];
  /** Declared theoretical return per unit staked, identical for every bet code. */
  readonly rtp: Rational;
  readonly paytable: PermutationPaytable;
  /** Round credit ceiling as a multiple of everything the player staked. */
  readonly maxWinMultiple: bigint;
  /** Stakes must be a positive multiple of this, in minor units. */
  readonly stakeQuantum: bigint;
  readonly minLineStake: bigint;
  readonly maxLineStake: bigint;
  readonly maxTicketStake: bigint;
  /** Simultaneous open bets this definition admits, at most `MAX_OPEN_BETS`. */
  readonly maxOpenBets: number;
}

export interface PermutationTranscript {
  readonly schema: typeof PERMUTATION_TRANSCRIPT_SCHEMA;
  readonly definition: {
    readonly id: string;
    readonly version: string;
    readonly fingerprint: string;
  };
  readonly roundId: string;
  readonly order: PermutationOrder;
  readonly reveals: readonly PermutationStep[];
  readonly commitment: string;
}

/** Wire form of a transcript: exactly the domain object, with no BigInt fields. */
export interface WirePermutationTranscript {
  readonly schema: typeof PERMUTATION_TRANSCRIPT_SCHEMA;
  readonly definition: {
    readonly id: string;
    readonly version: string;
    readonly fingerprint: string;
  };
  readonly roundId: string;
  readonly order: readonly number[];
  readonly reveals: readonly { readonly position: number; readonly item: number }[];
  readonly commitment: string;
}

export const ACCEPTED_TRANSCRIPT_SCHEMAS: readonly string[] = Object.freeze([
  PERMUTATION_TRANSCRIPT_SCHEMA,
]);

/**
 * What a settled round records about the proof that closed it.
 *
 * The revealed seed is here on purpose. Once a round is terminal the seed is
 * public — revealing it is the whole point of commit-reveal — and carrying it
 * turns the snapshot from something that *asserts* a settled order into
 * something a restore can **re-derive** one. Without it, a snapshot could name
 * any order whose ticket happened to credit the same amount, and the checksum
 * would say nothing about it. See `PermutationBook.restore`.
 */
export interface PermutationSettlement {
  readonly roundId: string;
  /** 32 bytes of lowercase hex, published when the round settled. */
  readonly revealedSeed: string;
  readonly order: PermutationOrder;
  readonly commitment: string;
}

/** One open bet on the round book. `payout` is always recomputed, never trusted. */
export interface PermutationClaim {
  readonly key: string;
  readonly bet: PermutationBet;
  readonly stake: bigint;
  /** Exact total return if the bet wins: `stake x paytable[code]`. */
  readonly payout: Rational;
  /** Behavioural identity: the set of orders this bet wins on. */
  readonly signature: string;
}
