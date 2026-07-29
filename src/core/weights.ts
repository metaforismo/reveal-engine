import { fail } from '../api/errors.js';
import { ENGINE_LIMITS } from '../api/limits.js';
import { rational, type Rational } from './rational.js';
import { assertNonNegativeBigInt } from './validation.js';

/**
 * Exact non-negative belief weights over an ordered outcome space.
 *
 * Core deliberately allows zero weights so a lifecycle module can eliminate an
 * outcome with posterior exactly zero (a card that has already been revealed, an
 * entity that has already failed). The total must stay strictly positive: a
 * module that eliminates every outcome has produced an impossible round.
 */
export interface WeightVector {
  readonly weights: readonly bigint[];
  readonly total: bigint;
}

function assertWeightList(value: unknown, path: string): asserts value is readonly bigint[] {
  if (!Array.isArray(value) || value.length > ENGINE_LIMITS.maxOutcomes)
    fail('INVALID_WEIGHTS', 'Weight list is not a bounded array', path);
  value.forEach((weight, index) => {
    if (typeof weight !== 'bigint')
      fail('INVALID_WEIGHTS', 'Expected a BigInt', `${path}[${index}]`);
  });
}

/** Greatest common divisor of a weight list; zeros are absorbed. */
export function weightGcd(weights: readonly bigint[]): bigint {
  assertWeightList(weights, '$.weights');
  let a = weights[0] ?? 0n;
  for (let index = 1; index < weights.length; index += 1) {
    let b = weights[index] ?? 0n;
    while (b !== 0n) [a, b] = [b, a % b];
  }
  return a < 0n ? -a : a;
}

/** Divides by the common factor when one exists; ratios and zeros are preserved exactly. */
export function reduceWeights(weights: readonly bigint[]): bigint[] {
  const divisor = weightGcd(weights);
  return divisor > 1n ? weights.map((weight) => weight / divisor) : [...weights];
}

export function weightVector(weights: readonly bigint[], path = '$.weights'): WeightVector {
  if (!Array.isArray(weights) || weights.length < 2 || weights.length > ENGINE_LIMITS.maxOutcomes)
    fail('INVALID_WEIGHTS', 'Weight vector length is outside limits', path);
  let total = 0n;
  weights.forEach((weight, index) => {
    assertNonNegativeBigInt(weight, `${path}[${index}]`);
    total += weight;
  });
  if (total <= 0n) fail('INVALID_WEIGHTS', 'Weight vector total must be positive', path);
  return Object.freeze({ weights: Object.freeze([...weights]), total });
}

/** Exact probability of one index; the denominator is the live total, never a float. */
export function weightProbability(vector: WeightVector, index: number): Rational {
  if (!Number.isSafeInteger(index) || index < 0 || index >= vector.weights.length)
    fail('UNKNOWN_OUTCOME', 'Unknown outcome index', '$.outcome');
  return rational(vector.weights[index] ?? 0n, vector.total);
}

/** Multiplies every weight by a per-index factor and reduces; the shape of a Bayesian update. */
export function scaleWeights(
  vector: WeightVector,
  factor: (index: number) => bigint,
): WeightVector {
  return weightVector(reduceWeights(vector.weights.map((weight, index) => weight * factor(index))));
}
