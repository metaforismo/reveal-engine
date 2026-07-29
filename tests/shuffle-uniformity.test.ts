import { describe, expect, it } from 'vitest';
import { samplerScopeOf } from '../src/core/module.js';
import { sha256Hex, uniformBigInt, type SamplerScope } from '../src/core/random.js';
import { compare, rational, type Rational } from '../src/core/rational.js';
import { COMMITMENT_VERSION } from '../src/core/versions.js';
import { derivePermutationOrder, permutationRound } from '../src/modules/permutation/derivation.js';
import { enumerateOrders } from '../src/modules/permutation/bets.js';
import type { PermutationDefinition } from '../src/modules/permutation/contracts.js';
import { definePermutationGame } from '../src/modules/permutation/definition.js';
import { triadReference } from '../src/modules/permutation/references/index.js';

/**
 * Regression protection for the one property this module cannot afford to get
 * wrong, and the one property that used to have no test.
 *
 * An independent reviewer edited `core/random.ts` line 146, replacing
 * `BigInt(position + 1)` with `BigInt(size)` — the classic naive-shuffle bias.
 * `npm run conformance` reported `ok: true` across all eleven checks and all
 * three references. The test suite failed six tests, five of which were frozen
 * fixtures; a routine `npm run fixtures:update` — exactly what a developer does
 * when a fixture diff appears — took it to 565/566. A grossly non-uniform draw
 * survived the repository's own machinery.
 *
 * Nothing here is a fixture, so nothing here can be regenerated away. The two
 * tests attack the same defect from opposite directions: the first pins the
 * shipped derivation to the exact draw schedule the docs declare, and the second
 * measures the distribution the shipped derivation actually produces.
 */

const SCOPE_SIZES = [3, 4, 5, 6, 7, 8] as const;

function factorial(value: number): bigint {
  let result = 1n;
  for (let step = 2n; step <= BigInt(value); step += 1n) result *= step;
  return result;
}

/**
 * A definition at every supported draw size, priced from the closed forms in
 * `docs/modules/permutation.md` §5.1 rather than from the module's own counting
 * machinery — `full` wins on one order in `n!`, everything else on one in `n` —
 * so building the subject does not borrow the code under test.
 */
function definitionOfSize(size: number): PermutationDefinition {
  const full = rational(24n * factorial(size), 25n);
  const flat = rational(24n * BigInt(size), 25n);
  return definePermutationGame({
    id: `uniformity-n${size}`,
    version: '1.0.0',
    items: Array.from({ length: size }, (_unused, index) => `item-${index}`),
    rtp: rational(24n, 25n),
    paytable: { full, slot: flat, first: flat, last: flat, stack: flat },
    maxWinMultiple: 1_000_000n,
    stakeQuantum: 25n,
    minLineStake: 25n,
    maxLineStake: 2_500n,
    maxTicketStake: 10_000n,
    maxOpenBets: 6,
  });
}

/**
 * The schedule `docs/modules/permutation.md` §2 declares, written out here
 * against the raw sampler rather than against `uniformPermutation`.
 *
 * Deliberately independent of `core/random.ts`'s loop: this is the specification
 * of the draw, and the test below is the claim that the shipped code implements
 * it. Sharing an implementation would make that claim vacuous.
 */
function orderFromDeclaredSchedule(
  seedHex: string,
  scope: SamplerScope,
  size: number,
): readonly number[] {
  const order = Array.from({ length: size }, (_unused, index) => index);
  for (let position = size - 1, draw = 0; position > 0; position -= 1, draw += 1) {
    const pick = Number(uniformBigInt(seedHex, scope, 'order', draw, BigInt(position + 1)));
    const swapped = order[position] as number;
    order[position] = order[pick] as number;
    order[pick] = swapped;
  }
  return order;
}

/** The mutation the reviewer demonstrated: every draw takes the full modulus. */
function orderFromNaiveBias(seedHex: string, scope: SamplerScope, size: number): readonly number[] {
  const order = Array.from({ length: size }, (_unused, index) => index);
  for (let position = size - 1, draw = 0; position > 0; position -= 1, draw += 1) {
    const pick = Number(uniformBigInt(seedHex, scope, 'order', draw, BigInt(size)));
    const swapped = order[position] as number;
    order[position] = order[pick] as number;
    order[pick] = swapped;
  }
  return order;
}

function probeSeed(label: string, index: number): string {
  return sha256Hex(`${label}/${index}`);
}

function probeScope(index: number): SamplerScope {
  return Object.freeze({
    domain: 'shuffle-uniformity-probe',
    roundId: `round-${index}`,
    proofVersion: COMMITMENT_VERSION,
  });
}

describe('the shipped derivation runs the schedule it declares', () => {
  it.each(SCOPE_SIZES)('reproduces the declared draw schedule at n = %i', (size) => {
    const definition = definitionOfSize(size);
    for (let index = 0; index < 64; index += 1) {
      const seedHex = probeSeed(`schedule/${size}`, index);
      const roundId = `round-${index}`;
      const scope = samplerScopeOf(permutationRound(definition, roundId));
      expect([...derivePermutationOrder(seedHex, definition, roundId)]).toStrictEqual([
        ...orderFromDeclaredSchedule(seedHex, scope, size),
      ]);
    }
  });

  /**
   * The decoy: proof that the assertion above is live rather than merely
   * consistent. If the naive-bias schedule produced the same orders, the test
   * above would pass under the mutation and be worth nothing.
   */
  it('separates the declared schedule from the naive-bias one it must exclude', () => {
    let divergences = 0;
    for (let index = 0; index < 64; index += 1) {
      const seedHex = probeSeed('decoy', index);
      const scope = probeScope(index);
      const declared = orderFromDeclaredSchedule(seedHex, scope, 5).join(',');
      if (declared !== orderFromNaiveBias(seedHex, scope, 5).join(',')) divergences += 1;
    }
    // The first draw shares a modulus with the mutation (position + 1 === size),
    // so agreement on a single round is possible; agreement on all 64 is not.
    expect(divergences).toBeGreaterThan(50);
  });
});

/**
 * A chi-square goodness-of-fit test on the real derivation, computed as an exact
 * rational and compared against an exact rational bound.
 *
 * The seeds are fixed and derived by hash, so the statistic is a constant, not a
 * sample: this test cannot flake, and the numbers in the expectations below are
 * reproducible by anyone who runs it. The bounds are the standard p = 0.001
 * critical values for the relevant degrees of freedom, which the honest
 * derivation clears by a factor of three or more and the biased one misses by
 * one to two orders of magnitude.
 */
function chiSquare(counts: ReadonlyMap<string, number>, cells: number, samples: number): Rational {
  if (samples % cells !== 0) throw new Error('sample count must divide evenly across cells');
  const expected = BigInt(samples / cells);
  let sum = 0n;
  for (const count of counts.values()) {
    const delta = BigInt(count) - expected;
    sum += delta * delta;
  }
  // Cells that never occurred contribute their full expected count.
  sum += BigInt(cells - counts.size) * expected * expected;
  return rational(sum, expected);
}

function sweep(
  definition: PermutationDefinition,
  samples: number,
  derive: (seedHex: string, scope: SamplerScope, size: number) => readonly number[],
): ReadonlyMap<string, number> {
  const size = definition.items.length;
  const counts = new Map<string, number>();
  for (let index = 0; index < samples; index += 1) {
    const seedHex = probeSeed(`uniformity/${size}`, index);
    const roundId = `round-${index}`;
    const scope = samplerScopeOf(permutationRound(definition, roundId));
    const key = derive(seedHex, scope, size).join(',');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe('the derived order is uniform over S_n', () => {
  const cases = [
    // n, samples, p = 0.001 critical value for df = n! - 1
    { size: 3, samples: 6_000, bound: rational(41n, 2n) },
    { size: 4, samples: 6_000, bound: rational(497n, 10n) },
  ] as const;

  it.each(cases)(
    'passes a chi-square goodness-of-fit sweep at n = $size',
    ({ size, samples, bound }) => {
      const definition = definitionOfSize(size);
      const cells = enumerateOrders(size).length;
      const counts = sweep(definition, samples, (seedHex, scope) =>
        derivePermutationOrder(seedHex, definition, scope.roundId),
      );

      // Every order must be reachable at all: a shuffle that cannot produce a
      // permutation is non-uniform however good its spread over the rest looks.
      expect(counts.size).toBe(cells);
      expect(compare(chiSquare(counts, cells, samples), bound)).toBeLessThan(0);
    },
  );

  /**
   * The same sweep against the mutation, so the bound above is calibrated
   * against a real alternative rather than chosen to be comfortable.
   */
  it.each(cases)('rejects the naive-bias shuffle at n = $size', ({ size, samples, bound }) => {
    const definition = definitionOfSize(size);
    const cells = enumerateOrders(size).length;
    const counts = sweep(definition, samples, orderFromNaiveBias);
    expect(compare(chiSquare(counts, cells, samples), bound)).toBeGreaterThan(0);
  });
});

describe('a shipped reference derives on schedule', () => {
  it('agrees with the declared schedule for the triad reference', () => {
    const roundId = 'triad-schedule-probe';
    const seedHex = probeSeed('triad', 0);
    const scope = samplerScopeOf(permutationRound(triadReference, roundId));
    expect([...derivePermutationOrder(seedHex, triadReference, roundId)]).toStrictEqual([
      ...orderFromDeclaredSchedule(seedHex, scope, triadReference.items.length),
    ]);
  });
});
