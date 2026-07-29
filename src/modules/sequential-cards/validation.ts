import { fail, type RevealEngineErrorCode } from '../../api/errors.js';
import { ENGINE_LIMITS } from '../../api/limits.js';
import { compare, rational, type Rational } from '../../core/rational.js';
import { assertIdentifier, assertRational, isRecord } from '../../core/validation.js';
import { ENGINE_API_VERSION } from '../../core/versions.js';
import {
  SEQUENTIAL_CARDS_MODULE_ID,
  type CardsRejectionReason,
  type Deal,
  type PlayerChoice,
  type RevealStep,
  type SequentialCardsDefinition,
} from './contracts.js';
import { CARDS_MAX_SUPPORT, combinationCount, isReachableObjectiveRank } from './deck.js';

/**
 * Structural validation for everything this module accepts from outside itself.
 *
 * Two rules hold throughout. Nothing is coerced: a value is the declared shape
 * or the call fails. And every failure carries a machine-readable
 * `details.reason` alongside one of the engine's existing public codes, because
 * `src/api/errors.ts` owns the code list and a lifecycle module does not get to
 * extend it — `docs/modules/sequential-cards.md` publishes the mapping.
 */

/** Step budget the module declares. A definition declares its own count inside it. */
export const CARDS_MAX_STEPS = 8;

/** Cards a definition may deal. Bounds the subset enumeration every price rests on. */
export const CARDS_MAX_DEALT = 16;

/** Side markets one definition may declare. */
export const CARDS_MAX_SIDE_MARKETS = 48;

/** Simultaneous claims the module's book admits; a definition may be stricter. */
export const CARDS_MAX_OPEN_CLAIMS = ENGINE_LIMITS.maxRoundClaims;

export function reject(
  code: RevealEngineErrorCode,
  message: string,
  path: string,
  reason: CardsRejectionReason,
): never {
  fail(code, message, path, { reason });
}

function rejectDefinition(message: string, path: string, reason: CardsRejectionReason): never {
  reject('INVALID_ADAPTER', message, path, reason);
}

/**
 * Cards a reveal may take at step `index`.
 *
 * Under `unbacked` the backed positions are excluded by **count**, not by
 * identity, which is the whole point: the selector is an index into this set and
 * is sealed with the deal, before there is a backed position to adapt it to.
 */
export function eligibleSetSize(
  definition: SequentialCardsDefinition,
  revealIndex: number,
): number {
  const base = definition.ladder.dealt - revealIndex;
  return definition.reveal.eligibility === 'unbacked'
    ? base - definition.backing.maxOpenBeforeReveal
    : base;
}

function assertPositiveRationalIn(
  value: unknown,
  path: string,
  {
    minExclusive,
    maxInclusive,
    maxExclusive,
  }: {
    readonly minExclusive?: Rational;
    readonly maxInclusive?: Rational;
    readonly maxExclusive?: Rational;
  },
  reason: CardsRejectionReason,
): asserts value is Rational {
  assertRational(value, path);
  if (minExclusive !== undefined && compare(value, minExclusive) <= 0)
    rejectDefinition(`${path} must be strictly above its floor`, path, reason);
  if (value.numerator < 0n) rejectDefinition(`${path} must be non-negative`, path, reason);
  if (maxInclusive !== undefined && compare(value, maxInclusive) > 0)
    rejectDefinition(`${path} is above its ceiling`, path, reason);
  if (maxExclusive !== undefined && compare(value, maxExclusive) >= 0)
    rejectDefinition(`${path} must be strictly below its ceiling`, path, reason);
}

function assertLadder(definition: SequentialCardsDefinition): void {
  const ladder = definition.ladder;
  if (!isRecord(ladder)) rejectDefinition('Missing ladder spec', '$.ladder', 'INVALID_LADDER');
  if (
    !Number.isSafeInteger(ladder.dealt) ||
    ladder.dealt < 3 ||
    ladder.dealt > CARDS_MAX_DEALT ||
    ladder.dealt > ENGINE_LIMITS.maxOutcomes
  )
    rejectDefinition(
      `Cards dealt must be a safe integer in [3, ${CARDS_MAX_DEALT}]`,
      '$.ladder.dealt',
      'INVALID_LADDER',
    );
  if (
    !Number.isSafeInteger(ladder.size) ||
    ladder.size < ladder.dealt ||
    ladder.size > ENGINE_LIMITS.maxPermutationSize
  )
    rejectDefinition(
      'Ladder size must be a safe integer at least as large as the hand',
      '$.ladder.size',
      'INVALID_LADDER',
    );
  if (
    ladder.objective !== 'middle' &&
    ladder.objective !== 'highest' &&
    ladder.objective !== 'lowest'
  )
    rejectDefinition('Unknown objective', '$.ladder.objective', 'INVALID_LADDER');
  // A missing middle must be a definition-time failure, never a runtime branch.
  if (ladder.objective === 'middle' && ladder.dealt % 2 === 0)
    rejectDefinition(
      'A middle objective needs an odd hand so the order statistic is unique',
      '$.ladder.dealt',
      'INVALID_LADDER',
    );
  if (combinationCount(ladder.size, ladder.dealt) > BigInt(CARDS_MAX_SUPPORT))
    rejectDefinition(
      `The deck's C(size, dealt) support exceeds the enumerated bound of ${CARDS_MAX_SUPPORT}`,
      '$.ladder',
      'INVALID_LADDER',
    );
}

function assertRevealAndBacking(definition: SequentialCardsDefinition): void {
  const reveal = definition.reveal;
  const backing = definition.backing;
  if (!isRecord(reveal)) rejectDefinition('Missing reveal spec', '$.reveal', 'INVALID_REVEAL_SPEC');
  if (!isRecord(backing))
    rejectDefinition('Missing backing spec', '$.backing', 'INVALID_REVEAL_SPEC');
  assertIdentifier(reveal.modelVersion, '$.reveal.modelVersion', 'INVALID_ADAPTER');
  if (!Number.isSafeInteger(reveal.count) || reveal.count < 1 || reveal.count > CARDS_MAX_STEPS)
    rejectDefinition(
      `Reveal count must be a safe integer in [1, ${CARDS_MAX_STEPS}]`,
      '$.reveal.count',
      'INVALID_REVEAL_SPEC',
    );
  if (reveal.count >= definition.ladder.dealt)
    rejectDefinition(
      'At least one card must stay hidden after every reveal',
      '$.reveal.count',
      'INVALID_REVEAL_SPEC',
    );
  if (reveal.eligibility !== 'unbacked' && reveal.eligibility !== 'any')
    rejectDefinition('Unknown reveal eligibility', '$.reveal.eligibility', 'INVALID_REVEAL_SPEC');
  if (typeof reveal.sortRemaining !== 'boolean')
    rejectDefinition(
      'sortRemaining must be a boolean',
      '$.reveal.sortRemaining',
      'INVALID_REVEAL_SPEC',
    );
  if (
    !Number.isSafeInteger(backing.maxOpenBeforeReveal) ||
    backing.maxOpenBeforeReveal < 1 ||
    backing.maxOpenBeforeReveal >= definition.ladder.dealt
  )
    rejectDefinition(
      'Backing width must be a safe integer in [1, dealt)',
      '$.backing.maxOpenBeforeReveal',
      'INVALID_REVEAL_SPEC',
    );
  if (backing.rebackMode !== 'move' && backing.rebackMode !== 'reject')
    rejectDefinition('Unknown reback mode', '$.backing.rebackMode', 'INVALID_REVEAL_SPEC');
  // The assertion that forbids a second backed position at definition time
  // rather than discovering it as an out-of-range selector index at runtime.
  for (let index = 0; index < reveal.count; index += 1)
    if (eligibleSetSize(definition, index) < 1)
      rejectDefinition(
        `Reveal ${index} would have an empty eligible set`,
        '$.backing.maxOpenBeforeReveal',
        'INVALID_REVEAL_SPEC',
      );
}

function assertSideMarkets(definition: SequentialCardsDefinition): void {
  const markets = definition.sideMarkets;
  if (!Array.isArray(markets) || markets.length > CARDS_MAX_SIDE_MARKETS)
    rejectDefinition(
      'Side markets must be a bounded array',
      '$.sideMarkets',
      'INVALID_SIDE_MARKET',
    );
  const seen = new Set<string>();
  markets.forEach((market, index) => {
    const path = `$.sideMarkets[${index}]`;
    if (!isRecord(market))
      rejectDefinition('Side market must be an object', path, 'INVALID_SIDE_MARKET');
    assertIdentifier(market.id, `${path}.id`, 'INVALID_ADAPTER');
    if (seen.has(market.id))
      rejectDefinition('Side market ids must be unique', `${path}.id`, 'INVALID_SIDE_MARKET');
    seen.add(market.id);
    const ranks = market.winningRanks;
    if (!Array.isArray(ranks) || ranks.length === 0 || ranks.length > definition.ladder.size)
      rejectDefinition(
        'Winning ranks must be a bounded non-empty array',
        `${path}.winningRanks`,
        'INVALID_SIDE_MARKET',
      );
    ranks.forEach((rank, rankIndex) => {
      if (
        !Number.isSafeInteger(rank) ||
        rank < 1 ||
        rank > definition.ladder.size ||
        (rankIndex > 0 && rank <= (ranks[rankIndex - 1] as number))
      )
        rejectDefinition(
          'Winning ranks must be sorted, unique, and inside the ladder',
          `${path}.winningRanks`,
          'INVALID_SIDE_MARKET',
        );
      // A market on an unreachable rank can never pay and is refused rather
      // than offered at a price.
      if (!isReachableObjectiveRank(definition, rank))
        rejectDefinition(
          `Rank ${rank} can never be the objective card`,
          `${path}.winningRanks`,
          'INVALID_SIDE_MARKET',
        );
    });
  });
}

function assertPricing(definition: SequentialCardsDefinition): void {
  const pricing = definition.pricing;
  if (!isRecord(pricing)) rejectDefinition('Missing pricing policy', '$.pricing', 'INVALID_LADDER');
  assertPositiveRationalIn(
    pricing.entryRtp,
    '$.pricing.entryRtp',
    { minExclusive: rational(0n), maxInclusive: rational(1n) },
    'INVALID_ROUNDING_POLICY',
  );
  assertPositiveRationalIn(
    pricing.liquidationSpread,
    '$.pricing.liquidationSpread',
    { maxExclusive: rational(1n) },
    'INVALID_LIQUIDATION_SPREAD',
  );
  // Only true odds. With a zero spread every offered action has the identical
  // exact value, so every legal policy returns `entryRtp` and the extremal
  // claims this module publishes need no search to be true. A non-zero spread
  // makes the extremes diverge, and the argmin over the policy space would then
  // need an information-state search `analysis.ts` does not perform — so the
  // definition is refused rather than reported on with a number that is not the
  // extreme it says it is.
  if (pricing.liquidationSpread.numerator !== 0n)
    rejectDefinition(
      'Only a zero liquidation spread is implemented; margin is charged once, at entry',
      '$.pricing.liquidationSpread',
      'INVALID_LIQUIDATION_SPREAD',
    );
  // `'ceiling'` and `'stochastic'` are declarable so a definition written
  // against them fails here with a reason a host can branch on, rather than in
  // a type-checker inside somebody else's build. Neither is implemented; see
  // docs/adr/0005-sequential-cards-scope-and-the-credit-boundary.md.
  if (pricing.rounding !== 'floor')
    rejectDefinition(
      `Rounding rule '${String(pricing.rounding)}' is declarable but not implemented; this version credits with 'floor'`,
      '$.pricing.rounding',
      'INVALID_ROUNDING_POLICY',
    );
  if (typeof pricing.stakeStepCredits !== 'bigint' || pricing.stakeStepCredits <= 0n)
    rejectDefinition(
      'Stake step must be a positive BigInt',
      '$.pricing.stakeStepCredits',
      'INVALID_STAKE_LATTICE',
    );
  if (typeof pricing.minStakeCredits !== 'bigint' || pricing.minStakeCredits <= 0n)
    rejectDefinition(
      'Minimum stake must be a positive BigInt',
      '$.pricing.minStakeCredits',
      'INVALID_STAKE_LATTICE',
    );
  if (pricing.minStakeCredits % pricing.stakeStepCredits !== 0n)
    rejectDefinition(
      'Minimum stake must sit on the stake step lattice',
      '$.pricing.minStakeCredits',
      'INVALID_STAKE_LATTICE',
    );
  if (!Array.isArray(pricing.actions) || pricing.actions.length > 3)
    rejectDefinition('Actions must be a bounded array', '$.pricing.actions', 'ACTION_NOT_OFFERED');
  pricing.actions.forEach((action, index) => {
    if (
      (action !== 'switch' && action !== 'split' && action !== 'cash') ||
      pricing.actions.indexOf(action) !== index
    )
      rejectDefinition(
        'Unknown or repeated action',
        `$.pricing.actions[${index}]`,
        'ACTION_NOT_OFFERED',
      );
  });
  if (pricing.splitMode !== 'even')
    rejectDefinition('Unknown split mode', '$.pricing.splitMode', 'ACTION_NOT_OFFERED');
  // A split hedges across at least two positions, so a definition that offers it
  // must still have two of them hidden once every reveal has landed.
  if (pricing.actions.includes('split') && definition.ladder.dealt - definition.reveal.count < 2)
    rejectDefinition(
      'A split needs at least two hidden positions after the last reveal',
      '$.pricing.actions',
      'ACTION_NOT_OFFERED',
    );
}

function assertTicketRiskAndSeed(definition: SequentialCardsDefinition): void {
  const ticket = definition.ticket;
  if (!isRecord(ticket))
    rejectDefinition('Missing ticket spec', '$.ticket', 'BACKED_SELECTION_REQUIRED');
  if (typeof ticket.requiresBackedMarket !== 'boolean')
    rejectDefinition(
      'requiresBackedMarket must be a boolean',
      '$.ticket.requiresBackedMarket',
      'BACKED_SELECTION_REQUIRED',
    );
  if (ticket.stakeScope !== 'per-selection')
    rejectDefinition('Unknown stake scope', '$.ticket.stakeScope', 'INVALID_STAKE_LATTICE');

  const risk = definition.risk;
  if (!isRecord(risk)) rejectDefinition('Missing risk policy', '$.risk', 'CAP_WOULD_BIND');
  if (typeof risk.maxWinMultiple !== 'bigint' || risk.maxWinMultiple <= 0n)
    rejectDefinition(
      'Max win multiple must be a positive BigInt',
      '$.risk.maxWinMultiple',
      'CAP_WOULD_BIND',
    );
  if (typeof risk.capMustNotBind !== 'boolean')
    rejectDefinition('capMustNotBind must be a boolean', '$.risk.capMustNotBind', 'CAP_WOULD_BIND');

  const seed = definition.seed;
  if (!isRecord(seed)) rejectDefinition('Missing seed policy', '$.seed', 'MISSING_CLIENT_ENTROPY');
  if (seed.operatorSeedScope !== 'per-round')
    rejectDefinition(
      'Only per-round operator seeds are supported',
      '$.seed.operatorSeedScope',
      'MISSING_CLIENT_ENTROPY',
    );
  if (seed.clientEntropy !== 'required' && seed.clientEntropy !== 'optional')
    rejectDefinition(
      'Unknown client entropy policy',
      '$.seed.clientEntropy',
      'MISSING_CLIENT_ENTROPY',
    );
  if (
    !Number.isSafeInteger(seed.clientSeedBytes) ||
    seed.clientSeedBytes < (seed.clientEntropy === 'required' ? 16 : 0) ||
    seed.clientSeedBytes > 128
  )
    rejectDefinition(
      'Client seed must be at least 16 bytes when entropy is required',
      '$.seed.clientSeedBytes',
      'MISSING_CLIENT_ENTROPY',
    );

  const budget = definition.backing.maxOpenBeforeReveal + definition.sideMarkets.length;
  if (budget < 1 || budget > CARDS_MAX_OPEN_CLAIMS)
    rejectDefinition(
      'Backed positions plus side markets exceed the round claim budget',
      '$.sideMarkets',
      'DUPLICATE_SELECTION',
    );
  if (ticket.requiresBackedMarket && definition.backing.maxOpenBeforeReveal < 1)
    rejectDefinition(
      'A ticket that requires a backed market must admit one',
      '$.ticket.requiresBackedMarket',
      'BACKED_SELECTION_REQUIRED',
    );
}

/**
 * Structural assertion for a definition.
 *
 * This is the cheap half. `defineCardsGame()` runs it and then proves the
 * economic assertions by exhaustion — the reachable maximum against the cap, the
 * minimum stake against the non-zero-credit threshold, and value-neutrality in
 * every decision state — because those need the whole state space, not a field
 * check.
 */
export function assertCardsDefinition(
  value: unknown,
  path = '$',
): asserts value is SequentialCardsDefinition {
  if (!isRecord(value)) rejectDefinition('Expected a definition object', path, 'INVALID_LADDER');
  const definition = value as unknown as SequentialCardsDefinition;
  if (definition.apiVersion !== ENGINE_API_VERSION)
    fail('UNSUPPORTED_VERSION', 'Unsupported definition api version', `${path}.apiVersion`);
  if (definition.moduleId !== SEQUENTIAL_CARDS_MODULE_ID)
    fail('DEFINITION_MISMATCH', 'Definition belongs to another module', `${path}.moduleId`);
  assertIdentifier(definition.id, `${path}.id`, 'INVALID_ADAPTER');
  assertIdentifier(definition.version, `${path}.version`, 'INVALID_ADAPTER');
  assertLadder(definition);
  assertRevealAndBacking(definition);
  assertSideMarkets(definition);
  assertPricing(definition);
  assertTicketRiskAndSeed(definition);
}

/** Validates a deal against the definition it claims to belong to. */
export function assertDeal(
  definition: SequentialCardsDefinition,
  value: unknown,
  path = '$.deal',
): asserts value is Deal {
  if (!isRecord(value)) fail('INVALID_TRANSCRIPT', 'Expected a deal object', path);
  const deal = value as unknown as Deal;
  if (!Array.isArray(deal.ranks) || deal.ranks.length !== definition.ladder.dealt)
    fail('INVALID_TRANSCRIPT', 'Deal must hold exactly the dealt ranks', `${path}.ranks`);
  const seen = new Set<number>();
  deal.ranks.forEach((rank) => {
    if (!Number.isSafeInteger(rank) || rank < 1 || rank > definition.ladder.size || seen.has(rank))
      fail(
        'INVALID_TRANSCRIPT',
        'Deal ranks must be distinct and inside the ladder',
        `${path}.ranks`,
      );
    seen.add(rank);
  });
  if (!Array.isArray(deal.selectors) || deal.selectors.length !== definition.reveal.count)
    fail('INVALID_TRANSCRIPT', 'Deal must hold one selector per reveal', `${path}.selectors`);
  deal.selectors.forEach((selector, index) => {
    if (
      !Number.isSafeInteger(selector) ||
      selector < 0 ||
      selector >= eligibleSetSize(definition, index)
    )
      fail(
        'INVALID_TRANSCRIPT',
        'Selector is outside the eligible set it indexes',
        `${path}.selectors[${index}]`,
      );
  });
}

/**
 * Validates a logged choice list.
 *
 * The whole log is backing decisions, taken before the first reveal: a backed
 * position is what the eligible set excludes, and the selectors were sealed
 * against a count of backed positions. Logging one after a reveal would make the
 * sealed index mean something different from what it meant when it was sealed.
 */
export function assertPlayerChoices(
  definition: SequentialCardsDefinition,
  value: unknown,
  path = '$.choices',
): asserts value is readonly PlayerChoice[] {
  if (!Array.isArray(value)) fail('INVALID_CHOICE', 'Choices must be an array', path);
  if (value.length > definition.backing.maxOpenBeforeReveal)
    reject(
      'INVALID_CHOICE',
      'More backed positions than the definition admits',
      path,
      'POSITION_ALREADY_BACKED',
    );
  const seen = new Set<number>();
  value.forEach((choice: unknown, index) => {
    if (!isRecord(choice)) fail('INVALID_CHOICE', 'Choice must be an object', `${path}[${index}]`);
    const entry = choice as unknown as PlayerChoice;
    if (entry.kind !== 'back')
      fail('INVALID_CHOICE', 'Unknown choice kind', `${path}[${index}].kind`);
    if (entry.index !== index)
      reject(
        'INVALID_CHOICE',
        'Choice log is not densely indexed in order',
        `${path}[${index}].index`,
        'CHOICE_CONFLICT',
      );
    if (
      !Number.isSafeInteger(entry.position) ||
      entry.position < 0 ||
      entry.position >= definition.ladder.dealt
    )
      fail('INVALID_CHOICE', 'Backed position is out of range', `${path}[${index}].position`);
    if (seen.has(entry.position))
      reject(
        'INVALID_CHOICE',
        'A position may be backed only once',
        `${path}[${index}].position`,
        'POSITION_ALREADY_BACKED',
      );
    seen.add(entry.position);
  });
}

/**
 * Validates a reveal step list as public record.
 *
 * This is what a restored snapshot's steps go through: positions and ranks
 * distinct and in range, the eligibility rule respected, and the published sort
 * a permutation of exactly the positions that are still hidden. It establishes
 * internal consistency, not provenance — only `settle`, which verifies the
 * transcript against the revealed seed, establishes that these are the committed
 * deal's reveals.
 */
export function assertRevealSteps(
  definition: SequentialCardsDefinition,
  choices: readonly PlayerChoice[],
  value: unknown,
  path = '$.steps',
): asserts value is readonly RevealStep[] {
  if (!Array.isArray(value) || value.length > definition.reveal.count)
    fail('INVALID_TRANSCRIPT', 'Steps must be a bounded array', path);
  const backed = new Set(choices.map((choice) => choice.position));
  const revealedPositions = new Set<number>();
  const revealedRanks = new Set<number>();
  value.forEach((step: unknown, index) => {
    const entry = step as RevealStep;
    if (!isRecord(step)) fail('INVALID_TRANSCRIPT', 'Step must be an object', `${path}[${index}]`);
    if (entry.index !== index)
      fail('INVALID_TRANSCRIPT', 'Steps are not densely indexed', `${path}[${index}].index`);
    if (
      !Number.isSafeInteger(entry.position) ||
      entry.position < 0 ||
      entry.position >= definition.ladder.dealt ||
      revealedPositions.has(entry.position)
    )
      fail('INVALID_TRANSCRIPT', 'Step position is invalid', `${path}[${index}].position`);
    if (definition.reveal.eligibility === 'unbacked' && backed.has(entry.position))
      reject(
        'INVALID_TRANSCRIPT',
        'A backed position is never eligible for a reveal',
        `${path}[${index}].position`,
        'CHOICE_CONFLICT',
      );
    if (
      !Number.isSafeInteger(entry.rank) ||
      entry.rank < 1 ||
      entry.rank > definition.ladder.size ||
      revealedRanks.has(entry.rank)
    )
      fail('INVALID_TRANSCRIPT', 'Step rank is invalid', `${path}[${index}].rank`);
    assertIdentifier(entry.label, `${path}[${index}].label`, 'INVALID_TRANSCRIPT');
    revealedPositions.add(entry.position);
    revealedRanks.add(entry.rank);
    const hidden: number[] = [];
    for (let position = 0; position < definition.ladder.dealt; position += 1)
      if (!revealedPositions.has(position)) hidden.push(position);
    if (!Array.isArray(entry.sorted))
      fail('INVALID_TRANSCRIPT', 'Step sort must be an array', `${path}[${index}].sorted`);
    const expectedLength = definition.reveal.sortRemaining ? hidden.length : 0;
    if (entry.sorted.length !== expectedLength)
      fail('INVALID_TRANSCRIPT', 'Step sort has the wrong width', `${path}[${index}].sorted`);
    const seen = new Set<number>();
    entry.sorted.forEach((position) => {
      if (!hidden.includes(position) || seen.has(position))
        fail(
          'INVALID_TRANSCRIPT',
          'Step sort must be a permutation of the hidden positions',
          `${path}[${index}].sorted`,
        );
      seen.add(position);
    });
    // The published order is cumulative: turning one card face up removes it
    // from the order and moves nothing else. A sort that reordered the survivors
    // would contradict what the board already showed, and the posterior reads
    // both sorts, so the contradiction has to be refused rather than priced.
    if (index > 0 && definition.reveal.sortRemaining) {
      const previous = (value[index - 1] as RevealStep).sorted;
      const expected = previous.filter((position) => position !== entry.position);
      if (
        expected.length !== entry.sorted.length ||
        expected.some((position, slot) => position !== entry.sorted[slot])
      )
        fail(
          'INVALID_TRANSCRIPT',
          'Step sort contradicts the order the board already published',
          `${path}[${index}].sorted`,
        );
    }
  });
}
