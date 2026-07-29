import { fail } from '../../api/errors.js';
import { ENGINE_LIMITS } from '../../api/limits.js';
import { assertIdentifier, isRecord } from '../../core/validation.js';
import type { Rational } from '../../core/rational.js';
import {
  MAX_ITEMS,
  MAX_OPEN_BETS,
  MIN_ITEMS,
  PERMUTATION_BET_CODES,
  type PermutationDefinition,
} from './contracts.js';

/**
 * Structural validation of a permutation definition.
 *
 * This runs on every fingerprint, every restore, and every verification, so it
 * is deliberately cheap and deliberately shallow: shape, bounds, and internal
 * consistency of the declared numbers. The *economic* property — that every
 * published multiplier prices its bet at exactly the declared RTP — costs a
 * handful of factorials and is checked once, at construction, by
 * `definePermutationGame()`; conformance then re-establishes it independently
 * for anything that reached the module without going through the factory.
 */

/**
 * Positive, bounded BigInt — reported as an adapter fault, not a rational one.
 *
 * `core/validation.ts` applies the same bound but raises `INVALID_RATIONAL`,
 * which is the right code for arithmetic reaching a value it cannot carry and
 * the wrong one here: every other failure in this file is a malformed
 * definition, and a host branching on the code should not have to know which
 * *field* of a bad definition it tripped over.
 */
function assertDefinitionBigInt(value: unknown, path: string): asserts value is bigint {
  if (
    typeof value !== 'bigint' ||
    value <= 0n ||
    value.toString(2).length > ENGINE_LIMITS.maxBigIntBits
  )
    fail('INVALID_ADAPTER', 'Expected a positive bounded BigInt', path);
}

function assertPositiveRational(value: unknown, path: string): asserts value is Rational {
  if (!isRecord(value)) fail('INVALID_ADAPTER', 'Expected a positive rational', path);
  assertDefinitionBigInt(value.numerator, `${path}.numerator`);
  assertDefinitionBigInt(value.denominator, `${path}.denominator`);
}

function assertQuantized(value: unknown, quantum: bigint, path: string): asserts value is bigint {
  assertDefinitionBigInt(value, path);
  if ((value as bigint) % quantum !== 0n)
    fail('INVALID_ADAPTER', 'Stake bound is not a multiple of the stake quantum', path);
}

/**
 * The `O(1)` half of definition validation, for the counting hot path.
 *
 * Full validation walks the item list, the paytable and every stake bound. That
 * is right at a round boundary and wrong inside an exhaustive sweep: the alias
 * conformance check resolves hundreds of thousands of bets against the order
 * space, and re-validating a frozen definition on each one would turn a
 * millisecond proof into a multi-second one.
 *
 * So the counting functions take this instead — enough to guarantee they never
 * dereference something that is not a definition, and typed the same way when
 * they do. It is a *guard*, not a substitute: everything that opens a round,
 * seals a commitment, or moves money still runs the full assertion, and this one
 * exists so a hostile argument reaching a pure counting function is a
 * `RevealEngineError` rather than a `TypeError` from three frames down.
 */
export function assertDrawShape(
  value: unknown,
  path = '$',
): asserts value is PermutationDefinition {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length < MIN_ITEMS ||
    value.items.length > MAX_ITEMS
  )
    fail('INVALID_ADAPTER', 'Expected a permutation definition with a legal draw size', path);
}

export function assertPermutationDefinition(
  value: unknown,
  path = '$',
): asserts value is PermutationDefinition {
  if (!isRecord(value)) fail('INVALID_ADAPTER', 'Expected a permutation definition', path);
  const definition = value as unknown as PermutationDefinition;
  assertIdentifier(definition.id, `${path}.id`);
  assertIdentifier(definition.version, `${path}.version`);

  if (
    !Array.isArray(definition.items) ||
    definition.items.length < MIN_ITEMS ||
    definition.items.length > MAX_ITEMS
  )
    fail('INVALID_ADAPTER', `Draw size must be ${MIN_ITEMS}..${MAX_ITEMS} items`, `${path}.items`);
  definition.items.forEach((item, index) => assertIdentifier(item, `${path}.items[${index}]`));
  if (new Set(definition.items).size !== definition.items.length)
    fail('INVALID_ADAPTER', 'Item labels must be unique', `${path}.items`);

  assertPositiveRational(definition.rtp, `${path}.rtp`);
  // An RTP above 1 is not a bold paytable, it is an arithmetic error: it prices
  // every bet to return more than it costs, in expectation, forever.
  if (definition.rtp.numerator > definition.rtp.denominator)
    fail('INVALID_ADAPTER', 'Declared RTP exceeds one', `${path}.rtp`);

  if (!isRecord(definition.paytable))
    fail('INVALID_ADAPTER', 'Expected a paytable object', `${path}.paytable`);
  const codes = Object.keys(definition.paytable).sort();
  const expected = [...PERMUTATION_BET_CODES].sort();
  if (codes.length !== expected.length || codes.some((code, index) => code !== expected[index]))
    fail(
      'INVALID_ADAPTER',
      'Paytable must publish exactly one multiplier per bet code',
      `${path}.paytable`,
    );
  for (const code of PERMUTATION_BET_CODES)
    assertPositiveRational(definition.paytable[code], `${path}.paytable.${code}`);

  assertDefinitionBigInt(definition.maxWinMultiple, `${path}.maxWinMultiple`);
  assertDefinitionBigInt(definition.stakeQuantum, `${path}.stakeQuantum`);
  const quantum = definition.stakeQuantum;
  assertQuantized(definition.minLineStake, quantum, `${path}.minLineStake`);
  assertQuantized(definition.maxLineStake, quantum, `${path}.maxLineStake`);
  assertQuantized(definition.maxTicketStake, quantum, `${path}.maxTicketStake`);
  if (definition.minLineStake > definition.maxLineStake)
    fail('INVALID_ADAPTER', 'Minimum line stake exceeds the maximum', `${path}.minLineStake`);
  if (definition.maxLineStake > definition.maxTicketStake)
    fail(
      'INVALID_ADAPTER',
      'Maximum line stake exceeds the ticket ceiling',
      `${path}.maxLineStake`,
    );

  if (
    !Number.isSafeInteger(definition.maxOpenBets) ||
    definition.maxOpenBets < 1 ||
    definition.maxOpenBets > MAX_OPEN_BETS
  )
    fail('INVALID_ADAPTER', 'Open bet budget is outside module limits', `${path}.maxOpenBets`);
}
