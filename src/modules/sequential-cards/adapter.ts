import { createHash } from 'node:crypto';
import { fail } from '../../api/errors.js';
import type { DefinitionIdentity, RoundIdentity } from '../../core/module.js';
import { compare, rational } from '../../core/rational.js';
import { COMMITMENT_VERSION } from '../../core/versions.js';
import { encodeFields, type CanonicalField } from '../../internal/canonical.js';
import { analyseDefinition } from './analysis.js';
import {
  SEQUENTIAL_CARDS_MODULE_ID,
  SEQUENTIAL_CARDS_MODULE_VERSION,
  type SequentialCardsDefinition,
} from './contracts.js';
import { assertCardsDefinition, reject } from './validation.js';

/**
 * 32-byte hex over **every replay-visible declarative field** of a definition.
 *
 * Two definitions that could pay differently must never share a fingerprint, so
 * the ladder, the reveal algorithm's own version, the backing width, every side
 * market and its winning ranks in declared order, the whole pricing policy
 * including the rounding rule and the stake lattice, the risk rails, and the
 * seed policy are all inside it.
 */
export function cardsFingerprint(definition: SequentialCardsDefinition): string {
  assertCardsDefinition(definition);
  const fields: CanonicalField[] = [
    definition.apiVersion,
    definition.moduleId,
    definition.id,
    definition.version,
    definition.ladder.size,
    definition.ladder.dealt,
    definition.ladder.objective,
    definition.reveal.modelVersion,
    definition.reveal.count,
    definition.reveal.eligibility,
    definition.reveal.sortRemaining ? 1 : 0,
    definition.backing.maxOpenBeforeReveal,
    definition.backing.rebackMode,
    definition.sideMarkets.length,
  ];
  for (const market of definition.sideMarkets)
    fields.push(market.id, market.winningRanks.length, ...market.winningRanks);
  fields.push(
    definition.ticket.requiresBackedMarket ? 1 : 0,
    definition.ticket.stakeScope,
    definition.pricing.entryRtp.numerator,
    definition.pricing.entryRtp.denominator,
    definition.pricing.liquidationSpread.numerator,
    definition.pricing.liquidationSpread.denominator,
    definition.pricing.rounding,
    definition.pricing.minStakeCredits,
    definition.pricing.stakeStepCredits,
    definition.pricing.actions.length,
    ...definition.pricing.actions,
    definition.pricing.splitMode,
    definition.risk.maxWinMultiple,
    definition.risk.capMustNotBind ? 1 : 0,
    definition.seed.operatorSeedScope,
    definition.seed.clientEntropy,
    definition.seed.clientSeedBytes,
  );
  return createHash('sha256').update(encodeFields(fields)).digest('hex');
}

export function cardsIdentity(definition: SequentialCardsDefinition): DefinitionIdentity {
  return Object.freeze({
    moduleId: SEQUENTIAL_CARDS_MODULE_ID,
    moduleVersion: SEQUENTIAL_CARDS_MODULE_VERSION,
    definitionId: definition.id,
    definitionVersion: definition.version,
    fingerprint: cardsFingerprint(definition),
  });
}

/** Round-scoped identity; `definitionId` is the sampler domain. */
export function cardsRoundOf(
  definition: SequentialCardsDefinition,
  roundId: string,
): RoundIdentity {
  return Object.freeze({
    moduleId: SEQUENTIAL_CARDS_MODULE_ID,
    definitionId: definition.id,
    roundId,
    proofVersion: COMMITMENT_VERSION,
  });
}

/**
 * The only supported construction path.
 *
 * `assertCardsDefinition` establishes the declarative half. Everything after it
 * is an **economic** assertion that no field check could make, and each one is
 * settled by walking the definition's whole reachable space in exact rationals:
 *
 * - the prior over board positions is uniform, which is what makes a pre-reveal
 *   re-back free and every entry price equal;
 * - every liquidating action realises exactly `p · K · (1 − spread)`, so no
 *   action a player takes inside a round is priced against them;
 * - `minStakeCredits` is at least the non-zero-credit threshold, so no live
 *   claim can settle at zero credits under the declared flooring rule;
 * - when `capMustNotBind`, the largest reachable payout is **strictly** below
 *   the cap, so the rail can never truncate a legitimate win and can never
 *   silently reduce the published return.
 *
 * A definition that fails any of these is refused here rather than discovered
 * later as a paytable that does not pay what it says.
 */
export function defineCardsGame(input: SequentialCardsDefinition): SequentialCardsDefinition {
  assertCardsDefinition(input);
  const definition = freezeCardsDefinition(input);
  assertCardsDefinition(definition);
  const analysis = analyseDefinition(definition);
  if (!analysis.priorUniform)
    fail(
      'INVALID_ADAPTER',
      'The prior over board positions is not uniform; the deck model is inconsistent',
      '$.ladder',
    );
  if (!analysis.pricingIdentityHolds)
    fail(
      'INVALID_ADAPTER',
      'A liquidating action does not realise the fair value it was priced from',
      '$.pricing',
    );
  if (definition.pricing.minStakeCredits < analysis.minStakeThreshold)
    reject(
      'INVALID_ADAPTER',
      `Minimum stake must be at least ${analysis.minStakeThreshold} credits, the smallest stake at which no reachable payout credits zero`,
      '$.pricing.minStakeCredits',
      'STAKE_BELOW_MINIMUM',
    );
  if (
    definition.risk.capMustNotBind &&
    compare(analysis.maxPayoutMultiple, rational(definition.risk.maxWinMultiple)) >= 0
  )
    reject(
      'INVALID_ADAPTER',
      `A reachable payout of ${analysis.maxPayoutMultiple.numerator}/${analysis.maxPayoutMultiple.denominator} stake reaches the ${definition.risk.maxWinMultiple}x cap`,
      '$.risk.maxWinMultiple',
      'CAP_WOULD_BIND',
    );
  cardsFingerprint(definition);
  return definition;
}

/** Deep-freezes a definition without touching its declarative content. */
export function freezeCardsDefinition(input: SequentialCardsDefinition): SequentialCardsDefinition {
  return Object.freeze({
    apiVersion: input.apiVersion,
    moduleId: input.moduleId,
    id: input.id,
    version: input.version,
    ladder: Object.freeze({ ...input.ladder }),
    reveal: Object.freeze({ ...input.reveal }),
    backing: Object.freeze({ ...input.backing }),
    sideMarkets: Object.freeze(
      input.sideMarkets.map((market) =>
        Object.freeze({ id: market.id, winningRanks: Object.freeze([...market.winningRanks]) }),
      ),
    ),
    ticket: Object.freeze({ ...input.ticket }),
    pricing: Object.freeze({
      ...input.pricing,
      entryRtp: Object.freeze({ ...input.pricing.entryRtp }),
      liquidationSpread: Object.freeze({ ...input.pricing.liquidationSpread }),
      actions: Object.freeze([...input.pricing.actions]),
    }),
    risk: Object.freeze({ ...input.risk }),
    seed: Object.freeze({ ...input.seed }),
  });
}
