import { fail } from '../../api/errors.js';
import { sealCommitment } from '../../core/commitment.js';
import { equal, rational } from '../../core/rational.js';
import type { DefinitionIdentity } from '../../core/module.js';
import { encodeFields, type CanonicalField } from '../../internal/canonical.js';
import { enumerateInstances } from './bets.js';
import {
  PERMUTATION_BET_CODES,
  PERMUTATION_MODULE_ID,
  PERMUTATION_MODULE_VERSION,
  type PermutationDefinition,
} from './contracts.js';
import { fairMultiplier, freshProbability } from './pricing.js';
import { assertPermutationDefinition } from './validation.js';

/**
 * Every replay-visible declarative field, in one canonical order.
 *
 * `moduleVersion` is bound alongside the definition's own fields, and that is
 * load-bearing here in a way it is not for an adapter-driven module. AETHER
 * ORDER's reference implementation lets the *game* supply the bet catalogue as
 * `(enumerate, resolve)` pairs, so its fingerprint has to digest the
 * catalogue's behaviour or a reversed predicate would change how an open
 * liability settles while leaving a declarative fingerprint untouched. This
 * module owns the catalogue instead: the five families and their resolve
 * semantics live in `bets.ts` and move only with `PERMUTATION_MODULE_VERSION`.
 * Binding that version is therefore the exact equivalent of digesting the
 * behaviour, and it costs `O(1)` rather than `O(instances x n!)`.
 */
function identityFields(definition: PermutationDefinition): readonly CanonicalField[] {
  return Object.freeze([
    PERMUTATION_MODULE_ID,
    PERMUTATION_MODULE_VERSION,
    definition.id,
    definition.version,
    definition.items.length,
    ...definition.items,
    definition.rtp.numerator,
    definition.rtp.denominator,
    PERMUTATION_BET_CODES.length,
    ...PERMUTATION_BET_CODES.flatMap((code) => [
      code,
      definition.paytable[code].numerator,
      definition.paytable[code].denominator,
    ]),
    definition.maxWinMultiple,
    definition.stakeQuantum,
    definition.minLineStake,
    definition.maxLineStake,
    definition.maxTicketStake,
    definition.maxOpenBets,
  ]);
}

/**
 * 32-byte digest over every replay-visible declarative field.
 *
 * Two definitions that could pay differently must never share a fingerprint, so
 * the paytable, the quantum, the stake bounds, the cap and the item set are all
 * inside. The seed is a constant here: this is a content digest, not a
 * commitment.
 */
export function permutationFingerprint(definition: PermutationDefinition): string {
  assertPermutationDefinition(definition);
  return sealCommitment('00'.repeat(32), encodeFields(identityFields(definition)));
}

export function permutationIdentity(definition: PermutationDefinition): DefinitionIdentity {
  assertPermutationDefinition(definition);
  return Object.freeze({
    moduleId: PERMUTATION_MODULE_ID,
    moduleVersion: PERMUTATION_MODULE_VERSION,
    definitionId: definition.id,
    definitionVersion: definition.version,
    fingerprint: permutationFingerprint(definition),
  });
}

/** Canonical fields used by the commitment body; kept next to the digest they feed. */
export function definitionFields(definition: PermutationDefinition): readonly CanonicalField[] {
  return identityFields(definition);
}

/**
 * The only supported construction path: validate, price-check, clone, freeze.
 *
 * Beyond the structural validation this also establishes the two economic
 * properties a paytable over a permutation has to hold, because both are cheap
 * at startup and neither is recoverable once a round is open:
 *
 * 1. **Pricing identity.** `multiplier x probability === rtp`, exactly, for
 *    every bet code. A paytable that misses it does not have a house edge, it
 *    has a different house edge per chip — which is the trap-bet pattern the
 *    uniform-RTP design exists to refuse.
 * 2. **Exact payability.** Every multiplier's denominator divides
 *    `stakeQuantum`, so `stake x multiplier` is an integer for every legal stake
 *    and the floor at the credit boundary is a no-op rather than a truncation
 *    the player pays for.
 *
 * The cap is deliberately *not* required to be inert here — a definition may
 * choose a binding cap — but conformance reports the headroom either way, so a
 * cap that silently degrades the advertised RTP cannot pass unnoticed.
 */
export function definePermutationGame(input: PermutationDefinition): PermutationDefinition {
  assertPermutationDefinition(input, '$');
  const definition: PermutationDefinition = Object.freeze({
    id: input.id,
    version: input.version,
    items: Object.freeze([...input.items]),
    rtp: rational(input.rtp.numerator, input.rtp.denominator),
    paytable: Object.freeze(
      Object.fromEntries(
        PERMUTATION_BET_CODES.map((code) => [
          code,
          rational(input.paytable[code].numerator, input.paytable[code].denominator),
        ]),
      ),
    ) as PermutationDefinition['paytable'],
    maxWinMultiple: input.maxWinMultiple,
    stakeQuantum: input.stakeQuantum,
    minLineStake: input.minLineStake,
    maxLineStake: input.maxLineStake,
    maxTicketStake: input.maxTicketStake,
    maxOpenBets: input.maxOpenBets,
  });

  for (const code of PERMUTATION_BET_CODES) {
    // One instance is enough to price a family only because every instance of a
    // family shares a win count; `FAMILY_NOT_HOMOGENEOUS` proves that separately
    // rather than letting this line assume it.
    const instance = enumerateInstances(definition, code)[0];
    if (instance === undefined)
      fail('INVALID_ADAPTER', 'Bet family has no instances for this draw', `$.paytable.${code}`);
    const probability = freshProbability(definition, instance);
    const multiplier = definition.paytable[code];
    if (!equal(fairMultiplier(definition.rtp, probability), multiplier))
      fail(
        'INVALID_ADAPTER',
        `Published multiplier for ${code} does not price the declared RTP exactly`,
        `$.paytable.${code}`,
      );
    if (definition.stakeQuantum % multiplier.denominator !== 0n)
      fail(
        'INVALID_ADAPTER',
        `Multiplier for ${code} cannot pay an exact integer at the declared stake quantum`,
        `$.paytable.${code}`,
      );
  }
  return definition;
}
