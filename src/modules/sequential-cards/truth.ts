import { fail } from '../../api/errors.js';
import { samplerScopeOf } from '../../core/module.js';
import { RandomTape, normalizeSeed, sha256Hex, uniformPermutation } from '../../core/random.js';
import { encodeFields, type CanonicalField } from '../../internal/canonical.js';
import { COMMITMENT_VERSION } from '../../core/versions.js';
import { assertIdentifier } from '../../core/validation.js';
import { cardsFingerprint, cardsRoundOf } from './adapter.js';
import type { Deal, SequentialCardsDefinition } from './contracts.js';
import { assertCardsDefinition, eligibleSetSize, reject } from './validation.js';

/**
 * The committed truth: a deterministic shuffle of the declared deck, plus the
 * reveal selectors sealed alongside it.
 *
 * Both halves are pure functions of `(seed, definition, roundId)` and of nothing
 * else. In particular **no player decision is an input here**, which is what
 * lets the selector be published-by-commitment before the player has backed
 * anything: it indexes the eligible set in ascending board order, and that
 * set's *size* is a declared constant of the definition even though its
 * *membership* is not known until the backing is logged.
 */

/** Sampler label for the deck shuffle. Disjoint from the selector label. */
const DEAL_LABEL = 'cards:deal';
/** Sampler label for the sealed reveal selectors. */
const SELECTOR_LABEL = 'cards:selector';

/** Truth-space size above which `enumerate()` declines rather than materialises. */
export const CARDS_MAX_ENUMERATED_TRUTHS = 20_000;

/**
 * The reveal selectors, derived from the seed alone.
 *
 * Deliberately a separate exported function taking no choice argument: that a
 * selector cannot depend on the backing is a property of this signature, and
 * `CARDS_SELECTOR_PRECOMMITTED` checks that the deal derivation agrees with it.
 */
export function deriveSelectors(
  seedHex: string,
  definition: SequentialCardsDefinition,
  roundId: string,
): readonly number[] {
  assertCardsDefinition(definition);
  const tape = new RandomTape(
    seedHex,
    samplerScopeOf(cardsRoundOf(definition, roundId)),
    definition.reveal.count,
  );
  const selectors: number[] = [];
  for (let index = 0; index < definition.reveal.count; index += 1)
    selectors.push(tape.index(SELECTOR_LABEL, index, eligibleSetSize(definition, index)));
  return Object.freeze(selectors);
}

/** The dealt ranks, in board order, from a seeded Fisher-Yates over the ladder. */
export function deriveRanks(
  seedHex: string,
  definition: SequentialCardsDefinition,
  roundId: string,
): readonly number[] {
  assertCardsDefinition(definition);
  const order = uniformPermutation(
    seedHex,
    samplerScopeOf(cardsRoundOf(definition, roundId)),
    DEAL_LABEL,
    definition.ladder.size,
  );
  return Object.freeze(
    order.slice(0, definition.ladder.dealt).map((index) => (index as number) + 1),
  );
}

export function deriveDeal(
  seedHex: string,
  definition: SequentialCardsDefinition,
  roundId: string,
): Deal {
  return Object.freeze({
    ranks: deriveRanks(seedHex, definition, roundId),
    selectors: deriveSelectors(seedHex, definition, roundId),
  });
}

/**
 * Canonical encoding of the truth.
 *
 * This is the module's `truth.encode`, and `cardsCommitmentBody` composes this
 * exact function rather than writing the layout a second time — so the declared
 * encoding and the proof-bearing one are one definition, not two that agree
 * until somebody edits one of them.
 */
export function encodeDeal(deal: Deal): readonly CanonicalField[] {
  return Object.freeze([
    deal.ranks.length,
    ...deal.ranks,
    deal.selectors.length,
    ...deal.selectors,
  ]);
}

export function dealEqual(left: Deal, right: Deal): boolean {
  return (
    left.ranks.length === right.ranks.length &&
    left.selectors.length === right.selectors.length &&
    left.ranks.every((rank, index) => rank === right.ranks[index]) &&
    left.selectors.every((selector, index) => selector === right.selectors[index])
  );
}

/** Ordered `k`-tuples of distinct ranks, streamed. */
function forEachOrderedDeal(
  size: number,
  dealt: number,
  visit: (ranks: readonly number[]) => void,
): void {
  const used = new Array<boolean>(size + 1).fill(false);
  const current: number[] = [];
  const walk = (depth: number): void => {
    if (depth === dealt) {
      visit(current);
      return;
    }
    for (let rank = 1; rank <= size; rank += 1) {
      if (used[rank] === true) continue;
      used[rank] = true;
      current.push(rank);
      walk(depth + 1);
      current.pop();
      used[rank] = false;
    }
  };
  walk(0);
}

/** Every selector tuple a definition admits, in odometer order. */
export function enumerateSelectorTuples(
  definition: SequentialCardsDefinition,
): readonly (readonly number[])[] {
  let tuples: number[][] = [[]];
  for (let index = 0; index < definition.reveal.count; index += 1) {
    const width = eligibleSetSize(definition, index);
    const next: number[][] = [];
    for (const tuple of tuples)
      for (let selector = 0; selector < width; selector += 1) next.push([...tuple, selector]);
    tuples = next;
  }
  return Object.freeze(tuples.map((tuple) => Object.freeze(tuple)));
}

/**
 * The whole truth space when it is small enough to sweep exhaustively.
 *
 * Conformance and the oracle test prefer exhaustion to sampling wherever the
 * space allows it. Above `CARDS_MAX_ENUMERATED_TRUTHS` this returns `undefined`
 * rather than a truncated list, because a partial sweep presented as a full one
 * is the overclaim the contract's `enumerate` hook exists to avoid.
 */
export function enumerateDeals(definition: SequentialCardsDefinition): readonly Deal[] | undefined {
  assertCardsDefinition(definition);
  const { size, dealt } = definition.ladder;
  const selectorTuples = enumerateSelectorTuples(definition);
  let ordered = 1;
  for (let index = 0; index < dealt; index += 1) ordered *= size - index;
  if (ordered * selectorTuples.length > CARDS_MAX_ENUMERATED_TRUTHS) return undefined;
  const deals: Deal[] = [];
  forEachOrderedDeal(size, dealt, (ranks) => {
    for (const selectors of selectorTuples)
      deals.push(Object.freeze({ ranks: Object.freeze([...ranks]), selectors }));
  });
  return Object.freeze(deals);
}

export interface RoundSeedInput {
  readonly definition: SequentialCardsDefinition;
  readonly roundId: string;
  /** 32 CSPRNG bytes the operator committed for **this round only**. */
  readonly operatorSeed: string;
  /** Player-owned entropy, hex, `seed.clientSeedBytes` long. */
  readonly clientSeed: string;
  /** Round counter inside the client-seed epoch. */
  readonly nonce: number;
}

/**
 * Composes the round seed the module derives from.
 *
 * The lifecycle contract hands a module one 32-byte `seedHex`, so seed
 * composition happens **before** the module is called and is a host obligation.
 * This helper exists so the composition is at least written down once, in the
 * module that depends on it, with the definition fingerprint bound in.
 *
 * What it buys and what it does not: deterministic seed-derived truth stops an
 * operator choosing the outcome after the seed is committed. It does not stop an
 * operator grinding many seeds before publishing one. Mixing entropy the
 * operator does not control into every round seed is what makes grinding
 * pointless — there is no target to grind toward — and that argument is only as
 * strong as the deployment's client-seed custody, which this module cannot see.
 * See `docs/threat-model.md`.
 */
export function composeRoundSeed(input: RoundSeedInput): string {
  const { definition, roundId, operatorSeed, clientSeed, nonce } = input;
  assertCardsDefinition(definition);
  assertIdentifier(roundId, '$.roundId', 'INVALID_CONTEXT');
  const operator = normalizeSeed(operatorSeed);
  if (typeof clientSeed !== 'string' || !/^[0-9a-f]*$/iu.test(clientSeed))
    fail('INVALID_SEED', 'Client seed must be hexadecimal', '$.clientSeed');
  const clientBytes = clientSeed.length / 2;
  if (clientSeed.length % 2 !== 0)
    fail('INVALID_SEED', 'Client seed must be whole bytes', '$.clientSeed');
  if (definition.seed.clientEntropy === 'required' && clientBytes < definition.seed.clientSeedBytes)
    reject(
      'INVALID_SEED',
      'This definition requires client entropy in every round seed',
      '$.clientSeed',
      'MISSING_CLIENT_ENTROPY',
    );
  if (clientBytes > 128) fail('INVALID_SEED', 'Client seed is too long', '$.clientSeed');
  if (!Number.isSafeInteger(nonce) || nonce < 0)
    fail('INVALID_CONTEXT', 'Nonce must be a non-negative safe integer', '$.nonce');
  return sha256Hex(
    encodeFields([
      'cards-round-seed',
      COMMITMENT_VERSION,
      cardsFingerprint(definition),
      roundId,
      Buffer.from(operator, 'hex'),
      Buffer.from(clientSeed.toLowerCase(), 'hex'),
      nonce,
    ]),
  );
}
