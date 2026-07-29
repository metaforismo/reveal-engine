import { fail } from '../../api/errors.js';
import { countingProbability, factorial } from '../../core/combinatorics.js';
import { rational, type Rational } from '../../core/rational.js';
import { reduceWeights, weightVector, type WeightVector } from '../../core/weights.js';
import type { CardsClaim, RevealStep, SequentialCardsDefinition } from './contracts.js';

/**
 * Exact counting over the deck.
 *
 * Everything a price or a posterior is made of is computed here by **exhaustive
 * enumeration in BigInt**: the module never closes a form it could count. That
 * costs a bounded amount of work — `CARDS_MAX_SUPPORT` is enforced at definition
 * time — and it buys the property this module exists for. A reveal that makes a
 * position impossible produces a weight of exactly `0n`, because no completion
 * of the hidden ranks puts the objective card there, and zero completions is a
 * count rather than a limit.
 *
 * There is no epsilon, no smoothing, and no float anywhere in this file.
 */

/** Combinations one belief may enumerate. Enforced by `assertCardsDefinition`. */
export const CARDS_MAX_SUPPORT = 200_000;

/** Exact `C(n, k)`, with the same bounds `core/combinatorics.ts` applies. */
export function combinationCount(n: number, k: number): bigint {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(k) || n < 0 || k < 0)
    fail('INVALID_WEIGHTS', 'Combination arguments must be non-negative safe integers', '$.n');
  if (k > n) return 0n;
  let result = 1n;
  const upper = Math.min(k, n - k);
  for (let index = 0; index < upper; index += 1)
    result = (result * BigInt(n - index)) / BigInt(index + 1);
  return result;
}

/** Zero-based order statistic the definition's objective names. */
export function objectiveIndex(definition: SequentialCardsDefinition): number {
  const { dealt, objective } = definition.ladder;
  if (objective === 'lowest') return 0;
  if (objective === 'highest') return dealt - 1;
  return (dealt - 1) / 2;
}

/**
 * Whether a rank can ever be the objective card.
 *
 * `middle` over three cards cannot be rank 1 or rank `size`: nothing sits below
 * a 1 and nothing above the top of the ladder. A market on an unreachable rank
 * would be offered at a price that can never pay, so definitions are refused
 * rather than priced.
 */
export function isReachableObjectiveRank(
  definition: SequentialCardsDefinition,
  rank: number,
): boolean {
  const { size, dealt } = definition.ladder;
  const index = objectiveIndex(definition);
  return rank - 1 >= index && size - rank >= dealt - 1 - index;
}

/** Every rank the objective card can take, ascending. */
export function reachableObjectiveRanks(definition: SequentialCardsDefinition): readonly number[] {
  const ranks: number[] = [];
  for (let rank = 1; rank <= definition.ladder.size; rank += 1)
    if (isReachableObjectiveRank(definition, rank)) ranks.push(rank);
  return Object.freeze(ranks);
}

/** Ascending `k`-subsets of `[0, n)`, streamed so nothing materialises the whole set. */
export function forEachCombination(
  n: number,
  k: number,
  visit: (indices: readonly number[]) => void,
): void {
  if (k < 0 || k > n) return;
  if (k === 0) {
    visit([]);
    return;
  }
  const indices = Array.from({ length: k }, (_value, index) => index);
  for (;;) {
    visit(indices);
    let cursor = k - 1;
    while (cursor >= 0 && (indices[cursor] as number) === n - k + cursor) cursor -= 1;
    if (cursor < 0) return;
    indices[cursor] = (indices[cursor] as number) + 1;
    for (let next = cursor + 1; next < k; next += 1)
      indices[next] = (indices[next - 1] as number) + 1;
  }
}

/**
 * What the public record says after a step prefix.
 *
 * A reveal discloses exactly two things: the face value of the revealed card,
 * and — when the definition sorts — the order relation between the cards that
 * are still down. Nothing else about the hidden ranks is observable, so nothing
 * else may enter the posterior.
 */
export interface CardsRevealRecord {
  readonly revealedRanks: readonly number[];
  readonly positionOfRank: ReadonlyMap<number, number>;
  readonly hidden: readonly number[];
  /** Hidden positions in ascending rank order when sorted, else in board order. */
  readonly hiddenOrder: readonly number[];
  readonly sorted: boolean;
  readonly pool: readonly number[];
  /**
   * Per-position exclusive rank bounds implied by **earlier** published sorts.
   *
   * A sort published at step `j` ordered the cards that were hidden then. When a
   * later step turns one of them face up, its value splits that order: everything
   * that sat before it is now known to be lower, everything after it higher.
   * A posterior that used only the most recent sort would throw those splits
   * away and price a multi-reveal round wrong — the round would still look
   * self-consistent, and every action would still appear value-neutral inside a
   * state, but the states themselves would carry the wrong weights.
   */
  readonly lowerBound: readonly number[];
  readonly upperBound: readonly number[];
}

export function revealRecordOf(
  definition: SequentialCardsDefinition,
  steps: readonly RevealStep[],
): CardsRevealRecord {
  const { size, dealt } = definition.ladder;
  const positionOfRank = new Map<number, number>();
  const revealedPositions = new Set<number>();
  for (const step of steps) {
    positionOfRank.set(step.rank, step.position);
    revealedPositions.add(step.position);
  }
  const hidden: number[] = [];
  for (let position = 0; position < dealt; position += 1)
    if (!revealedPositions.has(position)) hidden.push(position);
  const last = steps[steps.length - 1];
  const sorted =
    definition.reveal.sortRemaining && last !== undefined && last.sorted.length === hidden.length;
  const pool: number[] = [];
  for (let rank = 1; rank <= size; rank += 1) if (!positionOfRank.has(rank)) pool.push(rank);
  const lowerBound = new Array<number>(dealt).fill(0);
  const upperBound = new Array<number>(dealt).fill(size + 1);
  if (definition.reveal.sortRemaining)
    for (let index = 1; index < steps.length; index += 1) {
      const previous = (steps[index - 1] as RevealStep).sorted;
      const step = steps[index] as RevealStep;
      const slot = previous.indexOf(step.position);
      if (slot < 0) continue;
      for (let earlier = 0; earlier < slot; earlier += 1) {
        const position = previous[earlier] as number;
        upperBound[position] = Math.min(upperBound[position] as number, step.rank);
      }
      for (let later = slot + 1; later < previous.length; later += 1) {
        const position = previous[later] as number;
        lowerBound[position] = Math.max(lowerBound[position] as number, step.rank);
      }
    }
  return Object.freeze({
    revealedRanks: Object.freeze([...positionOfRank.keys()].sort((a, b) => a - b)),
    positionOfRank,
    hidden: Object.freeze(hidden),
    hiddenOrder: Object.freeze(sorted ? [...(last as RevealStep).sorted] : [...hidden]),
    sorted,
    pool: Object.freeze(pool),
    lowerBound: Object.freeze(lowerBound),
    upperBound: Object.freeze(upperBound),
  });
}

/**
 * Exact belief after a step prefix, in two views over one denominator.
 *
 * `positionWeights[i]` counts the completions of the hidden ranks under which
 * board position `i` holds the objective card. `rankWeights[r]` counts the
 * completions whose objective card has face value `r`. Both are counted over
 * the same enumeration, so the two views share `total` and a position price and
 * a market price are always commensurable.
 *
 * When the definition sorts, every completion is one ascending subset of the
 * remaining pool laid onto the published order, and each contributes weight 1.
 * When it does not, the hidden positions stay exchangeable, so a completion is
 * an ordered tuple: each subset contributes `m!`, split as `(m-1)!` to each
 * hidden position when the objective is hidden. Both branches keep the total at
 * `W · C(|pool|, m)`, which is what makes the two views exact rather than
 * normalised.
 */
export interface CardsBelief {
  readonly positionWeights: readonly bigint[];
  readonly rankWeights: readonly bigint[];
  readonly total: bigint;
  readonly record: CardsRevealRecord;
  /** Completions enumerated. Exposed so a caller can report the work it proved. */
  readonly completions: bigint;
}

export function cardsBelief(
  definition: SequentialCardsDefinition,
  steps: readonly RevealStep[],
): CardsBelief {
  const { size, dealt } = definition.ladder;
  const record = revealRecordOf(definition, steps);
  const hiddenCount = record.hidden.length;
  if (hiddenCount < 1)
    fail('DERIVATION_FAILED', 'A round must keep at least one card hidden', '$.steps');
  if (record.pool.length < hiddenCount)
    fail('DERIVATION_FAILED', 'Revealed ranks exhaust the deck', '$.steps');
  const support = combinationCount(record.pool.length, hiddenCount);
  if (support > BigInt(CARDS_MAX_SUPPORT))
    fail('INVALID_WEIGHTS', 'Belief support exceeds the enumerated bound', '$.ladder');

  const objective = objectiveIndex(definition);
  const whole = record.sorted ? 1n : factorial(hiddenCount);
  const share = record.sorted ? 0n : factorial(hiddenCount - 1);
  const positionWeights = new Array<bigint>(dealt).fill(0n);
  const rankWeights = new Array<bigint>(size + 1).fill(0n);
  const revealed = record.revealedRanks;
  const pool = record.pool;
  const hand = new Array<number>(dealt);
  let completions = 0n;

  forEachCombination(pool.length, hiddenCount, (indices) => {
    // A completion has to respect every order relation the board has published,
    // not merely the most recent sort. `lowerBound`/`upperBound` carry the
    // splits that earlier sorts imply once a card they ordered turned face up.
    if (record.sorted)
      for (let slot = 0; slot < hiddenCount; slot += 1) {
        const position = record.hiddenOrder[slot] as number;
        const rank = pool[indices[slot] as number] as number;
        if (
          rank <= (record.lowerBound[position] as number) ||
          rank >= (record.upperBound[position] as number)
        )
          return;
      }
    // Merge the revealed ranks with this completion; both sides are ascending,
    // so the hand is sorted without a comparison sort.
    let left = 0;
    let right = 0;
    for (let slot = 0; slot < dealt; slot += 1) {
      const a = left < revealed.length ? (revealed[left] as number) : Number.POSITIVE_INFINITY;
      const b =
        right < hiddenCount ? (pool[indices[right] as number] as number) : Number.POSITIVE_INFINITY;
      if (a < b) {
        hand[slot] = a;
        left += 1;
      } else {
        hand[slot] = b;
        right += 1;
      }
    }
    const objectiveRank = hand[objective] as number;
    rankWeights[objectiveRank] = (rankWeights[objectiveRank] as bigint) + whole;
    const revealedPosition = record.positionOfRank.get(objectiveRank);
    if (revealedPosition !== undefined) {
      positionWeights[revealedPosition] = (positionWeights[revealedPosition] as bigint) + whole;
    } else if (record.sorted) {
      let slot = 0;
      while ((pool[indices[slot] as number] as number) !== objectiveRank) slot += 1;
      const position = record.hiddenOrder[slot] as number;
      positionWeights[position] = (positionWeights[position] as bigint) + whole;
    } else {
      for (const position of record.hidden)
        positionWeights[position] = (positionWeights[position] as bigint) + share;
    }
    completions += 1n;
  });

  const total = whole * completions;
  if (total <= 0n)
    fail('DERIVATION_FAILED', 'Belief enumeration produced no completions', '$.steps');
  return Object.freeze({
    positionWeights: Object.freeze(positionWeights),
    rankWeights: Object.freeze(rankWeights),
    total,
    record,
    completions,
  });
}

/**
 * The belief as a core `WeightVector`, reduced by its common factor.
 *
 * This is the elimination view: an eliminated position is exactly `0n` here, and
 * `weightVector` still refuses the impossible round where every position is
 * eliminated. It is **not** the pricing space — the truth is combinatorial and
 * a market prices over ranks, not positions — so `steps.beliefSpace` is
 * `marginal` and `price()` carries the money.
 */
export function cardsBeliefVector(
  definition: SequentialCardsDefinition,
  steps: readonly RevealStep[],
): WeightVector {
  return weightVector(reduceWeights([...cardsBelief(definition, steps).positionWeights]));
}

/** Favourable count of one claim event against the shared belief denominator. */
export function claimFavourable(
  definition: SequentialCardsDefinition,
  belief: CardsBelief,
  claim: CardsClaim,
): bigint {
  if (claim.kind === 'position') {
    let favourable = 0n;
    for (const position of claim.positions)
      favourable += belief.positionWeights[position] as bigint;
    return favourable;
  }
  const market = definition.sideMarkets.find((candidate) => candidate.id === claim.marketId);
  if (market === undefined)
    fail('UNKNOWN_OUTCOME', 'Unknown side market', '$.claim.marketId', {
      reason: 'UNKNOWN_MARKET',
    });
  let favourable = 0n;
  for (const rank of market.winningRanks) favourable += belief.rankWeights[rank] as bigint;
  return favourable;
}

/** Exact probability of one claim event after a step prefix. */
export function claimProbability(
  definition: SequentialCardsDefinition,
  steps: readonly RevealStep[],
  claim: CardsClaim,
): Rational {
  assertClaimShape(definition, claim);
  const belief = cardsBelief(definition, steps);
  return countingProbability(claimFavourable(definition, belief, claim), belief.total);
}

/** Structural validation of a claim, before it reaches any counting. */
export function assertClaimShape(
  definition: SequentialCardsDefinition,
  claim: unknown,
): asserts claim is CardsClaim {
  const candidate = claim as CardsClaim;
  if (typeof candidate !== 'object' || candidate === null)
    fail('CLAIM_REJECTED', 'Expected a claim object', '$.claim');
  if (candidate.kind === 'market') {
    if (typeof candidate.marketId !== 'string')
      fail('CLAIM_REJECTED', 'Market claim needs a market id', '$.claim.marketId');
    if (!definition.sideMarkets.some((market) => market.id === candidate.marketId))
      fail('UNKNOWN_OUTCOME', 'Unknown side market', '$.claim.marketId', {
        reason: 'UNKNOWN_MARKET',
      });
    return;
  }
  if (candidate.kind !== 'position') fail('CLAIM_REJECTED', 'Unknown claim kind', '$.claim.kind');
  if (
    !Array.isArray(candidate.positions) ||
    candidate.positions.length === 0 ||
    candidate.positions.length > definition.ladder.dealt
  )
    fail('CLAIM_REJECTED', 'Position claim needs a bounded non-empty position set', '$.claim');
  candidate.positions.forEach((position, index) => {
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position >= definition.ladder.dealt ||
      candidate.positions.indexOf(position) !== index
    )
      fail('CLAIM_REJECTED', 'Position claim is out of range or repeats', `$.claim.positions`);
  });
}

/** The board position that holds the objective card of a fully known deal. */
export function objectivePositionOf(
  definition: SequentialCardsDefinition,
  ranks: readonly number[],
): number {
  const order = ranks.map((rank, position) => ({ rank, position }));
  order.sort((left, right) => left.rank - right.rank);
  const chosen = order[objectiveIndex(definition)];
  if (chosen === undefined)
    fail('DERIVATION_FAILED', 'Deal is shorter than the declared hand', '$.deal');
  return chosen.position;
}

/** The face value of the objective card of a fully known deal. */
export function objectiveRankOf(
  definition: SequentialCardsDefinition,
  ranks: readonly number[],
): number {
  return ranks[objectivePositionOf(definition, ranks)] as number;
}

/** Exact probability of a position set, expressed against the belief that produced it. */
export function positionProbability(belief: CardsBelief, positions: readonly number[]): Rational {
  let favourable = 0n;
  for (const position of positions) favourable += belief.positionWeights[position] as bigint;
  return rational(favourable, belief.total);
}
