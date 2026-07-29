import { fail } from '../../api/errors.js';
import { sha256Hex } from '../../core/random.js';
import { encodeFields, type CanonicalField } from '../../internal/canonical.js';
import {
  PERMUTATION_MODULE_ID,
  type Item,
  type PermutationBet,
  type PermutationBetCode,
  type PermutationDefinition,
  type PermutationOrder,
  type Position,
} from './contracts.js';
import { assertDrawShape } from './validation.js';

/**
 * One bet reduced to the only thing that decides money: which orders it wins on.
 *
 * Every family in the catalogue is expressible as a **disjunction of partial
 * assignments**, where an assignment pins a set of positions to specific items
 * and a permutation satisfies it when every pin holds. That single
 * representation is what makes the rest of this module exact:
 *
 * - **settlement** is "does some assignment hold in the settled order";
 * - **pricing** is "how many completions of the revealed prefix satisfy some
 *   assignment", which is a sum of factorials because the assignments a family
 *   emits are pairwise exclusive (below);
 * - **claim identity** is the canonical form of the assignment list, so two
 *   spellings of the same claim (`first {item}` and `slot {item, 0}`) are one
 *   claim on a ticket rather than two.
 *
 * **Pairwise exclusivity.** `full`, `slot`, `first` and `last` emit a single
 * assignment, so there is nothing to overlap. `stack {before, after}` emits one
 * assignment per adjacent position pair, and assignment `k` pins `before` to
 * position `k`: no permutation places one item in two positions, so at most one
 * of them can hold. This is not an aside — it is the reason the counting sum in
 * `pricing.ts` may add the per-assignment counts without an inclusion-exclusion
 * correction, and `docs/modules/permutation.md` carries the argument in full.
 */
export interface BetAssignment {
  /** Pins in ascending position order; positions distinct, items distinct. */
  readonly pins: readonly (readonly [Position, Item])[];
}

function assertItem(
  definition: PermutationDefinition,
  value: unknown,
  path: string,
): asserts value is Item {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= definition.items.length
  )
    fail('CLAIM_REJECTED', 'Bet references an item outside the draw', path);
}

function assertPosition(
  definition: PermutationDefinition,
  value: unknown,
  path: string,
): asserts value is Position {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= definition.items.length
  )
    fail('CLAIM_REJECTED', 'Bet references a position outside the draw', path);
}

/**
 * Validates a bet against a definition, fully, before anything reads it.
 *
 * A bet arrives from a host and is money-bearing on both sides — it decides a
 * debit and a credit — so nothing here coerces and every branch reports
 * `CLAIM_REJECTED` with a path. An unknown `code` is rejected before any
 * parameter is dereferenced.
 */
export function assertBet(
  value: unknown,
  definition: PermutationDefinition,
  path = '$.bet',
): asserts value is PermutationBet {
  assertDrawShape(definition, '$.definition');
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('CLAIM_REJECTED', 'Expected a bet object', path);
  const bet = value as PermutationBet;
  const n = definition.items.length;
  switch (bet.code) {
    case 'full': {
      if (!Array.isArray(bet.order) || bet.order.length !== n)
        fail('CLAIM_REJECTED', 'A full-order bet must name every position', `${path}.order`);
      const seen = new Set<number>();
      bet.order.forEach((item, index) => {
        assertItem(definition, item, `${path}.order[${index}]`);
        if (seen.has(item))
          fail('CLAIM_REJECTED', 'A full-order bet repeats an item', `${path}.order[${index}]`);
        seen.add(item);
      });
      return;
    }
    case 'slot':
      assertItem(definition, bet.item, `${path}.item`);
      assertPosition(definition, bet.position, `${path}.position`);
      return;
    case 'first':
    case 'last':
      assertItem(definition, bet.item, `${path}.item`);
      return;
    case 'stack':
      assertItem(definition, bet.before, `${path}.before`);
      assertItem(definition, bet.after, `${path}.after`);
      if (bet.before === bet.after)
        fail('CLAIM_REJECTED', 'A stack bet needs two distinct items', `${path}.after`);
      return;
    default:
      fail('CLAIM_REJECTED', 'Unknown bet code', `${path}.code`);
  }
}

function pin(position: Position, item: Item): readonly [Position, Item] {
  return Object.freeze([position, item] as const);
}

/**
 * The disjunction of assignments a bet wins on.
 *
 * Pure, total on validated bets, and the single definition every other operation
 * in this module reads. Nothing else knows what a bet code means.
 */
export function betAssignments(
  definition: PermutationDefinition,
  bet: PermutationBet,
): readonly BetAssignment[] {
  assertBet(bet, definition);
  const n = definition.items.length;
  switch (bet.code) {
    case 'full':
      return Object.freeze([
        Object.freeze({
          pins: Object.freeze(bet.order.map((item, position) => pin(position, item))),
        }),
      ]);
    case 'slot':
      return Object.freeze([Object.freeze({ pins: Object.freeze([pin(bet.position, bet.item)]) })]);
    case 'first':
      return Object.freeze([Object.freeze({ pins: Object.freeze([pin(0, bet.item)]) })]);
    case 'last':
      return Object.freeze([Object.freeze({ pins: Object.freeze([pin(n - 1, bet.item)]) })]);
    case 'stack':
      return Object.freeze(
        Array.from({ length: n - 1 }, (_unused, position) =>
          Object.freeze({
            pins: Object.freeze([pin(position, bet.before), pin(position + 1, bet.after)]),
          }),
        ),
      );
  }
}

/** True when the settled order satisfies at least one of the bet's assignments. */
export function betWins(
  definition: PermutationDefinition,
  bet: PermutationBet,
  order: PermutationOrder,
): boolean {
  return betAssignments(definition, bet).some((assignment) =>
    assignment.pins.every(([position, item]) => order[position] === item),
  );
}

/**
 * Canonical, order-insensitive rendering of an assignment disjunction.
 *
 * Assignments are sorted by their pin sequence and pins by position, so two
 * emitters that agree on the win set agree on these bytes. `first {item}` and
 * `slot {item, 0}` both reduce to a single pin `0 -> item`, which is exactly the
 * aliasing the ticket rule has to see.
 */
function canonicalAssignmentFields(
  assignments: readonly BetAssignment[],
): readonly CanonicalField[] {
  const rendered = assignments
    .map((assignment) =>
      [...assignment.pins]
        .sort((left, right) => left[0] - right[0])
        .map(([position, item]) => `${position}:${item}`)
        .join(','),
    )
    .sort();
  const unique = rendered.filter((entry, index) => rendered.indexOf(entry) === index);
  return Object.freeze([unique.length, ...unique]);
}

/**
 * Behavioural identity of one claim: a digest of the orders it wins on.
 *
 * A ticket may not carry the same claim twice, and identity has to be
 * behavioural rather than nominal: `FIRST amber` and `SLOT amber @ 0` win on the
 * identical 24 orders at `n = 5`, so admitting both would hand the per-line
 * stake ceiling straight back and make the round's maximum credit a lower bound
 * instead of a maximum. This is the value the book compares, never the code.
 *
 * The digest is over the canonical assignment form rather than an `n!` bitmap,
 * which makes it O(n) instead of O(n!) on the settlement path. That the two
 * agree is not assumed: the `CLAIM_IDENTITY_NOT_BEHAVIOURAL` conformance check
 * enumerates the catalogue against the full order space and fails if a signature
 * collision is ever anything other than a win-set collision.
 */
export function claimSignature(definition: PermutationDefinition, bet: PermutationBet): string {
  return sha256Hex(
    encodeFields([
      'permutation-claim-v1',
      PERMUTATION_MODULE_ID,
      definition.items.length,
      ...canonicalAssignmentFields(betAssignments(definition, bet)),
    ]),
  );
}

/** Canonical numeric parameter vector, used by receipts and the snapshot codec. */
export function betParameters(bet: PermutationBet): readonly number[] {
  switch (bet.code) {
    case 'full':
      return Object.freeze([...bet.order]);
    case 'slot':
      return Object.freeze([bet.item, bet.position]);
    case 'first':
    case 'last':
      return Object.freeze([bet.item]);
    case 'stack':
      return Object.freeze([bet.before, bet.after]);
  }
}

/**
 * Rebuilds a bet from `(code, parameters)` without trusting either.
 *
 * This is the snapshot and receipt-replay direction, so an arity that does not
 * match the code is a rejection rather than a silently shorter bet.
 */
export function betFromParameters(
  definition: PermutationDefinition,
  code: unknown,
  parameters: readonly unknown[],
  path = '$.bet',
): PermutationBet {
  assertDrawShape(definition, '$.definition');
  const n = definition.items.length;
  const numbers = parameters.map((value, index) => {
    if (!Number.isSafeInteger(value))
      fail('CLAIM_REJECTED', 'Bet parameter is not an integer', `${path}[${index}]`);
    return value as number;
  });
  const arity = (expected: number): void => {
    if (numbers.length !== expected)
      fail('CLAIM_REJECTED', 'Bet parameter count does not match its code', path);
  };
  let bet: PermutationBet;
  switch (code) {
    case 'full':
      arity(n);
      bet = { code: 'full', order: Object.freeze([...numbers]) };
      break;
    case 'slot':
      arity(2);
      bet = { code: 'slot', item: numbers[0] as number, position: numbers[1] as number };
      break;
    case 'first':
      arity(1);
      bet = { code: 'first', item: numbers[0] as number };
      break;
    case 'last':
      arity(1);
      bet = { code: 'last', item: numbers[0] as number };
      break;
    case 'stack':
      arity(2);
      bet = { code: 'stack', before: numbers[0] as number, after: numbers[1] as number };
      break;
    default:
      fail('CLAIM_REJECTED', 'Unknown bet code', `${path}.code`);
  }
  assertBet(bet, definition, path);
  return Object.freeze(bet);
}

/**
 * The complete, finite, deterministic instance catalogue for a definition.
 *
 * Ordered and seed-independent, so an exhaustive check sweeps the same list on
 * every run. `full` contributes `n!` instances, which is why the module caps `n`
 * at 8: past that the catalogue itself stops being enumerable.
 */
export function enumerateInstances(
  definition: PermutationDefinition,
  code: PermutationBetCode,
): readonly PermutationBet[] {
  assertDrawShape(definition, '$.definition');
  const n = definition.items.length;
  const items = Array.from({ length: n }, (_unused, index) => index);
  switch (code) {
    case 'full':
      return Object.freeze(
        enumerateOrders(n).map((order) => Object.freeze({ code: 'full' as const, order })),
      );
    case 'slot':
      return Object.freeze(
        items.flatMap((item) =>
          items.map((position) => Object.freeze({ code: 'slot' as const, item, position })),
        ),
      );
    case 'first':
      return Object.freeze(items.map((item) => Object.freeze({ code: 'first' as const, item })));
    case 'last':
      return Object.freeze(items.map((item) => Object.freeze({ code: 'last' as const, item })));
    case 'stack':
      return Object.freeze(
        items.flatMap((before) =>
          items
            .filter((after) => after !== before)
            .map((after) => Object.freeze({ code: 'stack' as const, before, after })),
        ),
      );
  }
}

/**
 * Every permutation of `[0, n)` in lexicographic order.
 *
 * The truth space is small enough to enumerate for every supported `n`, and that
 * is deliberate: it is what lets conformance sweep all `n!` truths and prove the
 * step schedule cannot leak the truth, instead of sampling and hoping.
 */
export function enumerateOrders(n: number): readonly PermutationOrder[] {
  if (!Number.isSafeInteger(n) || n < 0) fail('INVALID_CONTEXT', 'Invalid draw size', '$.n');
  const results: PermutationOrder[] = [];
  const current: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const walk = (): void => {
    if (current.length === n) {
      results.push(Object.freeze([...current]));
      return;
    }
    for (let item = 0; item < n; item += 1)
      if (!used[item]) {
        used[item] = true;
        current.push(item);
        walk();
        current.pop();
        used[item] = false;
      }
  };
  walk();
  return Object.freeze(results);
}
