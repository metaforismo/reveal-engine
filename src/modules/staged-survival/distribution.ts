import { fail } from '../../api/errors.js';
import { factorial, fallingFactorial } from '../../core/combinatorics.js';
import { add, compare, multiply, rational, subtract, type Rational } from '../../core/rational.js';
import type { StageContract, SurvivalDefinition } from './contracts.js';
import { assertSurvivalDefinition, marginalSurvival } from './validation.js';

/**
 * Exact distributions over a stage's survivor count.
 *
 * This is the module's model of **correlation**, and it is the reason a stage is
 * not `n` independent coin flips. A lane resolves in two exact steps:
 *
 * 1. one shared draw fires with probability `q` and takes the whole lane;
 * 2. otherwise each entity of the lane clears independently with probability `c`.
 *
 * So `P(entity survives) = (1 - q)c` for every entity whatever the geometry is,
 * while the *joint* law is a convolution of per-lane binomials mixed with a
 * point mass at zero. Two contracts can share a marginal and have completely
 * different survivor distributions; that difference is the product.
 *
 * Everything below is exact `Rational` arithmetic over BigInt. Nothing here is
 * ever sampled, approximated, or normalised after the fact.
 */

const ONE = rational(1n);
const ZERO = rational(0n);

/** Exact `C(n, k)` from core's counting primitives. */
export function binomial(n: number, k: number): bigint {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(k) || n < 0 || k < 0)
    fail('INVALID_WEIGHTS', 'Binomial arguments must be non-negative safe integers', '$.binomial');
  if (k > n) return 0n;
  return fallingFactorial(n, k) / factorial(k);
}

/**
 * Lane sizes for a field of `liveCount` under a contract, in order.
 *
 * The live field, ascending by entity index, is cut into consecutive lanes of
 * `laneWidth`; the final lane carries the remainder. The sizes are enumerated
 * into the definition fingerprint for every reachable `liveCount`, because the
 * *sizes* — not the lane count — are what determine the survivor distribution:
 * two geometries with the same lane count and different sizes price differently.
 */
export function laneSizes(contract: StageContract, liveCount: number): readonly number[] {
  if (!Number.isSafeInteger(liveCount) || liveCount < 0)
    fail('INVALID_CHOICE', 'Live field size must be a non-negative safe integer', '$.liveCount');
  // The width is the loop's decrement, so a zero, negative or non-integer one
  // would not produce a wrong partition — it would not terminate. This is an
  // exported helper, so the bound is checked here rather than being left to
  // whichever caller happened to validate its definition first.
  if (!Number.isSafeInteger(contract?.laneWidth) || contract.laneWidth < 1)
    fail('INVALID_ADAPTER', 'Lane width must be a positive safe integer', '$.contract.laneWidth');
  const sizes: number[] = [];
  for (let remaining = liveCount; remaining > 0; remaining -= contract.laneWidth)
    sizes.push(remaining < contract.laneWidth ? remaining : contract.laneWidth);
  return Object.freeze(sizes);
}

/** The same partition, carrying the entity ids each lane holds. */
export function lanePartition(
  contract: StageContract,
  live: readonly number[],
): readonly (readonly number[])[] {
  if (!Array.isArray(live))
    fail('INVALID_CHOICE', 'The live field must be an array of entities', '$.live');
  laneSizes(contract, live.length);
  const lanes: (readonly number[])[] = [];
  for (let start = 0; start < live.length; start += contract.laneWidth)
    lanes.push(Object.freeze(live.slice(start, start + contract.laneWidth)));
  return Object.freeze(lanes);
}

/** Exact `P(j survivors)` for one lane of `size`, indexed `0..size`. */
export function laneSurvivorDistribution(
  contract: StageContract,
  size: number,
): readonly Rational[] {
  const q = rational(
    contract.profile.laneFailure.numerator,
    contract.profile.laneFailure.denominator,
  );
  const c = rational(
    contract.profile.entitySurvival.numerator,
    contract.profile.entitySurvival.denominator,
  );
  const held = subtract(ONE, q);
  const miss = subtract(ONE, c);
  const distribution: Rational[] = [];
  for (let survivors = 0; survivors <= size; survivors += 1) {
    let term = rational(binomial(size, survivors));
    for (let index = 0; index < survivors; index += 1) term = multiply(term, c);
    for (let index = 0; index < size - survivors; index += 1) term = multiply(term, miss);
    distribution.push(multiply(held, term));
  }
  // The common shock is a point mass at zero survivors, on top of the
  // conditional binomial: the lane can also be wiped by the shared draw.
  distribution[0] = add(distribution[0] as Rational, q);
  return Object.freeze(distribution);
}

/**
 * Exact `P(k survivors)` over the whole field, indexed `0..liveCount`.
 *
 * Lanes are independent of each other, so the field law is the convolution of
 * the per-lane laws. The result sums to exactly `1`; `distributionTotal()` is
 * the assertion, and conformance runs it over every contract and every
 * reachable field size.
 */
export function survivorDistribution(
  definition: SurvivalDefinition,
  contract: StageContract,
  liveCount: number,
): readonly Rational[] {
  assertSurvivalDefinition(definition);
  if (!Number.isSafeInteger(liveCount) || liveCount < 0 || liveCount > definition.entities)
    fail('INVALID_CHOICE', 'Live field size is outside the definition', '$.liveCount');
  let distribution: Rational[] = [ONE];
  for (const size of laneSizes(contract, liveCount)) {
    const lane = laneSurvivorDistribution(contract, size);
    const next: Rational[] = Array.from({ length: distribution.length + size }, () => ZERO);
    distribution.forEach((weight, index) => {
      if (compare(weight, ZERO) === 0) return;
      lane.forEach((share, survivors) => {
        next[index + survivors] = add(next[index + survivors] as Rational, multiply(weight, share));
      });
    });
    distribution = next;
  }
  return Object.freeze(distribution);
}

export function distributionTotal(distribution: readonly Rational[]): Rational {
  return distribution.reduce((total, share) => add(total, share), ZERO);
}

/** Exact `E[survivors]` from the distribution, by summing `k * P(k)`. */
export function expectedSurvivorsFromDistribution(distribution: readonly Rational[]): Rational {
  return distribution.reduce(
    (total, share, survivors) => add(total, multiply(rational(BigInt(survivors)), share)),
    ZERO,
  );
}

/** Exact `E[survivors]` in closed form: `liveCount * (1 - q) * c`, by linearity. */
export function expectedSurvivors(contract: StageContract, liveCount: number): Rational {
  return multiply(rational(BigInt(liveCount)), marginalSurvival(contract));
}

export { marginalSurvival };
