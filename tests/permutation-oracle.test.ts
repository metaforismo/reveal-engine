import { describe, expect, it } from 'vitest';
import { add, divide, equal, multiply, rational, type Rational } from '../src/core/rational.js';
import {
  aetherOrderClassicReference,
  aetherOrderSevenReference,
  definePermutationGame,
  enumerateInstances,
  freshProbability,
  price,
  triadReference,
  type PermutationBet,
  type PermutationDefinition,
  type PermutationOrder,
  type PermutationStep,
} from '../src/modules/permutation/index.js';

/**
 * The mandatory oracle: every probability this module quotes, recomputed from
 * scratch by code that shares nothing with it.
 *
 * Nothing below imports `betAssignments`, `betWins`, `claimSignature`,
 * `enumerateOrders`, or `core/combinatorics.ts`. The permutations are generated
 * by Heap's algorithm rather than the module's lexicographic backtracking; the
 * factorials are a local loop rather than core's; the resolve predicates are
 * written from the bet rules in prose rather than from the assignment
 * machinery. That independence is the whole point — an oracle that reuses the
 * implementation proves only that the implementation is self-consistent.
 *
 * Three separate oracles run here, and they establish different things:
 *
 * 1. a **closed-form factorial** computation of every family's probability at
 *    `n = 5` and `n = 7`, the one this module's brief names explicitly;
 * 2. an **exhaustive enumeration** of the whole order space, counting wins
 *    instance by instance, which does not assume any closed form is right;
 * 3. an **exhaustive conditional** sweep at `n = 5` over every reachable step
 *    prefix, which is the only one that exercises the counting under partial
 *    information — where a wrong implementation is most likely to survive.
 *
 * A fourth block computes the realised RTP of complete tickets by brute force
 * over every outcome, so the paytable's central claim is measured rather than
 * restated.
 */

/* ------------------------------------------------------------------ oracle */

/** Independent factorial. Deliberately not `core/combinatorics.ts`. */
function oracleFactorial(n: number): bigint {
  let result = 1n;
  for (let index = 2; index <= n; index += 1) result *= BigInt(index);
  return result;
}

function oracleGcd(a: bigint, b: bigint): bigint {
  let [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** Independent reduced fraction, compared field for field against `Rational`. */
function oracleFraction(numerator: bigint, denominator: bigint): { n: bigint; d: bigint } {
  const divisor = oracleGcd(numerator, denominator) || 1n;
  return { n: numerator / divisor, d: denominator / divisor };
}

/** Heap's algorithm: a different generator from the module's lexicographic walk. */
function heapPermutations(source: readonly number[]): number[][] {
  const values = [...source];
  const results: number[][] = [];
  const counters = new Array<number>(values.length).fill(0);
  results.push([...values]);
  let index = 0;
  while (index < values.length) {
    if (counters[index]! < index) {
      const swap = index % 2 === 0 ? 0 : counters[index]!;
      [values[index], values[swap]] = [values[swap]!, values[index]!];
      results.push([...values]);
      counters[index] = counters[index]! + 1;
      index = 0;
    } else {
      counters[index] = 0;
      index += 1;
    }
  }
  return results;
}

/**
 * The bet rules, transcribed from prose, resolved by inspecting the order.
 *
 * `stack` uses `indexOf` on both items rather than any notion of an assignment,
 * which is the point: if the module's disjunction-of-assignments model were
 * wrong about adjacency, this would disagree.
 */
function oracleWins(bet: PermutationBet, order: readonly number[]): boolean {
  switch (bet.code) {
    case 'full':
      return bet.order.length === order.length && bet.order.every((item, at) => order[at] === item);
    case 'slot':
      return order[bet.position] === bet.item;
    case 'first':
      return order[0] === bet.item;
    case 'last':
      return order[order.length - 1] === bet.item;
    case 'stack':
      return order.indexOf(bet.after) - order.indexOf(bet.before) === 1;
  }
}

/**
 * Closed-form counts, each derived from first principles rather than copied.
 *
 * - `full` pins every position: exactly one order out of `n!`.
 * - `slot`, `first`, `last` pin one position and leave `n - 1` items free:
 *   `(n-1)!`.
 * - `stack` glues the ordered pair into a single block. There are `n - 1`
 *   positions the block can start at, and for each the remaining `n - 2` items
 *   fill the remaining `n - 2` positions freely: `(n-1) * (n-2)!`, which is
 *   `(n-1)!` again — the two items are adjacent in that order exactly as often
 *   as a named item lands in a named position.
 */
function oracleFavourable(code: PermutationBet['code'], n: number): bigint {
  switch (code) {
    case 'full':
      return 1n;
    case 'slot':
    case 'first':
    case 'last':
      return oracleFactorial(n - 1);
    case 'stack':
      return BigInt(n - 1) * oracleFactorial(n - 2);
  }
}

function expectRational(actual: Rational, expected: { n: bigint; d: bigint }): void {
  expect(`${actual.numerator}/${actual.denominator}`).toBe(`${expected.n}/${expected.d}`);
}

function stepsFor(prefix: readonly number[]): readonly PermutationStep[] {
  return prefix.map((item, position) => ({ position, item }));
}

const CODES = ['full', 'slot', 'first', 'last', 'stack'] as const;

/* ------------------------------------------------------ 1. closed-form oracle */

describe('closed-form factorial oracle, n = 5 and n = 7', () => {
  it.each([
    ['n = 5 (AETHER ORDER CLASSIC)', aetherOrderClassicReference],
    ['n = 7 (AETHER ORDER SEVEN)', aetherOrderSevenReference],
  ])(
    '%s prices every instance of every family at its counted probability',
    (_label, definition) => {
      const n = definition.items.length;
      const total = oracleFactorial(n);
      let checked = 0;
      for (const code of CODES) {
        const expected = oracleFraction(oracleFavourable(code, n), total);
        for (const instance of enumerateInstances(definition, code)) {
          expectRational(freshProbability(definition, instance), expected);
          checked += 1;
        }
      }
      // Every instance, not a sample: n! + n^2 + 2n + n(n-1).
      expect(checked).toBe(Number(total) + n * n + 2 * n + n * (n - 1));
    },
  );

  it.each([
    ['n = 5', aetherOrderClassicReference, { full: '1/120', slot: '1/5', stack: '1/5' }],
    ['n = 7', aetherOrderSevenReference, { full: '1/5040', slot: '1/7', stack: '1/7' }],
    ['n = 3', triadReference, { full: '1/6', slot: '1/3', stack: '1/3' }],
  ])('%s matches the published figures literally', (_label, definition, published) => {
    const render = (bet: PermutationBet): string => {
      const value = freshProbability(definition, bet);
      return `${value.numerator}/${value.denominator}`;
    };
    const order = definition.items.map((_item, index) => index);
    expect(render({ code: 'full', order })).toBe(published.full);
    expect(render({ code: 'slot', item: 0, position: 1 })).toBe(published.slot);
    expect(render({ code: 'first', item: 0 })).toBe(published.slot);
    expect(render({ code: 'last', item: 0 })).toBe(published.slot);
    expect(render({ code: 'stack', before: 0, after: 1 })).toBe(published.stack);
  });

  /**
   * The pricing identity, against the oracle rather than against the module's
   * own probability: `m x p = rho`, exactly, for every published multiplier.
   */
  it.each([aetherOrderClassicReference, aetherOrderSevenReference, triadReference])(
    '$id publishes multipliers that price the declared RTP exactly',
    (definition) => {
      const n = definition.items.length;
      const total = oracleFactorial(n);
      for (const code of CODES) {
        const counted = oracleFraction(oracleFavourable(code, n), total);
        const product = multiply(definition.paytable[code], rational(counted.n, counted.d));
        expect(
          equal(product, definition.rtp),
          `${code} prices ${product.numerator}/${product.denominator}`,
        ).toBe(true);
      }
    },
  );
});

/* ------------------------------------------- 2. exhaustive enumeration oracle */

describe('exhaustive enumeration oracle over the whole order space', () => {
  it.each([
    ['n = 5', aetherOrderClassicReference],
    ['n = 7', aetherOrderSevenReference],
  ])('%s counts every non-full instance win by win', (_label, definition) => {
    const n = definition.items.length;
    const orders = heapPermutations(definition.items.map((_item, index) => index));
    expect(orders).toHaveLength(Number(oracleFactorial(n)));
    expect(new Set(orders.map((order) => order.join(','))).size).toBe(orders.length);

    for (const code of CODES) {
      if (code === 'full') continue;
      for (const instance of enumerateInstances(definition, code)) {
        let wins = 0n;
        for (const order of orders) if (oracleWins(instance, order)) wins += 1n;
        expectRational(
          freshProbability(definition, instance),
          oracleFraction(wins, oracleFactorial(n)),
        );
      }
    }
  });

  /**
   * `full` gets its own treatment because pairing `n!` instances against `n!`
   * orders is `(n!)^2`, which at `n = 7` is 25 million comparisons for a fact
   * with a one-line proof. The exhaustive statement made here is the one that
   * matters: the map from a full-order instance to the single order it wins on
   * is a **bijection** onto the whole space, checked for every instance.
   */
  it.each([
    ['n = 5', aetherOrderClassicReference],
    ['n = 7', aetherOrderSevenReference],
  ])('%s maps every full-order instance onto exactly one distinct order', (_label, definition) => {
    const orders = heapPermutations(definition.items.map((_item, index) => index));
    const targets = new Set<string>();
    for (const order of orders) {
      const bet: PermutationBet = { code: 'full', order };
      expect(oracleWins(bet, order)).toBe(true);
      // A different order loses: rotating one place changes at least two slots.
      expect(oracleWins(bet, [...order.slice(1), order[0]!])).toBe(false);
      targets.add(order.join(','));
      expectRational(
        freshProbability(definition, bet),
        oracleFraction(1n, oracleFactorial(definition.items.length)),
      );
    }
    expect(targets.size).toBe(orders.length);
  });
});

/* ------------------------------------- 3. exhaustive conditional-price oracle */

describe('exhaustive conditional oracle over every reachable prefix, n = 5', () => {
  const definition = aetherOrderClassicReference;
  const n = definition.items.length;
  const items = definition.items.map((_item, index) => index);
  const orders = heapPermutations(items);

  /** Every distinct settle prefix a round can reach, including the empty one. */
  const prefixes: number[][] = [];
  const seen = new Set<string>();
  for (const order of orders)
    for (let length = 0; length < n; length += 1) {
      const prefix = order.slice(0, length);
      const key = prefix.join(',');
      if (!seen.has(key)) {
        seen.add(key);
        prefixes.push(prefix);
      }
    }

  it('reaches every prefix the schedule can produce', () => {
    // Sum of P(5, m) for m = 0..4 = 1 + 5 + 20 + 60 + 120.
    expect(prefixes).toHaveLength(206);
  });

  it('prices every instance against a brute-force completion count', () => {
    const instances = CODES.flatMap((code) => [...enumerateInstances(definition, code)]);
    expect(instances).toHaveLength(120 + 25 + 5 + 5 + 20);
    let comparisons = 0;
    for (const prefix of prefixes) {
      const steps = stepsFor(prefix);
      const remaining = items.filter((item) => !prefix.includes(item));
      const completions = heapPermutations(remaining).map((tail) => [...prefix, ...tail]);
      for (const instance of instances) {
        let wins = 0n;
        for (const order of completions) if (oracleWins(instance, order)) wins += 1n;
        expectRational(
          price(definition, steps, instance),
          oracleFraction(wins, BigInt(completions.length)),
        );
        comparisons += 1;
      }
    }
    expect(comparisons).toBe(206 * 175);
  });

  /**
   * The same sweep at the module's floor, where the counting has the least room
   * to hide: three items, six orders, two reveals.
   */
  it('prices the three-item floor exhaustively too', () => {
    const triad = triadReference;
    const triadItems = [0, 1, 2];
    const instances = CODES.flatMap((code) => [...enumerateInstances(triad, code)]);
    for (const order of heapPermutations(triadItems))
      for (let length = 0; length < 3; length += 1) {
        const prefix = order.slice(0, length);
        const completions = heapPermutations(
          triadItems.filter((item) => !prefix.includes(item)),
        ).map((tail) => [...prefix, ...tail]);
        for (const instance of instances) {
          let wins = 0n;
          for (const candidate of completions) if (oracleWins(instance, candidate)) wins += 1n;
          expectRational(
            price(triad, stepsFor(prefix), instance),
            oracleFraction(wins, BigInt(completions.length)),
          );
        }
      }
  });
});

/* ---------------------------------------------- 4. realised RTP, by brute force */

describe('realised RTP measured over every outcome', () => {
  interface Line {
    readonly bet: PermutationBet;
    readonly stake: bigint;
  }

  /**
   * Exact expected return of a ticket: the mean gross over the whole space.
   *
   * The *counting* is independent — outcomes from Heap's algorithm, wins from
   * the prose predicates above, nothing from the module. The rational
   * arithmetic is core's, deliberately: core's exactness has its own oracle in
   * `tests/math-oracle-invariants.test.ts`, and reimplementing BigInt fractions
   * a third time here would test that reimplementation rather than this module.
   */
  function measuredReturn(definition: PermutationDefinition, lines: readonly Line[]): Rational {
    const orders = heapPermutations(definition.items.map((_item, index) => index));
    let total = rational(0n);
    for (const order of orders)
      for (const line of lines)
        if (oracleWins(line.bet, order))
          total = add(total, multiply(rational(line.stake), definition.paytable[line.bet.code]));
    const stake = lines.reduce((sum, line) => sum + line.stake, 0n);
    return divide(total, rational(BigInt(orders.length) * stake));
  }

  const ticketsFor = (definition: PermutationDefinition): readonly (readonly Line[])[] => {
    const n = definition.items.length;
    const identity: PermutationOrder = definition.items.map((_item, index) => index);
    return [
      [{ bet: { code: 'first', item: 0 }, stake: 100n }],
      [{ bet: { code: 'full', order: identity }, stake: 25n }],
      // A perfect hedge: one FIRST per item. Exactly one always wins, so the
      // ticket is a deterministic fee and the mean has nowhere to hide.
      identity.map((item) => ({ bet: { code: 'first' as const, item }, stake: 25n })),
      // Correlated and mutually exclusive lines in the same ticket.
      [
        { bet: { code: 'full', order: identity }, stake: 25n },
        { bet: { code: 'slot', item: 0, position: 0 }, stake: 50n },
        { bet: { code: 'stack', before: 0, after: 1 }, stake: 75n },
        { bet: { code: 'last', item: n - 1 }, stake: 100n },
      ],
      // A barbell: the rarest chip against the most frequent one.
      [
        { bet: { code: 'full', order: [...identity].reverse() }, stake: 25n },
        { bet: { code: 'slot', item: 1, position: n - 2 }, stake: definition.maxLineStake },
      ],
    ];
  };

  it.each([aetherOrderClassicReference, aetherOrderSevenReference, triadReference])(
    '$id returns exactly its declared RTP on every structured ticket',
    (definition) => {
      for (const [index, lines] of ticketsFor(definition).entries()) {
        const measured = measuredReturn(definition, lines);
        expect(
          equal(measured, definition.rtp),
          `ticket ${index} measured ${measured.numerator}/${measured.denominator}`,
        ).toBe(true);
      }
    },
  );

  /**
   * The perfect hedge is the sharpest statement the paytable can make: one
   * `first` per item means exactly one line always wins, so the return is not a
   * mean over outcomes but a constant. If that constant is `rho`, there is no
   * edge to find anywhere in the catalogue.
   */
  it.each([aetherOrderClassicReference, aetherOrderSevenReference, triadReference])(
    '$id turns a complete hedge into a deterministic fee, not a gamble',
    (definition) => {
      const stake = definition.minLineStake;
      const orders = heapPermutations(definition.items.map((_item, index) => index));
      const lines = definition.items.map((_label, item) => ({
        bet: { code: 'first' as const, item },
        stake,
      }));
      const totalStake = stake * BigInt(lines.length);
      for (const order of orders) {
        const winners = lines.filter((line) => oracleWins(line.bet, order));
        expect(winners).toHaveLength(1);
        const gross = multiply(
          rational(winners[0]!.stake),
          definition.paytable[winners[0]!.bet.code],
        );
        expect(gross.denominator).toBe(1n);
        expect(equal(rational(gross.numerator, totalStake), definition.rtp)).toBe(true);
      }
    },
  );

  /**
   * Zero rounding drift, stated as a theorem and checked as one.
   *
   * Every published multiplier's denominator divides the stake quantum and every
   * legal stake is a multiple of it, so `stake x multiplier` is an exact integer
   * for every legal line and the floor at the credit boundary removes nothing.
   * This is stronger than "a floor loses at most one minor unit": there is
   * nothing to lose.
   */
  it.each([aetherOrderClassicReference, aetherOrderSevenReference, triadReference])(
    '$id pays whole units for every legal stake on the ladder',
    (definition) => {
      for (
        let stake = definition.minLineStake;
        stake <= definition.maxLineStake;
        stake += definition.stakeQuantum
      )
        for (const code of CODES) {
          const payout = multiply(rational(stake), definition.paytable[code]);
          expect(payout.denominator, `${code} at stake ${stake}`).toBe(1n);
        }
    },
  );

  /** A paytable that misses the identity cannot be constructed at all. */
  it('refuses to define a game whose multiplier does not price the declared RTP', () => {
    expect(() =>
      definePermutationGame({
        ...triadReference,
        id: 'mispriced',
        paytable: { ...triadReference.paytable, stack: rational(73n, 25n) },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER', path: '$.paytable.stack' }));
  });
});
