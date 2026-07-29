import { fail } from '../../api/errors.js';
import {
  add,
  compare,
  divide,
  equal as rationalEqual,
  multiply,
  rational,
  type Rational,
} from '../../core/rational.js';
import type { RevealStep, SequentialCardsDefinition } from './contracts.js';
import { cardsBelief, forEachCombination, objectiveIndex, type CardsBelief } from './deck.js';
import {
  coverProbability,
  entryMultiplier,
  fairValue,
  isTerminalCover,
  liquidationFactor,
  livePositions,
  transformedClaim,
} from './pricing.js';
import { reject } from './validation.js';

/**
 * Definition-time proof by exhaustion.
 *
 * Every economic claim a definition makes is settled here by walking the whole
 * reachable space in exact rationals — never by a closed form the reader has to
 * trust, and never by a shortlist of named policies. A named shortlist is not a
 * bound: where this file reports an extreme it is an argmin or an argmax over
 * the entire admissible set.
 *
 * ## The canonical board
 *
 * The walk enumerates hands as **ascending rank sets** and identifies board
 * position `i` with the `i`-th smallest rank of the hand. That is a relabelling,
 * not an approximation: a real board is a uniform permutation of this one, the
 * sealed selector picks uniformly from the eligible set in board order, and
 * every quantity below depends on a position only through its rank order, which
 * positions are backed, and which have been revealed — all of which the walk
 * enumerates. Working in the canonical layout removes a factor of `dealt!` from
 * the enumeration and changes no number it produces;
 * `tests/sequential-cards/oracle-three-card.test.ts` re-derives the same figures
 * in real board space from an independently coded model.
 *
 * ## What is enumerated, and what is argued
 *
 * Enumerated: every hand, every backed set, every backed position inside it,
 * every reveal outcome, every reachable `(state, covered set)` pair, and every
 * offered action at each of them.
 *
 * Argued, with each argument checked here rather than assumed:
 *
 * - **Action neutrality is an identity in the claim.** Expected value is linear
 *   in the claim, so verifying `switch/split/cash = p·K·(1−σ)` at `K = 1` in a
 *   state establishes it for every claim in that state. The walk checks it at
 *   every reachable state and reports `pricingIdentityHolds`.
 * - **A re-back is a scalar.** Before any reveal the prior is uniform (asserted
 *   below), so a re-back moves the claim onto a position at the identical price:
 *   it multiplies the claim by exactly `(1−σ)` and leaves the reachable state
 *   tree unchanged. It therefore cannot raise the maximum payout, and it lowers
 *   the minimum and the worst policy by exactly that factor — applied as a
 *   scalar instead of doubling the search.
 * - **Every legal policy returns the same thing, so the extremes need no
 *   search.** `assertCardsDefinition` accepts only `liquidationSpread = 0`, and
 *   at a zero spread the identity above makes every offered action — hold
 *   included — worth exactly `p · K`. Expectation is linear over the round tree
 *   and the decision point is reached at most once per window, so every legal
 *   policy has the identical return. The walk therefore computes two concrete
 *   policies, never-act and act-whenever-offered, and `bestPolicyReturn` and
 *   `worstPolicyReturn` are the **whole range** rather than two samples of it —
 *   `CARDS_POLICY_RETURN_EXTREMAL` asserts they are equal and equal to
 *   `entryRtp`, which is what makes that reading legitimate. The `(1−σ)`
 *   arithmetic below is kept general so a future revision that implements a
 *   spread has to confront the argmin search rather than inherit this claim.
 */

/** Reachable `(state, covered set)` pairs one analysis may visit. */
export const CARDS_MAX_ANALYSIS_CELLS = 3_000_000;

export interface CardsAnalysis {
  /** `(hand, backed set, backed position, reveal path)` lines walked. */
  readonly lines: number;
  /** Reachable `(state, covered set)` pairs visited. */
  readonly cells: number;
  readonly decisionCells: number;
  readonly terminalCells: number;
  /** Largest payout any reachable line produces, as a multiple of one stake. */
  readonly maxPayoutMultiple: Rational;
  /** Smallest strictly positive payout any reachable line produces. */
  readonly minPositivePayoutMultiple: Rational;
  /** `ceil(1 / minPositivePayoutMultiple)`: below this a live claim can credit zero. */
  readonly nonZeroCreditThreshold: bigint;
  /** The same threshold rounded up to the declared stake step. */
  readonly minStakeThreshold: bigint;
  /** Every liquidating action realises exactly `p · K · (1 − spread)`, everywhere. */
  readonly pricingIdentityHolds: boolean;
  /** True when every offered action, hold included, has the identical exact value. */
  readonly actionsValueNeutral: boolean;
  /**
   * Exact return of the never-act policy, per unit of stake.
   *
   * At the zero spread this module requires, every legal policy returns the same
   * thing, so this and `worstPolicyReturn` bracket a set with one member — which
   * `CARDS_POLICY_RETURN_EXTREMAL` checks by requiring them equal.
   */
  readonly bestPolicyReturn: Rational;
  /** Exact return of the act-whenever-offered policy, per unit of stake. */
  readonly worstPolicyReturn: Rational;
  /** Cells where an offered control has the identical return distribution as holding. */
  readonly identicalActionCells: number;
  /** The prior over board positions is uniform, which is what makes a re-back free. */
  readonly priorUniform: boolean;
}

interface ClaimRange {
  min: Rational;
  max: Rational;
}

interface WorstTrack {
  mask: number;
  claim: Rational;
  settled: Rational | undefined;
}

function widen(range: ClaimRange, value: Rational): void {
  if (compare(value, range.min) < 0) range.min = value;
  if (compare(value, range.max) > 0) range.max = value;
}

function maskPositions(mask: number, dealt: number): number[] {
  const positions: number[] = [];
  for (let position = 0; position < dealt; position += 1)
    if ((mask & (1 << position)) !== 0) positions.push(position);
  return positions;
}

function maskOf(positions: readonly number[]): number {
  let mask = 0;
  for (const position of positions) mask |= 1 << position;
  return mask;
}

/**
 * Streams every reachable information state of a definition, once each.
 *
 * Same canonical board as `analyseDefinition`: hands are ascending rank sets and
 * board position `i` holds the `i`-th smallest rank. A conformance check that
 * needs "every state this definition can reach" walks this rather than sampling
 * rounds, so its evidence is exhaustive by construction.
 */
export function forEachCanonicalState(
  definition: SequentialCardsDefinition,
  visit: (context: {
    readonly hand: readonly number[];
    readonly backed: ReadonlySet<number>;
    readonly steps: readonly RevealStep[];
    readonly belief: CardsBelief;
  }) => void,
): void {
  const { size, dealt } = definition.ladder;
  const walk = (
    hand: readonly number[],
    backed: ReadonlySet<number>,
    steps: RevealStep[],
  ): void => {
    visit({ hand, backed, steps: [...steps], belief: cardsBelief(definition, steps) });
    if (steps.length === definition.reveal.count) return;
    const revealed = new Set(steps.map((step) => step.position));
    for (let position = 0; position < dealt; position += 1) {
      if (revealed.has(position)) continue;
      if (definition.reveal.eligibility === 'unbacked' && backed.has(position)) continue;
      const hidden: number[] = [];
      for (let candidate = 0; candidate < dealt; candidate += 1)
        if (candidate !== position && !revealed.has(candidate)) hidden.push(candidate);
      steps.push(
        Object.freeze({
          index: steps.length,
          position,
          rank: hand[position] as number,
          sorted: Object.freeze(definition.reveal.sortRemaining ? hidden : []),
          label: `${definition.reveal.modelVersion}:${steps.length}`,
        }),
      );
      walk(hand, backed, steps);
      steps.pop();
    }
  };
  forEachCombination(size, dealt, (handIndices) => {
    const hand = handIndices.map((index) => index + 1);
    forEachCombination(dealt, definition.backing.maxOpenBeforeReveal, (backedIndices) =>
      walk(hand, new Set(backedIndices), []),
    );
  });
}

/** Cached per definition object identity; the walk is pure and several callers want it. */
const CACHE = new WeakMap<SequentialCardsDefinition, CardsAnalysis>();

export function analyseDefinition(definition: SequentialCardsDefinition): CardsAnalysis {
  const cached = CACHE.get(definition);
  if (cached !== undefined) return cached;
  const analysis = runAnalysis(definition);
  CACHE.set(definition, analysis);
  return analysis;
}

function runAnalysis(definition: SequentialCardsDefinition): CardsAnalysis {
  const { size, dealt } = definition.ladder;
  const revealCount = definition.reveal.count;
  const backingWidth = definition.backing.maxOpenBeforeReveal;
  const factor = liquidationFactor(definition);
  const objective = objectiveIndex(definition);
  const offersSwitch = definition.pricing.actions.includes('switch');
  const offersSplit = definition.pricing.actions.includes('split');
  const offersCash = definition.pricing.actions.includes('cash');
  const rebackCosts = definition.backing.rebackMode === 'move' && offersSwitch;

  const prior = cardsBelief(definition, []);
  const firstWeight = prior.positionWeights[0] as bigint;
  const priorUniform = prior.positionWeights.every((weight) => weight === firstWeight);
  const entryClaimPerStake = entryMultiplier(definition, rational(firstWeight, prior.total));

  const beliefMemo = new Map<string, CardsBelief>();
  const beliefFor = (hand: readonly number[], revealed: readonly number[]): CardsBelief => {
    const key = revealed.map((position) => `${position}:${hand[position] as number}`).join('|');
    const hit = beliefMemo.get(key);
    if (hit !== undefined) return hit;
    const seen = new Set<number>();
    const steps: RevealStep[] = [];
    revealed.forEach((position, index) => {
      seen.add(position);
      const hidden: number[] = [];
      for (let candidate = 0; candidate < dealt; candidate += 1)
        if (!seen.has(candidate)) hidden.push(candidate);
      steps.push(
        Object.freeze({
          index,
          position,
          rank: hand[position] as number,
          // The canonical board is ordered by rank, so the published sort is the
          // ascending list of the positions that are still hidden.
          sorted: Object.freeze(definition.reveal.sortRemaining ? hidden : []),
          label: `${definition.reveal.modelVersion}:${index}`,
        }),
      );
    });
    const belief = cardsBelief(definition, steps);
    beliefMemo.set(key, belief);
    return belief;
  };

  let lines = 0;
  let cells = 0;
  let decisionCells = 0;
  let terminalCells = 0;
  let identicalActionCells = 0;
  let pricingIdentityHolds = true;
  let maxPayout = rational(0n);
  let minPositivePayout: Rational | undefined;
  let bestTotal = rational(0n);
  let worstTotal = rational(0n);
  let leaves = 0n;

  const recordPayout = (value: Rational): void => {
    if (compare(value, maxPayout) > 0) maxPayout = value;
    if (
      value.numerator > 0n &&
      (minPositivePayout === undefined || compare(value, minPositivePayout) < 0)
    )
      minPositivePayout = value;
  };

  const budget = (): void => {
    cells += 1;
    if (cells > CARDS_MAX_ANALYSIS_CELLS)
      reject(
        'INVALID_ADAPTER',
        'The definition reachable space is too large to prove its economics by exhaustion',
        '$.ladder',
        'ANALYSIS_SPACE_TOO_LARGE',
      );
  };

  /** Every split target set: at least two live positions, all strictly priceable. */
  const splitSetsOf = (live: readonly number[]): number[][] => {
    if (!offersSplit || live.length < 2) return [];
    const sets: number[][] = [];
    for (let width = 2; width <= live.length; width += 1)
      forEachCombination(live.length, width, (indices) =>
        sets.push(indices.map((index) => live[index] as number)),
      );
    return sets;
  };

  /**
   * One decision window: records every payout a liquidating action could realise
   * here, and returns the claim ranges that survive into the next reveal.
   */
  const window = (
    belief: CardsBelief,
    revision: number,
    incoming: ReadonlyMap<number, ClaimRange>,
  ): Map<number, ClaimRange> => {
    const outgoing = new Map<number, ClaimRange>();
    const merge = (mask: number, value: Rational): void => {
      const existing = outgoing.get(mask);
      if (existing === undefined) outgoing.set(mask, { min: value, max: value });
      else widen(existing, value);
    };
    const live = livePositions(belief);
    const splitSets = splitSetsOf(live);
    const unit = rational(1n);
    for (const [mask, range] of incoming) {
      budget();
      const covered = maskPositions(mask, dealt);
      // Holding is always available and needs no command, so every incoming
      // claim survives the window unchanged.
      merge(mask, range.min);
      merge(mask, range.max);
      if (isTerminalCover(belief, covered)) {
        terminalCells += 1;
        continue;
      }
      decisionCells += 1;
      if (revision === 0) continue;

      const probability = coverProbability(belief, covered);
      const liquidValue = multiply(multiply(probability, unit), factor);
      let sameDistribution = false;

      if (offersCash) {
        if (!rationalEqual(fairValue(definition, unit, probability), liquidValue))
          pricingIdentityHolds = false;
        for (const claim of [range.min, range.max])
          recordPayout(fairValue(definition, claim, probability));
      }
      if (offersSwitch)
        for (const target of live) {
          if (covered.includes(target)) continue;
          const targetProbability = coverProbability(belief, [target]);
          if (
            !rationalEqual(
              multiply(
                targetProbability,
                transformedClaim(definition, unit, probability, targetProbability),
              ),
              liquidValue,
            )
          )
            pricingIdentityHolds = false;
          if (covered.length === 1 && rationalEqual(targetProbability, probability))
            sameDistribution = true;
          for (const claim of [range.min, range.max])
            merge(1 << target, transformedClaim(definition, claim, probability, targetProbability));
        }
      for (const set of splitSets) {
        const setProbability = coverProbability(belief, set);
        if (
          !rationalEqual(
            multiply(
              setProbability,
              transformedClaim(definition, unit, probability, setProbability),
            ),
            liquidValue,
          )
        )
          pricingIdentityHolds = false;
        for (const claim of [range.min, range.max])
          merge(maskOf(set), transformedClaim(definition, claim, probability, setProbability));
      }
      if (sameDistribution) identicalActionCells += 1;
    }
    return outgoing;
  };

  /**
   * The act-whenever-offered policy, preferring an action that keeps the round
   * alive so the line takes as many of them as the definition allows.
   *
   * At a zero spread this returns exactly what never-acting returns, and the two
   * together are the whole range. It is deliberately **not** an argmin search:
   * the target it picks among equally-valued live positions is arbitrary, which
   * is only sound because every choice is worth the same. A spread would make
   * that arbitrary pick a wrong answer, which is why one is refused.
   */
  const worstStep = (belief: CardsBelief, revision: number, track: WorstTrack): void => {
    if (track.settled !== undefined || revision === 0) return;
    const covered = maskPositions(track.mask, dealt);
    if (isTerminalCover(belief, covered)) return;
    const probability = coverProbability(belief, covered);
    const live = livePositions(belief).filter((position) => !covered.includes(position));
    const canSwitch = offersSwitch && live.length > 0;
    if (revision < revealCount && canSwitch) {
      const target = live[0] as number;
      track.claim = transformedClaim(
        definition,
        track.claim,
        probability,
        coverProbability(belief, [target]),
      );
      track.mask = 1 << target;
      return;
    }
    if (offersCash) {
      track.settled = fairValue(definition, track.claim, probability);
      return;
    }
    if (canSwitch) {
      const target = live[0] as number;
      track.claim = transformedClaim(
        definition,
        track.claim,
        probability,
        coverProbability(belief, [target]),
      );
      track.mask = 1 << target;
    }
  };

  const walk = (
    hand: readonly number[],
    backed: ReadonlySet<number>,
    start: number,
    revealed: number[],
    incoming: ReadonlyMap<number, ClaimRange>,
    worst: WorstTrack,
  ): void => {
    const revision = revealed.length;
    const belief = beliefFor(hand, revealed);
    const outgoing = window(belief, revision, incoming);
    const worstHere: WorstTrack = { ...worst };
    worstStep(belief, revision, worstHere);

    if (revision === revealCount) {
      lines += 1;
      leaves += 1n;
      for (const [mask, range] of outgoing)
        if ((mask & (1 << objective)) !== 0) {
          recordPayout(range.min);
          recordPayout(range.max);
        }
      // The best policy never acts: the claim its stake bought stays where it
      // was put, so the line pays iff the backed position holds the objective.
      bestTotal = add(bestTotal, start === objective ? entryClaimPerStake : rational(0n));
      worstTotal = add(
        worstTotal,
        worstHere.settled ??
          ((worstHere.mask & (1 << objective)) !== 0 ? worstHere.claim : rational(0n)),
      );
      return;
    }
    for (let position = 0; position < dealt; position += 1) {
      if (revealed.includes(position)) continue;
      if (definition.reveal.eligibility === 'unbacked' && backed.has(position)) continue;
      revealed.push(position);
      walk(hand, backed, start, revealed, outgoing, worstHere);
      revealed.pop();
    }
  };

  forEachCombination(size, dealt, (handIndices) => {
    const hand = handIndices.map((index) => index + 1);
    forEachCombination(dealt, backingWidth, (backedIndices) => {
      const backed = new Set(backedIndices);
      for (const start of backedIndices)
        walk(
          hand,
          backed,
          start,
          [],
          new Map<number, ClaimRange>([
            [1 << start, { min: entryClaimPerStake, max: entryClaimPerStake }],
          ]),
          { mask: 1 << start, claim: entryClaimPerStake, settled: undefined },
        );
    });
  });

  // A side market never transforms and never liquidates: its only payout is the
  // settlement of the claim its entry price bought.
  for (const market of definition.sideMarkets) {
    let favourable = 0n;
    for (const rank of market.winningRanks) favourable += prior.rankWeights[rank] as bigint;
    if (favourable <= 0n)
      reject(
        'INVALID_ADAPTER',
        `Side market ${market.id} can never pay`,
        '$.sideMarkets',
        'INVALID_SIDE_MARKET',
      );
    recordPayout(entryMultiplier(definition, rational(favourable, prior.total)));
  }

  if (minPositivePayout === undefined || leaves === 0n)
    fail('INVALID_ADAPTER', 'The definition has no reachable payout', '$.pricing');

  // A re-back is exactly one liquidation factor on a uniform prior: it cannot
  // raise the maximum, and it lowers the minimum and the worst policy by (1-σ).
  const minPositivePayoutMultiple = rebackCosts
    ? multiply(minPositivePayout, factor)
    : minPositivePayout;

  const denominator = rational(leaves);
  const bestPolicyReturn = divide(bestTotal, denominator);
  const worstPolicyReturn = divide(
    rebackCosts ? multiply(worstTotal, factor) : worstTotal,
    denominator,
  );

  const step = definition.pricing.stakeStepCredits;
  const nonZeroCreditThreshold =
    (minPositivePayoutMultiple.denominator + minPositivePayoutMultiple.numerator - 1n) /
    minPositivePayoutMultiple.numerator;
  const minStakeThreshold = ((nonZeroCreditThreshold + step - 1n) / step) * step;

  return Object.freeze({
    lines,
    cells,
    decisionCells,
    terminalCells,
    maxPayoutMultiple: maxPayout,
    minPositivePayoutMultiple,
    nonZeroCreditThreshold,
    minStakeThreshold,
    pricingIdentityHolds,
    actionsValueNeutral:
      pricingIdentityHolds && definition.pricing.liquidationSpread.numerator === 0n,
    bestPolicyReturn,
    worstPolicyReturn,
    identicalActionCells,
    priorUniform,
  });
}
