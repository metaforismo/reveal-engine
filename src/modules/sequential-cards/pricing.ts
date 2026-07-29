import { divide, multiply, rational, subtract, type Rational } from '../../core/rational.js';
import type { SequentialCardsDefinition } from './contracts.js';
import { positionProbability, type CardsBelief } from './deck.js';
import { reject } from './validation.js';

/**
 * The pricing convention, in one place.
 *
 * Margin is charged **once**, on fresh external stake, as `entryRtp / p`.
 * Everything afterwards is fair value: a liquidation credits `p · claim`, and a
 * switch or a split re-expresses that same fair value on a different set of
 * positions at true odds. There is no second margin, so no action a player takes
 * inside a round is priced against them — which is the property the extremal
 * policy analysis in `analysis.ts` then proves by exhaustion instead of by
 * assertion.
 *
 * `liquidationSpread` is supported for definitions that want one, and it is the
 * only thing that can make two offered actions differ in expected value. The
 * shipped references declare it zero.
 */

export type CardsOfferedAction = 'hold' | 'switch' | 'split' | 'cash';

/** `1 - liquidationSpread`, the factor every liquidating action carries. */
export function liquidationFactor(definition: SequentialCardsDefinition): Rational {
  return subtract(rational(1n), definition.pricing.liquidationSpread);
}

/** `entryRtp / p`: the one and only margin, charged when fresh stake enters. */
export function entryMultiplier(
  definition: SequentialCardsDefinition,
  probability: Rational,
): Rational {
  if (probability.numerator === 0n)
    reject(
      'CLAIM_REJECTED',
      'An outcome with probability exactly zero has no finite price',
      '$.claim',
      'UNPRICEABLE_OUTCOME',
    );
  return divide(definition.pricing.entryRtp, probability);
}

export function entryClaim(
  definition: SequentialCardsDefinition,
  stake: bigint,
  probability: Rational,
): Rational {
  return multiply(rational(stake), entryMultiplier(definition, probability));
}

/** Fair value of a live claim: `p · claim`, less the declared spread. */
export function fairValue(
  definition: SequentialCardsDefinition,
  claim: Rational,
  probability: Rational,
): Rational {
  return multiply(multiply(claim, probability), liquidationFactor(definition));
}

/**
 * Moves a claim onto a different set of positions at true odds.
 *
 * `claim' = fairValue(claim, p) / q`. With a zero spread this preserves fair
 * value exactly — `q · claim' = p · claim` — so a switch and a split are claim
 * transformations rather than money movements and cross no credit boundary.
 * That is what keeps a round to one credit event per selection, and it is why
 * `switch` and `split` mint receipts with `debited: 0n, credited: 0n`.
 */
export function transformedClaim(
  definition: SequentialCardsDefinition,
  claim: Rational,
  from: Rational,
  to: Rational,
): Rational {
  if (to.numerator === 0n)
    reject(
      'CLAIM_REJECTED',
      'Cannot move a claim onto an outcome of probability exactly zero',
      '$.positions',
      'UNPRICEABLE_OUTCOME',
    );
  return divide(fairValue(definition, claim, from), to);
}

/** Hidden positions a claim can still be moved onto: hidden, and not eliminated. */
export function livePositions(belief: CardsBelief): readonly number[] {
  return belief.record.hidden.filter(
    (position) => (belief.positionWeights[position] as bigint) > 0n,
  );
}

/**
 * Whether a covered set is already decided.
 *
 * At probability exactly `0` every action is worth exactly zero, and at exactly
 * `1` holding and cashing pay the identical certain amount. Offering controls
 * in either case is three ways of receiving the same thing, so the module offers
 * none and the round settles at `p · claim`.
 */
export function isTerminalCover(belief: CardsBelief, covered: readonly number[]): boolean {
  let favourable = 0n;
  for (const position of covered) favourable += belief.positionWeights[position] as bigint;
  return favourable === 0n || favourable === belief.total;
}

export interface OfferContext {
  /** Positions another live selection already covers; a reback may not land there. */
  readonly excluded?: ReadonlySet<number>;
  /** Reveals applied so far. Liquidating actions need at least one. */
  readonly stepRevision: number;
}

/**
 * The actions a definition offers for one live claim in one state.
 *
 * `hold` is the null action and needs no command; it is listed so a host can
 * render the decision as a closed set. An empty list means the state is
 * terminal.
 */
export function offeredActions(
  definition: SequentialCardsDefinition,
  belief: CardsBelief,
  covered: readonly number[],
  context: OfferContext,
): readonly CardsOfferedAction[] {
  if (isTerminalCover(belief, covered)) return Object.freeze([]);
  const declared = definition.pricing.actions;
  const live = livePositions(belief);
  const offers: CardsOfferedAction[] = ['hold'];
  if (context.stepRevision === 0) {
    // Before any reveal the board is symmetric, so the only meaningful move is a
    // re-back: it changes which card is backed and, because every position
    // prices identically, moves no value at all.
    if (definition.backing.rebackMode === 'move' && declared.includes('switch')) {
      const targets = live.filter(
        (position) => !covered.includes(position) && context.excluded?.has(position) !== true,
      );
      if (covered.length === 1 && targets.length > 0) offers.push('switch');
    }
    return Object.freeze(offers);
  }
  if (declared.includes('switch') && live.some((position) => !covered.includes(position)))
    offers.push('switch');
  if (declared.includes('split') && live.length >= 2) offers.push('split');
  if (declared.includes('cash')) offers.push('cash');
  return Object.freeze(offers);
}

/** Exact probability of a covered set against the belief that produced it. */
export function coverProbability(belief: CardsBelief, covered: readonly number[]): Rational {
  return positionProbability(belief, covered);
}
