import { describe, expect, it } from 'vitest';
import {
  add,
  compare,
  divide,
  equal as rationalEqual,
  floor as floorRational,
  multiply,
  rational,
  subtract,
  type Rational,
} from '../../src/core/rational.js';
import { analyseDefinition } from '../../src/modules/sequential-cards/analysis.js';
import type { RevealStep } from '../../src/modules/sequential-cards/contracts.js';
import { cardsBelief, claimProbability } from '../../src/modules/sequential-cards/deck.js';
import {
  coverProbability,
  entryClaim,
  entryMultiplier,
  fairValue,
  offeredActions,
  transformedClaim,
} from '../../src/modules/sequential-cards/pricing.js';
import { triadMiddleReference } from '../../src/modules/sequential-cards/references.js';

/**
 * The oracle.
 *
 * Everything below is an **independently coded model** of the three-card
 * middle-pick game, written from the closed-form combinatorics rather than from
 * the module's implementation: the posterior comes from the hockey-stick
 * identity `C(t,2) + b·t + C(b,2) = C(12,2)`, the paytable from counting
 * triples, and the extremal policy figures from an argmin/argmax over the whole
 * state space. The module never gets to supply an expected value here — it is
 * only ever compared against one.
 *
 * The space is walked **exhaustively**: all `13 · 12 · 11 = 1,716` ordered
 * deals, times both sealed selectors, times all three backed positions. Nothing
 * is sampled, simulated, or compared to a tolerance.
 *
 * Where a figure is also published in the TRIAD design repository's own exact
 * model (`docs/MATH.md`, produced by a different tool), the literal fraction is
 * asserted here. That is deliberate: a number this repository and that one both
 * compute is only evidence if the two were derived separately.
 */

const definition = triadMiddleReference;
const LADDER = 13;
/** `C(12,2)`: the two-element subsets of the ranks the cut leaves behind. */
const SUPPORT = 66n;
/** The opening claim: `entryRtp / (1/3)`. */
const K = rational(72n, 25n);

const R = (numerator: bigint, denominator = 1n): Rational => rational(numerator, denominator);
const choose2 = (n: number): bigint => (BigInt(n) * BigInt(n - 1)) / 2n;

interface Leaf {
  readonly ranks: readonly number[];
  readonly backed: number;
  readonly cut: number;
  readonly value: number;
  readonly low: number;
  readonly high: number;
  readonly socket: 'LOW' | 'HIGH';
  readonly state: string;
  /** Independent posteriors, straight from the closed form. */
  readonly pYour: Rational;
  readonly pOther: Rational;
  readonly pCut: Rational;
  readonly objective: number;
  readonly step: RevealStep;
}

function orderedDeals(): readonly (readonly number[])[] {
  const deals: number[][] = [];
  for (let a = 1; a <= LADDER; a += 1)
    for (let b = 1; b <= LADDER; b += 1)
      for (let c = 1; c <= LADDER; c += 1) if (a !== b && a !== c && b !== c) deals.push([a, b, c]);
  return deals;
}

function middlePosition(ranks: readonly number[]): number {
  const order = ranks.map((rank, position) => ({ rank, position }));
  order.sort((left, right) => left.rank - right.rank);
  return (order[1] as { position: number }).position;
}

function leavesFor(backed: number): readonly Leaf[] {
  const leaves: Leaf[] = [];
  for (const ranks of orderedDeals()) {
    const eligible = [0, 1, 2].filter((position) => position !== backed);
    for (const selector of [0, 1]) {
      const cut = eligible[selector] as number;
      const value = ranks[cut] as number;
      const hidden = [0, 1, 2].filter((position) => position !== cut);
      const sorted = [...hidden].sort(
        (left, right) => (ranks[left] as number) - (ranks[right] as number),
      );
      const lowPosition = sorted[0] as number;
      const highPosition = sorted[1] as number;
      const below = value - 1;
      const above = LADDER - value;
      const socket = backed === lowPosition ? 'LOW' : 'HIGH';
      const pLow = rational(choose2(above), SUPPORT);
      const pHigh = rational(choose2(below), SUPPORT);
      leaves.push({
        ranks,
        backed,
        cut,
        value,
        low: lowPosition,
        high: highPosition,
        socket,
        state: `${value}:${socket}`,
        pYour: socket === 'LOW' ? pLow : pHigh,
        pOther: socket === 'LOW' ? pHigh : pLow,
        pCut: rational(BigInt(below) * BigInt(above), SUPPORT),
        objective: middlePosition(ranks),
        step: Object.freeze({
          index: 0,
          position: cut,
          rank: value,
          sorted: Object.freeze([lowPosition, highPosition]),
          label: 'triad-cut/v1:0',
        }),
      });
    }
  }
  return leaves;
}

const ALL_LEAVES = [0, 1, 2].map((backed) => leavesFor(backed));

/** The 26 information states, keyed exactly as `docs/MATH.md` keys them. */
function statesOf(leaves: readonly Leaf[]): Map<string, Leaf[]> {
  const states = new Map<string, Leaf[]>();
  for (const leaf of leaves) {
    const bucket = states.get(leaf.state);
    if (bucket === undefined) states.set(leaf.state, [leaf]);
    else bucket.push(leaf);
  }
  return states;
}

type Action = 'hold' | 'switch' | 'split' | 'cash';

/** What the four actions are worth in a state, from the independent model. */
function claimFor(leaf: Leaf, action: Action): { claim: Rational; cover: readonly number[] } {
  const value = multiply(K, leaf.pYour);
  const other = leaf.backed === leaf.low ? leaf.high : leaf.low;
  if (action === 'hold') return { claim: K, cover: [leaf.backed] };
  if (action === 'switch') return { claim: divide(value, leaf.pOther), cover: [other] };
  if (action === 'split')
    return {
      claim: divide(value, add(leaf.pYour, leaf.pOther)),
      cover: [leaf.backed, other],
    };
  return { claim: value, cover: [] };
}

function payoutOf(leaf: Leaf, action: Action): Rational {
  const { claim, cover } = claimFor(leaf, action);
  if (action === 'cash') return claim;
  return cover.includes(leaf.objective) ? claim : R(0n);
}

function availableActions(leaf: Leaf): readonly Action[] {
  if (leaf.pYour.numerator === 0n || rationalEqual(leaf.pYour, R(1n))) return [];
  const actions: Action[] = ['hold', 'cash'];
  if (leaf.pOther.numerator > 0n) actions.push('switch', 'split');
  return actions;
}

function mean(values: readonly Rational[]): Rational {
  let total = R(0n);
  for (const value of values) total = add(total, value);
  return divide(total, R(BigInt(values.length)));
}

function policyReturn(
  leaves: readonly Leaf[],
  policy: (leaf: Leaf, actions: readonly Action[]) => Action,
): { rtp: Rational; variance: Rational; hitRate: Rational } {
  const payouts = leaves.map((leaf) => {
    const actions = availableActions(leaf);
    if (actions.length === 0) return leaf.pYour.numerator === 0n ? R(0n) : K; // the cut already decided it
    return payoutOf(leaf, policy(leaf, actions));
  });
  const rtp = mean(payouts);
  const squares = mean(payouts.map((payout) => multiply(payout, payout)));
  return {
    rtp,
    variance: subtract(squares, multiply(rtp, rtp)),
    hitRate: rational(
      BigInt(payouts.filter((payout) => payout.numerator > 0n).length),
      BigInt(payouts.length),
    ),
  };
}

describe('oracle: the entire three-card middle-pick space, exhaustively', () => {
  it('walks 1,716 ordered deals and 3,432 leaves per backed position', () => {
    expect(orderedDeals()).toHaveLength(13 * 12 * 11);
    for (const leaves of ALL_LEAVES) {
      expect(leaves).toHaveLength(3432);
      const states = statesOf(leaves);
      expect(states.size).toBe(26);
      // All 26 information states are equally likely, at 132 of 3,432 leaves.
      for (const bucket of states.values()) expect(bucket).toHaveLength(132);
    }
  });

  it('prices every posterior exactly against the closed form, in all 3,432 leaves', () => {
    for (const leaves of ALL_LEAVES)
      for (const leaf of leaves) {
        const belief = cardsBelief(definition, [leaf.step]);
        expect(belief.total).toBe(SUPPORT);
        expect(coverProbability(belief, [leaf.backed])).toEqual(leaf.pYour);
        expect(coverProbability(belief, [leaf.backed === leaf.low ? leaf.high : leaf.low])).toEqual(
          leaf.pOther,
        );
        expect(coverProbability(belief, [leaf.cut])).toEqual(leaf.pCut);
        // The three are exhaustive and disjoint: C(t,2) + b·t + C(b,2) = C(12,2).
        expect(add(add(leaf.pYour, leaf.pOther), leaf.pCut)).toEqual(R(1n));
      }
  });

  it('eliminates to exactly zero, never to an epsilon, in the eight states that do', () => {
    const zeroStates = new Set<string>();
    for (const leaf of ALL_LEAVES[0] as readonly Leaf[]) {
      const belief = cardsBelief(definition, [leaf.step]);
      const weight = belief.positionWeights[leaf.backed] as bigint;
      if (leaf.pYour.numerator === 0n) {
        expect(weight).toBe(0n);
        zeroStates.add(leaf.state);
      } else expect(weight).toBeGreaterThan(0n);
    }
    // A cut of 1, 2, 12, or 13 kills one socket outright: 8 of the 26 states.
    expect([...zeroStates].sort()).toEqual(['12:LOW', '13:LOW', '1:HIGH', '2:HIGH']);
    const otherZero = new Set<string>();
    for (const leaf of ALL_LEAVES[0] as readonly Leaf[])
      if (leaf.pOther.numerator === 0n) otherZero.add(leaf.state);
    expect([...otherZero].sort()).toEqual(['12:HIGH', '13:HIGH', '1:LOW', '2:LOW']);
  });

  /**
   * The published repricing board, asserted literally.
   *
   * These fractions are `docs/MATH.md` §8 in the TRIAD design repository, which
   * generates them from its own enumerator. Re-deriving them here from the
   * module's pricing functions is the cross-check that matters: two independent
   * models, one table, no tolerance.
   */
  const BOARD: readonly (readonly [
    string,
    Rational,
    Rational,
    Rational,
    Rational | null,
    Rational | null,
    Rational | null,
    Rational | null,
  ])[] = [
    ['1:LOW', R(1n), R(0n), R(0n), null, null, null, null],
    ['1:HIGH', R(0n), R(1n), R(0n), null, null, null, null],
    ['2:LOW', R(5n, 6n), R(0n), R(1n, 6n), K, null, null, R(12n, 5n)],
    ['2:HIGH', R(0n), R(5n, 6n), R(1n, 6n), null, null, null, null],
    ['3:LOW', R(15n, 22n), R(1n, 66n), R(10n, 33n), K, R(648n, 5n), R(324n, 115n), R(108n, 55n)],
    ['3:HIGH', R(1n, 66n), R(15n, 22n), R(10n, 33n), K, R(8n, 125n), R(36n, 575n), R(12n, 275n)],
    ['4:LOW', R(6n, 11n), R(1n, 22n), R(9n, 22n), K, R(864n, 25n), R(864n, 325n), R(432n, 275n)],
    ['4:HIGH', R(1n, 22n), R(6n, 11n), R(9n, 22n), K, R(6n, 25n), R(72n, 325n), R(36n, 275n)],
    ['5:LOW', R(14n, 33n), R(1n, 11n), R(16n, 33n), K, R(336n, 25n), R(1008n, 425n), R(336n, 275n)],
    ['5:HIGH', R(1n, 11n), R(14n, 33n), R(16n, 33n), K, R(108n, 175n), R(216n, 425n), R(72n, 275n)],
    ['6:LOW', R(7n, 22n), R(5n, 33n), R(35n, 66n), K, R(756n, 125n), R(1512n, 775n), R(252n, 275n)],
    ['6:HIGH', R(5n, 33n), R(7n, 22n), R(35n, 66n), K, R(48n, 35n), R(144n, 155n), R(24n, 55n)],
    ['7:LOW', R(5n, 22n), R(5n, 22n), R(6n, 11n), K, K, R(36n, 25n), R(36n, 55n)],
    ['7:HIGH', R(5n, 22n), R(5n, 22n), R(6n, 11n), K, K, R(36n, 25n), R(36n, 55n)],
    ['8:LOW', R(5n, 33n), R(7n, 22n), R(35n, 66n), K, R(48n, 35n), R(144n, 155n), R(24n, 55n)],
    [
      '8:HIGH',
      R(7n, 22n),
      R(5n, 33n),
      R(35n, 66n),
      K,
      R(756n, 125n),
      R(1512n, 775n),
      R(252n, 275n),
    ],
    ['9:LOW', R(1n, 11n), R(14n, 33n), R(16n, 33n), K, R(108n, 175n), R(216n, 425n), R(72n, 275n)],
    [
      '9:HIGH',
      R(14n, 33n),
      R(1n, 11n),
      R(16n, 33n),
      K,
      R(336n, 25n),
      R(1008n, 425n),
      R(336n, 275n),
    ],
    ['10:LOW', R(1n, 22n), R(6n, 11n), R(9n, 22n), K, R(6n, 25n), R(72n, 325n), R(36n, 275n)],
    ['10:HIGH', R(6n, 11n), R(1n, 22n), R(9n, 22n), K, R(864n, 25n), R(864n, 325n), R(432n, 275n)],
    ['11:LOW', R(1n, 66n), R(15n, 22n), R(10n, 33n), K, R(8n, 125n), R(36n, 575n), R(12n, 275n)],
    ['11:HIGH', R(15n, 22n), R(1n, 66n), R(10n, 33n), K, R(648n, 5n), R(324n, 115n), R(108n, 55n)],
    ['12:LOW', R(0n), R(5n, 6n), R(1n, 6n), null, null, null, null],
    ['12:HIGH', R(5n, 6n), R(0n), R(1n, 6n), K, null, null, R(12n, 5n)],
    ['13:LOW', R(0n), R(1n), R(0n), null, null, null, null],
    ['13:HIGH', R(1n), R(0n), R(0n), null, null, null, null],
  ];

  it('reproduces every published price in all 26 states from the module itself', () => {
    const states = statesOf(ALL_LEAVES[0] as readonly Leaf[]);
    expect(BOARD).toHaveLength(26);
    for (const [name, pYour, pOther, pCut, hold, switched, split, cash] of BOARD) {
      const leaf = (states.get(name) as Leaf[])[0] as Leaf;
      const belief = cardsBelief(definition, [leaf.step]);
      const other = leaf.backed === leaf.low ? leaf.high : leaf.low;
      expect(coverProbability(belief, [leaf.backed]), `${name} P(your)`).toEqual(pYour);
      expect(coverProbability(belief, [other]), `${name} P(other)`).toEqual(pOther);
      expect(coverProbability(belief, [leaf.cut]), `${name} P(cut)`).toEqual(pCut);

      const offers = offeredActions(definition, belief, [leaf.backed], { stepRevision: 1 });
      expect(offers.includes('cash'), `${name} offers cash`).toBe(cash !== null);
      expect(offers.includes('switch'), `${name} offers switch`).toBe(switched !== null);
      expect(offers.includes('split'), `${name} offers split`).toBe(split !== null);
      expect(offers.length === 0, `${name} terminal`).toBe(hold === null);

      // The claim the module would price, against the published figure.
      const stake = 1n;
      const opened = entryClaim(definition, stake, R(1n, 3n));
      expect(opened).toEqual(K);
      if (hold !== null) expect(opened, `${name} HOLD`).toEqual(hold);
      const value = fairValue(definition, opened, coverProbability(belief, [leaf.backed]));
      if (cash !== null) expect(value, `${name} CASH`).toEqual(cash);
      if (switched !== null)
        expect(
          transformedClaim(
            definition,
            opened,
            coverProbability(belief, [leaf.backed]),
            coverProbability(belief, [other]),
          ),
          `${name} SWITCH`,
        ).toEqual(switched);
      if (split !== null)
        expect(
          transformedClaim(
            definition,
            opened,
            coverProbability(belief, [leaf.backed]),
            coverProbability(belief, [leaf.backed, other]),
          ),
          `${name} SPLIT`,
        ).toEqual(split);
    }
  });

  it('gives every offered action the identical exact expected value, state by state', () => {
    let decisionStates = 0;
    let terminalStates = 0;
    let fourActionStates = 0;
    for (const [name] of BOARD) {
      const leaf = (statesOf(ALL_LEAVES[0] as readonly Leaf[]).get(name) as Leaf[])[0] as Leaf;
      const actions = availableActions(leaf);
      if (actions.length === 0) {
        terminalStates += 1;
        continue;
      }
      decisionStates += 1;
      if (actions.length === 4) fourActionStates += 1;
      const expected = multiply(leaf.pYour, K);
      for (const action of actions) {
        const { claim, cover } = claimFor(leaf, action);
        const probability =
          action === 'cash'
            ? R(1n)
            : cover.reduce(
                (sum, position) =>
                  add(
                    sum,
                    position === leaf.backed
                      ? leaf.pYour
                      : position === leaf.cut
                        ? leaf.pCut
                        : leaf.pOther,
                  ),
                R(0n),
              );
        expect(multiply(probability, claim), `${name} EV of ${action}`).toEqual(expected);
      }
    }
    expect({ decisionStates, terminalStates, fourActionStates }).toEqual({
      decisionStates: 20,
      terminalStates: 6,
      fourActionStates: 18,
    });
    // 4^18 · 2^2 = 2^38 legal pure policies, not 4^26.
    expect(4n ** 18n * 2n ** 2n).toBe(2n ** 38n);
  });

  it('returns exactly 24/25 for the argmin and the argmax over every legal policy', () => {
    // Expectation is linear over the round tree and the decision point is
    // reached at most once, so the extremal policy is obtained state by state.
    for (const leaves of ALL_LEAVES) {
      const states = statesOf(leaves);
      const extremal = (pick: (values: readonly Rational[]) => number) => {
        const choice = new Map<string, Action>();
        for (const [name, bucket] of states) {
          const leaf = bucket[0] as Leaf;
          const actions = availableActions(leaf);
          if (actions.length === 0) continue;
          const values = actions.map((action) => {
            const { claim, cover } = claimFor(leaf, action);
            if (action === 'cash') return claim;
            const probability = cover.reduce(
              (sum, position) => add(sum, position === leaf.backed ? leaf.pYour : leaf.pOther),
              R(0n),
            );
            return multiply(probability, claim);
          });
          choice.set(name, actions[pick(values)] as Action);
        }
        return policyReturn(leaves, (leaf) => choice.get(leaf.state) as Action).rtp;
      };
      const argmin = extremal((values) =>
        values.reduce(
          (best, value, index) => (compare(value, values[best] as Rational) < 0 ? index : best),
          0,
        ),
      );
      const argmax = extremal((values) =>
        values.reduce(
          (best, value, index) => (compare(value, values[best] as Rational) > 0 ? index : best),
          0,
        ),
      );
      expect(argmin).toEqual(rational(24n, 25n));
      expect(argmax).toEqual(rational(24n, 25n));
    }
  });

  it('returns exactly 24/25 for every named policy, from every backed position', () => {
    const policies: Record<string, (leaf: Leaf, actions: readonly Action[]) => Action> = {
      HOLD: () => 'hold',
      CASH: () => 'cash',
      SWITCH: (_leaf, actions) => (actions.includes('switch') ? 'switch' : 'hold'),
      SPLIT: (_leaf, actions) => (actions.includes('split') ? 'split' : 'hold'),
      // "Move only onto the longer price": switch when the other card is the
      // less likely one, which is the per-state argmax of E[X^2].
      CHASE: (leaf, actions) =>
        actions.includes('switch') && compare(leaf.pYour, leaf.pOther) > 0 ? 'switch' : 'hold',
      SHIELD: (_leaf, actions) => (actions.includes('split') ? 'split' : 'cash'),
      FLIGHT: (leaf) => (compare(leaf.pYour, R(1n, 3n)) < 0 ? 'cash' : 'hold'),
    };
    const distributions: string[] = [];
    for (const leaves of ALL_LEAVES) {
      const row: string[] = [];
      for (const [name, policy] of Object.entries(policies)) {
        const result = policyReturn(leaves, policy);
        expect(result.rtp, `${name} RTP`).toEqual(rational(24n, 25n));
        row.push(
          `${name}:${result.variance.numerator}/${result.variance.denominator}:${result.hitRate.numerator}/${result.hitRate.denominator}`,
        );
      }
      distributions.push(row.join('|'));
    }
    // Position invariance: backing LEFT, CENTRE, or RIGHT is the same
    // distribution, not merely the same mean.
    expect(new Set(distributions).size).toBe(1);
  });

  it('bounds variance by CASH below and CHASE above, over the whole policy space', () => {
    const leaves = ALL_LEAVES[0] as readonly Leaf[];
    const cash = policyReturn(leaves, () => 'cash');
    const chase = policyReturn(leaves, (leaf, actions) =>
      actions.includes('switch') && compare(leaf.pYour, leaf.pOther) > 0 ? 'switch' : 'hold',
    );
    expect(cash.variance).toEqual(rational(6048n, 6875n));
    expect(chase.variance).toEqual(rational(1057392n, 40625n));
    expect(cash.hitRate).toEqual(rational(11n, 13n));
    // Every policy shares a mean, so maximising variance is maximising E[X^2],
    // which is linear over the tree exactly as E[X] is: the argmax is per state.
    const states = statesOf(leaves);
    const argmaxSquares = new Map<string, Action>();
    const argminSquares = new Map<string, Action>();
    for (const [name, bucket] of states) {
      const leaf = bucket[0] as Leaf;
      const actions = availableActions(leaf);
      if (actions.length === 0) continue;
      const squares = actions.map((action) => {
        const { claim, cover } = claimFor(leaf, action);
        if (action === 'cash') return multiply(claim, claim);
        const probability = cover.reduce(
          (sum, position) => add(sum, position === leaf.backed ? leaf.pYour : leaf.pOther),
          R(0n),
        );
        return multiply(probability, multiply(claim, claim));
      });
      let best = 0;
      let worst = 0;
      squares.forEach((value, index) => {
        if (compare(value, squares[best] as Rational) > 0) best = index;
        if (compare(value, squares[worst] as Rational) < 0) worst = index;
      });
      argmaxSquares.set(name, actions[best] as Action);
      argminSquares.set(name, actions[worst] as Action);
    }
    const highest = policyReturn(leaves, (leaf) => argmaxSquares.get(leaf.state) as Action);
    const lowest = policyReturn(leaves, (leaf) => argminSquares.get(leaf.state) as Action);
    expect(highest.variance).toEqual(chase.variance);
    expect(lowest.variance).toEqual(cash.variance);
    expect(highest.rtp).toEqual(rational(24n, 25n));
    expect(lowest.rtp).toEqual(rational(24n, 25n));
  });

  it('finds SWITCH distribution-identical to HOLD in exactly two states', () => {
    const identical = new Set<string>();
    for (const [name] of BOARD) {
      const leaf = (statesOf(ALL_LEAVES[0] as readonly Leaf[]).get(name) as Leaf[])[0] as Leaf;
      if (!availableActions(leaf).includes('switch')) continue;
      const hold = claimFor(leaf, 'hold');
      const switched = claimFor(leaf, 'switch');
      if (rationalEqual(leaf.pYour, leaf.pOther) && rationalEqual(hold.claim, switched.claim))
        identical.add(name);
    }
    expect([...identical].sort()).toEqual(['7:HIGH', '7:LOW']);
    // Closed form: p = q iff C(t,2) = C(b,2) iff v = (L+1)/2.
    expect(identical.size).toBe(2);
  });

  it('prices every side market by counting triples, and every one at exactly 24/25', () => {
    // Middle rank m occurs in (m-1)(13-m) of the C(13,3) = 286 triples.
    const counts = new Map<number, bigint>();
    let triples = 0n;
    for (let a = 1; a <= LADDER; a += 1)
      for (let b = a + 1; b <= LADDER; b += 1)
        for (let c = b + 1; c <= LADDER; c += 1) {
          counts.set(b, (counts.get(b) ?? 0n) + 1n);
          triples += 1n;
        }
    expect(triples).toBe(286n);
    for (let rank = 1; rank <= LADDER; rank += 1)
      expect(counts.get(rank) ?? 0n).toBe(BigInt((rank - 1) * (LADDER - rank)));

    const published: Record<string, Rational> = {
      'BAND:LOW': rational(1144n, 375n),
      'BAND:CORE': rational(3432n, 1325n),
      'BAND:HIGH': rational(1144n, 375n),
      'EXACT:2': rational(624n, 25n),
      'EXACT:3': rational(1716n, 125n),
      'EXACT:4': rational(2288n, 225n),
      'EXACT:5': rational(429n, 50n),
      'EXACT:6': rational(6864n, 875n),
      'EXACT:7': rational(572n, 75n),
      'EXACT:8': rational(6864n, 875n),
      'EXACT:9': rational(429n, 50n),
      'EXACT:10': rational(2288n, 225n),
      'EXACT:11': rational(1716n, 125n),
      'EXACT:12': rational(624n, 25n),
    };
    expect(definition.sideMarkets).toHaveLength(14);
    for (const market of definition.sideMarkets) {
      const favourable = market.winningRanks.reduce(
        (sum, rank) => sum + (counts.get(rank) ?? 0n),
        0n,
      );
      const counted = rational(favourable, triples);
      const priced = claimProbability(definition, [], { kind: 'market', marketId: market.id });
      expect(priced, `${market.id} probability`).toEqual(counted);
      const multiplier = entryMultiplier(definition, priced);
      expect(multiplier, `${market.id} multiplier`).toEqual(published[market.id]);
      // Every market is the same 4%: the edge does not depend on what is bet.
      expect(multiply(priced, multiplier)).toEqual(rational(24n, 25n));
    }
    // Rank 1 and rank 13 can never be the middle, so no market may name them.
    expect(counts.get(1) ?? 0n).toBe(0n);
    expect(counts.get(13) ?? 0n).toBe(0n);
    expect(
      definition.sideMarkets.some((market) =>
        market.winningRanks.some((rank) => rank === 1 || rank === 13),
      ),
    ).toBe(false);
  });

  it('agrees with the module’s own definition-time analysis on every extreme', () => {
    const analysis = analyseDefinition(definition);
    const leaves = ALL_LEAVES[0] as readonly Leaf[];
    let maximum = R(0n);
    let minimum: Rational | undefined;
    for (const leaf of leaves) {
      const actions = availableActions(leaf);
      const payouts =
        actions.length === 0
          ? [leaf.pYour.numerator === 0n ? R(0n) : K]
          : actions.map((action) => payoutOf(leaf, action));
      for (const payout of payouts) {
        if (compare(payout, maximum) > 0) maximum = payout;
        if (payout.numerator > 0n && (minimum === undefined || compare(payout, minimum) < 0))
          minimum = payout;
      }
    }
    // Side markets settle from the deal alone; their extreme is the entry claim.
    for (const market of definition.sideMarkets) {
      const multiplier = entryMultiplier(
        definition,
        claimProbability(definition, [], { kind: 'market', marketId: market.id }),
      );
      if (compare(multiplier, maximum) > 0) maximum = multiplier;
      if (minimum === undefined || compare(multiplier, minimum) < 0) minimum = multiplier;
    }
    expect(maximum).toEqual(rational(648n, 5n));
    expect(minimum).toEqual(rational(12n, 275n));
    expect(analysis.maxPayoutMultiple).toEqual(maximum);
    expect(analysis.minPositivePayoutMultiple).toEqual(minimum);
    expect(analysis.bestPolicyReturn).toEqual(rational(24n, 25n));
    expect(analysis.worstPolicyReturn).toEqual(rational(24n, 25n));
    expect(analysis.actionsValueNeutral).toBe(true);
    expect(analysis.priorUniform).toBe(true);
    // The 23-credit non-zero threshold, and that 22 really does credit zero.
    expect(analysis.nonZeroCreditThreshold).toBe(23n);
    expect(analysis.minStakeThreshold).toBe(25n);
    expect(floorRational(multiply(minimum as Rational, R(23n)))).toBe(1n);
    expect(floorRational(multiply(minimum as Rational, R(22n)))).toBe(0n);
    // The 200x rail is above every reachable payout, so it can never bind.
    expect(compare(maximum, R(definition.risk.maxWinMultiple))).toBeLessThan(0);
  });

  it('publishes the round shape as a closed form, not a feel', () => {
    const leaves = ALL_LEAVES[0] as readonly Leaf[];
    const noDecision = leaves.filter((leaf) => availableActions(leaf).length === 0);
    const endsAtZero = noDecision.filter((leaf) => leaf.pYour.numerator === 0n);
    expect(rational(BigInt(noDecision.length), BigInt(leaves.length))).toEqual(rational(3n, 13n));
    expect(rational(BigInt(endsAtZero.length), BigInt(leaves.length))).toEqual(rational(2n, 13n));
  });
});
