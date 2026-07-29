import { fail } from '../api/errors.js';
import { ENGINE_LIMITS } from '../api/limits.js';
import { rational, type Rational } from './rational.js';

/**
 * Exact counting over structured truth spaces.
 *
 * A flat `WeightVector` is bounded by `ENGINE_LIMITS.maxOutcomes`, which is the
 * right shape for "which of n outcomes is true" and the wrong shape for a
 * paytable priced over orderings: `5!` already exceeds the limit and a trifecta
 * over eight runners is 336 events. A module whose belief space is `marginal`
 * prices its claims here instead — by counting how many truths remain consistent
 * with the revealed steps, and how many of those also satisfy the bet.
 *
 * Everything is BigInt. No factorial is ever approximated.
 */

const MAX_N = ENGINE_LIMITS.maxPermutationSize;

function assertSize(n: unknown, path: string): asserts n is number {
  if (!Number.isSafeInteger(n) || (n as number) < 0 || (n as number) > MAX_N)
    fail('INVALID_CONTEXT', `Count must be a safe integer in [0, ${MAX_N}]`, path);
}

/** Exact `n!`. */
export function factorial(n: number): bigint {
  assertSize(n, '$.n');
  let result = 1n;
  for (let index = 2n; index <= BigInt(n); index += 1n) result *= index;
  return result;
}

/**
 * Exact `n · (n-1) ··· (n-k+1)`: the number of ordered `k`-tuples drawn from `n`
 * distinct items. `fallingFactorial(n, n)` is `n!`; `k > n` is zero.
 */
export function fallingFactorial(n: number, k: number): bigint {
  assertSize(n, '$.n');
  assertSize(k, '$.k');
  if (k > n) return 0n;
  let result = 1n;
  for (let index = 0; index < k; index += 1) result *= BigInt(n - index);
  return result;
}

/**
 * Exact probability as a counting measure: `favourable / support`.
 *
 * The support is the number of truths still consistent with everything revealed;
 * a support of zero means the module has revealed a contradiction and is a
 * failure, not a zero probability.
 */
export function countingProbability(favourable: bigint, support: bigint): Rational {
  if (typeof favourable !== 'bigint' || typeof support !== 'bigint')
    fail('INVALID_WEIGHTS', 'Counting measure requires BigInt counts', '$.count');
  if (support <= 0n)
    fail('INVALID_WEIGHTS', 'Counting measure support must be positive', '$.support');
  if (favourable < 0n || favourable > support)
    fail('INVALID_WEIGHTS', 'Favourable count is outside the support', '$.favourable');
  return rational(favourable, support);
}
