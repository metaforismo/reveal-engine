import { fail } from '../../api/errors.js';
import { countingProbability, factorial } from '../../core/combinatorics.js';
import { divide, multiply, rational, type Rational } from '../../core/rational.js';
import { weightVector, type WeightVector } from '../../core/weights.js';
import { betAssignments, type BetAssignment } from './bets.js';
import { assertDrawShape } from './validation.js';
import type {
  Item,
  PermutationBet,
  PermutationBetCode,
  PermutationDefinition,
  PermutationStep,
} from './contracts.js';

/**
 * Exact pricing by factorial enumeration. No float, no simulation, no sampling.
 *
 * A round's truth is one of `n!` orderings. After `m` positions have settled the
 * revealed prefix is fixed and the remaining `n - m` items may complete the
 * order in exactly `(n - m)!` ways, each still equally likely: the shuffle is
 * uniform over `S_n` and conditioning a uniform distribution on a prefix leaves
 * a uniform distribution over the completions. So every price in this module is
 * a counting measure, `favourable / (n - m)!`, and the only work is counting the
 * favourable completions exactly.
 */

/** A revealed prefix, decoded once so the counter never re-walks the step list. */
interface RevealedPrefix {
  readonly n: number;
  /** `itemAt[position]` for every settled position, in prefix order. */
  readonly itemAt: readonly Item[];
  /** Items already settled, for the "is this item still available" test. */
  readonly settled: ReadonlySet<Item>;
}

/**
 * Decodes and **validates** the step prefix before a single count is taken.
 *
 * `price()` is reachable from a host with whatever step list it kept, and a
 * malformed prefix would otherwise produce a confidently wrong probability
 * rather than an error. A prefix must be exactly that: positions `0..m-1` in
 * settle order, each item in range, no item twice, and at most `n - 1` of them.
 */
function revealedPrefix(
  definition: PermutationDefinition,
  steps: readonly PermutationStep[],
): RevealedPrefix {
  assertDrawShape(definition, '$.definition');
  const n = definition.items.length;
  if (!Array.isArray(steps) || steps.length > n - 1)
    fail('INVALID_TRANSCRIPT', 'Step prefix is longer than the round', '$.steps');
  const itemAt: Item[] = [];
  const settled = new Set<Item>();
  // Indexed rather than `forEach`. A sparse array skips holes under `forEach`,
  // and every skipped hole would shift the remaining reveals down a position —
  // a malformed prefix silently re-read as a different, well-formed one, which
  // is the worst possible failure mode for something that decides a price.
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (typeof step !== 'object' || step === null)
      fail('INVALID_TRANSCRIPT', 'Expected a reveal object', `$.steps[${index}]`);
    if (step.position !== index)
      fail(
        'INVALID_TRANSCRIPT',
        'Reveals must be a prefix in settle order',
        `$.steps[${index}].position`,
      );
    if (!Number.isSafeInteger(step.item) || step.item < 0 || step.item >= n)
      fail('INVALID_TRANSCRIPT', 'Reveal names an item outside the draw', `$.steps[${index}].item`);
    if (settled.has(step.item))
      fail('INVALID_TRANSCRIPT', 'Reveals settle one item twice', `$.steps[${index}].item`);
    settled.add(step.item);
    itemAt.push(step.item);
  }
  return { n, itemAt, settled };
}

/**
 * Completions of the prefix that satisfy one assignment, exactly.
 *
 * An assignment holds in a completion when every pin holds. A pin on an already
 * settled position is decided — it either agrees with the reveal or the
 * assignment is impossible. A pin on an open position must name an item that is
 * still available, and then it consumes one of the open positions. With `f` pins
 * landing on open positions, the remaining `n - m - f` items fill the remaining
 * `n - m - f` open positions freely: `(n - m - f)!` completions.
 *
 * The two impossibility guards below (a position pinned twice with different
 * items, an item pinned into two positions) are unreachable for the shipped
 * catalogue, whose assignments are built with distinct positions and distinct
 * items. They are here because this function is the single arbiter of what a bet
 * costs, and "the caller cannot construct that" is a weaker guarantee than "the
 * counter refuses it".
 */
function countAssignment(prefix: RevealedPrefix, assignment: BetAssignment): bigint {
  const open = prefix.n - prefix.itemAt.length;
  const pinnedItemAt = new Map<number, Item>();
  const pinnedPositionOf = new Map<Item, number>();
  let consumed = 0;
  for (const [position, item] of assignment.pins) {
    const existingItem = pinnedItemAt.get(position);
    if (existingItem !== undefined && existingItem !== item) return 0n;
    const existingPosition = pinnedPositionOf.get(item);
    if (existingPosition !== undefined && existingPosition !== position) return 0n;
    if (existingItem !== undefined) continue;
    pinnedItemAt.set(position, item);
    pinnedPositionOf.set(item, position);
    const revealed = prefix.itemAt[position];
    if (revealed !== undefined) {
      // Settled position: the pin is already decided, and consumes nothing.
      if (revealed !== item) return 0n;
      continue;
    }
    // Open position: the item must not have settled elsewhere already.
    if (prefix.settled.has(item)) return 0n;
    consumed += 1;
  }
  return factorial(open - consumed);
}

/**
 * Exact probability that a bet wins, given everything revealed so far.
 *
 * The favourable count is the plain sum of the per-assignment counts, with no
 * inclusion-exclusion term, because a family's assignments are pairwise
 * exclusive — `bets.ts` states the argument and
 * `CLAIM_IDENTITY_NOT_BEHAVIOURAL` plus the oracle suite prove it against a
 * brute-force enumeration of the whole order space.
 */
export function price(
  definition: PermutationDefinition,
  steps: readonly PermutationStep[],
  bet: PermutationBet,
): Rational {
  const prefix = revealedPrefix(definition, steps);
  const support = factorial(prefix.n - prefix.itemAt.length);
  const favourable = betAssignments(definition, bet).reduce(
    (total, assignment) => total + countAssignment(prefix, assignment),
    0n,
  );
  return countingProbability(favourable, support);
}

/** Probability of a bet before anything has settled: the paytable's pricing point. */
export function freshProbability(definition: PermutationDefinition, bet: PermutationBet): Rational {
  return price(definition, [], bet);
}

/**
 * The exact total return a winning line pays: `stake x multiplier`.
 *
 * Rounding is not a policy here, it is an error. Every declared multiplier has a
 * denominator dividing `stakeQuantum` and every legal stake is a multiple of
 * `stakeQuantum`, so the product is an exact integer and the floor applied at
 * the credit boundary is a proven no-op. A definition that broke the property
 * would be caught by `PRICING_IDENTITY_BROKEN` at conformance time; a stake that
 * breaks it is refused here rather than silently shaved.
 */
export function linePayout(
  definition: PermutationDefinition,
  code: PermutationBetCode,
  stake: bigint,
): Rational {
  assertDrawShape(definition, '$.definition');
  const multiplier = (definition.paytable as Record<string, Rational> | undefined)?.[code];
  if (multiplier === undefined)
    fail('CLAIM_REJECTED', 'No published multiplier for bet', '$.bet.code');
  const payout = multiply(rational(stake), multiplier);
  if (payout.denominator !== 1n)
    fail('CLAIM_REJECTED', 'Stake and multiplier do not produce an exact payout', '$.stake');
  return payout;
}

/** The multiplier an exact-RTP paytable must publish for a bet with probability `p`. */
export function fairMultiplier(rtp: Rational, probability: Rational): Rational {
  return divide(rtp, probability);
}

/**
 * Marginal per-item view: which items have not settled yet.
 *
 * This is a **display and elimination** vector, not the pricing space — the
 * pricing space is `S_n` and `price()` is the only thing that quotes it. What
 * the vector does establish is that elimination is exact: an item that has
 * settled carries weight `0n`, never an epsilon, so a claim contradicted by a
 * reveal is priced at exactly zero and can be refused rather than sold cheap.
 *
 * The vector stays legal at every prefix because a round emits `n - 1` reveals:
 * after the last one, exactly one item is still unsettled and the total is `1n`.
 * A round that revealed all `n` positions would hand `weightVector` an all-zero
 * list, which it correctly refuses as an impossible round.
 */
export function itemBelief(
  definition: PermutationDefinition,
  steps: readonly PermutationStep[],
): WeightVector {
  const prefix = revealedPrefix(definition, steps);
  return weightVector(definition.items.map((_label, item) => (prefix.settled.has(item) ? 0n : 1n)));
}
