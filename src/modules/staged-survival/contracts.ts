/**
 * `staged-survival` type surface. Types and constants only; no algorithms.
 *
 * The lifecycle: `N` entities advance through `S` stages. Before each stage the
 * player picks one **stage contract** from an adapter-defined menu, and may bank
 * any subset of the entities that are still running. The stage then resolves to
 * a subset of survivors drawn from the committed random tape under that
 * contract's distribution. A contract changes the distribution the stage is read
 * under; it can never change a draw, because every draw the round could ever
 * consume is fixed by the seed before the first decision exists.
 *
 * `docs/modules/staged-survival.md` is the normative prose version of this file.
 */
import type { Rational } from '../../core/rational.js';
import { ENGINE_API_VERSION, COMMITMENT_VERSION } from '../../core/versions.js';

export { ENGINE_API_VERSION, COMMITMENT_VERSION };
export { LEGACY_COMMITMENT_VERSION, type CommitmentVersion } from '../../core/versions.js';

export const STAGED_SURVIVAL_MODULE_ID = 'staged-survival' as const;
export const STAGED_SURVIVAL_MODULE_VERSION = '1.0.0' as const;

export const TRANSCRIPT_SCHEMA = 'staged-survival/transcript-v1' as const;
export const SURVIVAL_BOOK_SCHEMA = 'staged-survival/book-v1' as const;

/** Receipt actions this module mints. */
export const SURVIVAL_ACTIONS = Object.freeze(['enter', 'choose', 'bank', 'settle'] as const);
export type SurvivalAction = (typeof SURVIVAL_ACTIONS)[number];

/**
 * Module-scoped bounds, all strictly inside `ENGINE_LIMITS`.
 *
 * `maxEntities` is the binding one and it is bound from three directions: the
 * belief vector carries one slot per entity plus a terminal "field is empty"
 * slot and `ENGINE_LIMITS.maxOutcomes` is 64; a book holds one open claim per
 * entity against `ENGINE_LIMITS.maxRoundClaims`; and the counterfactually
 * complete tape is `stages x contracts x entities x 2` draws against
 * `ENGINE_LIMITS.maxTapeDraws`.
 */
export const SURVIVAL_LIMITS = Object.freeze({
  maxEntities: 32,
  maxStages: 64,
  maxContracts: 16,
  /** Bytes of player entropy every round must carry. Matches SWARM's `clientEntropyBytes`. */
  clientEntropyBytes: 32,
  /**
   * Binary width of one entry stake, in minor units.
   *
   * A claim value is `stake * entryReturn * prod(mu)`, so the stake's own width
   * is one of the inputs to the exact arithmetic and it is the only one that is
   * a *runtime* argument rather than a declaration. Bounding it here makes the
   * whole money path total: `defineSurvivalGame()` refuses a definition that
   * would not leave `maxStakeBits` of room under `ENGINE_LIMITS.maxBigIntBits`,
   * so no stake this module accepts can overflow a rational mid-round.
   *
   * 64 bits is `1.8 x 10^19` minor units — beyond any real stake, and far under
   * the width a definition has to spare.
   */
  maxStakeBits: 64,
});

/**
 * How one lane resolves.
 *
 * `laneFailure` is a **common shock**: when it fires, every entity sharing the
 * lane fails together. It is where correlation lives, and it is exactly zero for
 * a contract whose entities are independent — zero, not an epsilon, so
 * `P(lane fails) = 0` is a real arithmetic fact rather than a rounding artifact.
 * `entitySurvival` is the conditional per-entity survival once the lane held.
 *
 * The marginal survival of one entity is `(1 - laneFailure) * entitySurvival`,
 * identical for every entity of the contract; only the *joint* distribution
 * depends on the lane geometry.
 */
export interface LaneProfile {
  /** `q`, in `[0, 1)`. Shared by every entity of the lane. */
  readonly laneFailure: Rational;
  /** `c`, in `(0, 1]`. Independent across the entities of a lane. */
  readonly entitySurvival: Rational;
}

/**
 * One entry of the per-stage menu.
 *
 * `laneWidth` is the geometry: the live field, in ascending entity order, is cut
 * into consecutive lanes of at most `laneWidth` entities. Width `1` removes
 * correlation structurally; a wider lane shares its `laneFailure` draw.
 *
 * `multiplier` is applied to a surviving entity's accrued claim value, and the
 * module refuses a definition where
 * `marginalSurvival * multiplier !== pricing.continuationReturn`: a contract
 * that does not exactly cancel its own hazard would make one route worth more
 * than another and turn the round's return into a function of policy.
 */
export interface StageContract {
  readonly id: string;
  readonly label: string;
  /** Entities per lane. `1 <= laneWidth <= entities`. */
  readonly laneWidth: number;
  /** Smallest live field this contract is offered to. `1 <= minEntities <= entities`. */
  readonly minEntities: number;
  readonly profile: LaneProfile;
  /** `mu`. Applied to a surviving entity's claim value. */
  readonly multiplier: Rational;
}

export interface SurvivalPricing {
  /** Charged once, at entry. In `(0, 1]`. The round's entire margin. */
  readonly entryReturn: Rational;
  /**
   * Return on value already inside the round. Pinned to exactly `1`.
   *
   * Any other value re-charges margin every stage, which makes a long ride worth
   * less than a short one and silently destroys the equal-return property the
   * oracle test proves. `defineSurvivalGame()` rejects anything else.
   */
  readonly continuationReturn: Rational;
  /** The only supported mode: exact rationals are floored at a credit boundary. */
  readonly rounding: 'floor';
}

export interface SurvivalRisk {
  readonly maxWinMultiple: bigint;
  /**
   * The cap basis this module supports, and the only one its proof covers: the
   * accumulated **externally funded** stake of the round. Every entity's entry
   * raises it; nothing a player wins inside the round ever does.
   */
  readonly capBasis: 'round-external-stake';
  /**
   * When true, `defineSurvivalGame()` refuses a configuration whose exact
   * maximum credit could reach the ceiling. Declaring `false` is honest — it
   * says the cap may clip; declaring `true` without the arithmetic is the defect.
   */
  readonly capMustBeUnreachable: boolean;
}

export interface SurvivalDefinition {
  readonly apiVersion: typeof ENGINE_API_VERSION;
  readonly id: string;
  readonly version: string;
  /** `N`. Every entity carries its own claim, and every one of them must be funded. */
  readonly entities: number;
  /** `S`. The round's stage budget. */
  readonly stages: number;
  /** The menu, in declaration order. Availability is by `minEntities`. */
  readonly contracts: readonly StageContract[];
  /**
   * Modulus of every tape draw.
   *
   * Every contract denominator must divide it exactly, so a survival test is an
   * exact integer comparison rather than a rounded one — and, critically, the
   * modulus is a declared constant of the definition, so the tape stays a pure
   * function of the seed whatever the player picks.
   */
  readonly drawModulus: bigint;
  readonly pricing: SurvivalPricing;
  readonly risk: SurvivalRisk;
}

/**
 * A round is identified by a **pair**: the operator's round id and the player's
 * entropy.
 *
 * The seed pre-commitment binds only `roundId`, because it must be published
 * before `clientEntropy` exists. Every tape draw binds both. That ordering is
 * the whole control against seed grinding, and it is why the two halves are
 * separate fields rather than one opaque string.
 *
 * `docs/adr/0008-round-entropy-without-a-core-change.md` records why this is
 * carried inside the contract's `roundId: string` rather than through a widened
 * core signature.
 */
export interface RoundRef {
  /** Operator round id. No `|`, at most 63 bytes, so the pair fits an identifier. */
  readonly roundId: string;
  /** Exactly `SURVIVAL_LIMITS.clientEntropyBytes` bytes, lowercase hex. */
  readonly clientEntropy: string;
}

/** The truth is the tape: fixed by the seed and the round pair, before any decision. */
export interface SurvivalTruth {
  readonly draws: readonly SurvivalDraw[];
  readonly digest: string;
}

export interface SurvivalDraw {
  readonly label: string;
  readonly counter: number;
  readonly modulus: bigint;
  readonly value: bigint;
}

/** One resolved lane of one stage. */
export interface SurvivalLane {
  /** Entities in the lane, ascending. */
  readonly entities: readonly number[];
  /** Whether the shared lane draw fired. When it did, no entity of the lane survives. */
  readonly collapsed: boolean;
}

export interface SurvivalStep {
  readonly index: number;
  readonly contractId: string;
  /** Entities withdrawn before this stage resolved, ascending. */
  readonly banked: readonly number[];
  readonly lanes: readonly SurvivalLane[];
  readonly survivors: readonly number[];
  readonly failed: readonly number[];
}

/**
 * One logged decision, taken before the stage it governs resolves.
 *
 * `banked` is the subset withdrawn at this stage boundary. It is part of the
 * decision rather than a separate log because it changes which entities are at
 * risk, and therefore the step — a transcript that omitted it would replay a
 * different round from the one that was played.
 */
export interface SurvivalChoice {
  readonly contractId: string;
  readonly banked: readonly number[];
}

/** One priced claim: does this entity survive the next stage under this contract? */
export interface SurvivalClaimRef {
  readonly entity: number;
  readonly contractId: string;
}

export interface SurvivalTranscript {
  readonly schema: typeof TRANSCRIPT_SCHEMA;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly definitionFingerprint: string;
  readonly roundId: string;
  readonly clientEntropy: string;
  /** Published before the round opened, when no decision and no entropy existed. */
  readonly seedCommitment: string;
  readonly tapeDigest: string;
  readonly choices: readonly SurvivalChoice[];
  readonly steps: readonly SurvivalStep[];
  readonly commitment: string;
}
