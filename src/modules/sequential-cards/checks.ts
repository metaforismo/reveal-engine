import { RECEIPT_SCHEMA, commandFingerprint, toWireReceipt } from '../../core/ledger.js';
import type { ConformanceFailure, ModuleConformanceCheck } from '../../core/module.js';
import {
  compare,
  equal as rationalEqual,
  floor as floorRational,
  multiply,
  rational,
} from '../../core/rational.js';
import { snapshotHash } from '../../core/snapshot.js';
import { weightProbability } from '../../core/weights.js';
import { cardsFingerprint, defineCardsGame } from './adapter.js';
import { analyseDefinition, forEachCanonicalState } from './analysis.js';
import type { PlayerChoice, RevealStep, SequentialCardsDefinition } from './contracts.js';
import {
  cardsBelief,
  cardsBeliefVector,
  claimProbability,
  objectivePositionOf,
  reachableObjectiveRanks,
} from './deck.js';
import { coverProbability, entryMultiplier, isTerminalCover, offeredActions } from './pricing.js';
import {
  CardsBook,
  openFingerprint as openTicketFingerprint,
  type CardsBookSnapshot,
  type TicketSelection,
} from './round-book.js';
import { deriveRevealSteps, eligiblePositions, encodeRevealStep, stepDigest } from './steps.js';
import {
  buildCardsTranscript,
  cardsTranscriptToWire,
  deserializeCardsTranscript,
  verifyCardsTranscript,
} from './transcript.js';
import { composeRoundSeed, deriveDeal, deriveSelectors } from './truth.js';
import { eligibleSetSize } from './validation.js';
import type { SequentialCardsShape } from './shape.js';

type Check = ModuleConformanceCheck<SequentialCardsShape>;

function failure(code: string, path: string, message: string): ConformanceFailure {
  return { code, path, message };
}

/** The backing a conformance round logs: the first `maxOpenBeforeReveal` positions. */
function conformanceChoices(definition: SequentialCardsDefinition): readonly PlayerChoice[] {
  return Object.freeze(
    Array.from({ length: definition.backing.maxOpenBeforeReveal }, (_value, index) =>
      Object.freeze({ index, kind: 'back' as const, position: index }),
    ),
  );
}

/** The ticket a conformance round opens: every backed position, plus one market. */
function conformanceTicket(definition: SequentialCardsDefinition): readonly TicketSelection[] {
  const stake = definition.pricing.minStakeCredits;
  const rows: TicketSelection[] = conformanceChoices(definition).map((choice) => ({
    id: `backed-${choice.position}`,
    kind: 'position' as const,
    position: choice.position,
    stake,
  }));
  const market = definition.sideMarkets[0];
  if (market !== undefined)
    rows.push({ id: `market-${market.id}`, kind: 'market', marketId: market.id, stake });
  return Object.freeze(rows);
}

/**
 * A staked, mid-round snapshot, re-derived by hand.
 *
 * Conformance checks are synchronous and the book's command API is not, so this
 * rebuilds what a real round would have written after one ticket and one reveal.
 * `tests/sequential-cards/module-contract.test.ts` pins it field for field
 * against a snapshot taken from an actual round, so the re-derivation cannot
 * drift into something `restore()` would reject for the wrong reason — which
 * would quietly turn every tamper case below into a pass.
 */
export function stakedCardsSnapshot(
  definition: SequentialCardsDefinition,
  seedHex: string,
  roundId: string,
): CardsBookSnapshot {
  const rows = conformanceTicket(definition);
  const choices = conformanceChoices(definition);
  const deal = deriveDeal(seedHex, definition, roundId);
  const steps = deriveRevealSteps(definition, deal, choices).slice(0, 1);
  const prior = cardsBelief(definition, []);
  const total = rows.reduce((sum, row) => sum + row.stake, 0n);
  const openFingerprint = openTicketFingerprint(roundId, rows);
  const revealFingerprint = commandFingerprint('reveal', [
    stepDigest([]),
    ...encodeRevealStep(steps[0] as RevealStep),
  ]);
  const base = {
    schema: 'reveal-engine/cards-book-v1' as const,
    definition: {
      id: definition.id,
      version: definition.version,
      fingerprint: cardsFingerprint(definition),
    },
    roundId,
    stepRevision: steps.length,
    ledgerRevision: 2,
    terminal: false,
    choices: choices.map((choice) => ({ ...choice })),
    steps: steps.map((step) => ({ ...step, sorted: [...step.sorted] })),
    selections: rows.map((row) => {
      const probability =
        row.kind === 'position'
          ? coverProbability(prior, [row.position])
          : claimProbability(definition, [], { kind: 'market', marketId: row.marketId });
      const claim = multiply(rational(row.stake), entryMultiplier(definition, probability));
      return {
        id: row.id,
        kind: row.kind,
        marketId: row.kind === 'market' ? row.marketId : null,
        openedPosition: row.kind === 'position' ? row.position : null,
        positions: row.kind === 'position' ? [row.position] : [],
        stake: String(row.stake),
        claim: { numerator: String(claim.numerator), denominator: String(claim.denominator) },
        decidedAtStepRevision: -1,
        status: 'live' as const,
        credited: '0',
      };
    }),
    decisions: [] as never[],
    settlement: null,
    liquidBalance: '0',
    capBasisStake: String(total),
    receipts: [
      {
        fingerprint: openFingerprint,
        receipt: toWireReceipt({
          schema: RECEIPT_SCHEMA,
          idempotencyKey: 'conformance-open',
          commandFingerprint: openFingerprint,
          action: 'open',
          ledgerRevision: 1,
          frameRevision: 0,
          debited: total,
          credited: 0n,
          balanceDelta: -total,
          capped: false,
        }),
      },
      {
        fingerprint: revealFingerprint,
        receipt: toWireReceipt({
          schema: RECEIPT_SCHEMA,
          idempotencyKey: 'conformance-reveal',
          commandFingerprint: revealFingerprint,
          action: 'reveal',
          ledgerRevision: 2,
          frameRevision: 0,
          debited: 0n,
          credited: 0n,
          balanceDelta: 0n,
          capped: false,
        }),
      },
    ],
  };
  return Object.freeze({
    ...base,
    snapshotHash: snapshotHash(base),
  }) as unknown as CardsBookSnapshot;
}

/**
 * An independently coded completion count.
 *
 * `deck.ts` counts by enumerating **ascending subsets** of the remaining pool and
 * filtering them against the bounds the published sorts imply. This counts by
 * enumerating **ordered assignments** of the pool to the hidden positions and
 * filtering them by rebuilding every published sort from the assignment itself.
 * The two share no code path, so agreeing on every reachable state is evidence
 * rather than a tautology.
 */
function countCompletionsDirectly(
  definition: SequentialCardsDefinition,
  steps: readonly RevealStep[],
): readonly bigint[] {
  const { size, dealt } = definition.ladder;
  const known = new Array<number>(dealt).fill(0);
  const revealedPositions = new Set<number>();
  const usedRanks = new Set<number>();
  for (const step of steps) {
    known[step.position] = step.rank;
    revealedPositions.add(step.position);
    usedRanks.add(step.rank);
  }
  const hidden: number[] = [];
  for (let position = 0; position < dealt; position += 1)
    if (!revealedPositions.has(position)) hidden.push(position);
  const pool: number[] = [];
  for (let rank = 1; rank <= size; rank += 1) if (!usedRanks.has(rank)) pool.push(rank);
  const counts = new Array<bigint>(dealt).fill(0n);
  const used = new Array<boolean>(pool.length).fill(false);
  const assign = (slot: number): void => {
    if (slot === hidden.length) {
      // Every published sort has to be exactly what this assignment induces.
      const seen = new Set<number>();
      for (const step of steps) {
        seen.add(step.position);
        if (!definition.reveal.sortRemaining) continue;
        const remaining: number[] = [];
        for (let position = 0; position < dealt; position += 1)
          if (!seen.has(position)) remaining.push(position);
        remaining.sort((left, right) => (known[left] as number) - (known[right] as number));
        if (
          remaining.length !== step.sorted.length ||
          remaining.some((position, index) => position !== step.sorted[index])
        )
          return;
      }
      counts[objectivePositionOf(definition, known)] =
        (counts[objectivePositionOf(definition, known)] as bigint) + 1n;
      return;
    }
    for (let index = 0; index < pool.length; index += 1) {
      if (used[index] === true) continue;
      used[index] = true;
      known[hidden[slot] as number] = pool[index] as number;
      assign(slot + 1);
      used[index] = false;
    }
  };
  assign(0);
  return counts;
}

const definitionIsFrozen: Check = {
  code: 'CARDS_DEFINITION_NOT_FROZEN',
  description: 'The definition and every declarative field inside it are deeply frozen',
  scope: 'definition',
  run({ definition, count }) {
    count('definitionsFrozen');
    const frozen = [
      definition,
      definition.ladder,
      definition.reveal,
      definition.backing,
      definition.ticket,
      definition.pricing,
      definition.pricing.actions,
      definition.risk,
      definition.seed,
      definition.sideMarkets,
      ...definition.sideMarkets,
      ...definition.sideMarkets.map((market) => market.winningRanks),
    ].every((value) => Object.isFrozen(value));
    const failures: ConformanceFailure[] = [];
    if (!frozen)
      failures.push(failure('CARDS_DEFINITION_NOT_FROZEN', '$', 'A declarative field is mutable'));
    if (
      JSON.stringify(defineCardsGame(definition), replacer) !== JSON.stringify(definition, replacer)
    )
      failures.push(
        failure('CARDS_DEFINITION_NOT_FROZEN', '$', 'define() does not round-trip its own output'),
      );
    return failures;
  },
};

function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `${value}n` : value;
}

const eligibleSetIsNonEmpty: Check = {
  code: 'CARDS_ELIGIBLE_SET_NONEMPTY',
  description:
    'Every reveal has at least one eligible card and the objective is defined on every deal',
  scope: 'definition',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    for (let index = 0; index < definition.reveal.count; index += 1) {
      count('eligibleSets');
      if (eligibleSetSize(definition, index) < 1)
        failures.push(
          failure(
            'CARDS_ELIGIBLE_SET_NONEMPTY',
            '$.reveal',
            `Reveal ${index} has no eligible card`,
          ),
        );
    }
    if (definition.ladder.dealt - definition.reveal.count < 1)
      failures.push(
        failure('CARDS_ELIGIBLE_SET_NONEMPTY', '$.reveal.count', 'No card stays hidden'),
      );
    if (definition.ladder.objective === 'middle' && definition.ladder.dealt % 2 === 0)
      failures.push(
        failure('CARDS_ELIGIBLE_SET_NONEMPTY', '$.ladder', 'A middle objective needs an odd hand'),
      );
    if (reachableObjectiveRanks(definition).length === 0)
      failures.push(
        failure('CARDS_ELIGIBLE_SET_NONEMPTY', '$.ladder', 'No rank can be the objective card'),
      );
    return failures;
  },
};

const beliefIsExhaustive: Check = {
  code: 'CARDS_BELIEF_EXHAUSTIVE',
  description: 'Belief weights equal the completion count from an independently coded enumeration',
  scope: 'round',
  run({ definition, seedHex, roundId, count }) {
    const deal = deriveDeal(seedHex, definition, roundId);
    const steps = deriveRevealSteps(definition, deal, conformanceChoices(definition));
    const failures: ConformanceFailure[] = [];
    for (let prefix = 0; prefix <= steps.length; prefix += 1) {
      const belief = cardsBelief(definition, steps.slice(0, prefix));
      const direct = countCompletionsDirectly(definition, steps.slice(0, prefix));
      count('beliefStatesCrossChecked');
      const directTotal = direct.reduce((sum, value) => sum + value, 0n);
      if (directTotal === 0n) {
        failures.push(
          failure('CARDS_BELIEF_EXHAUSTIVE', '$.steps', 'Independent count found no completions'),
        );
        continue;
      }
      for (let position = 0; position < definition.ladder.dealt; position += 1) {
        const counted = rational(direct[position] as bigint, directTotal);
        const priced = rational(belief.positionWeights[position] as bigint, belief.total);
        if (!rationalEqual(counted, priced))
          failures.push(
            failure(
              'CARDS_BELIEF_EXHAUSTIVE',
              `$.steps[${prefix}]`,
              `Position ${position} priced ${priced.numerator}/${priced.denominator} against a counted ${counted.numerator}/${counted.denominator}`,
            ),
          );
      }
    }
    return failures;
  },
};

const beliefIsNormalised: Check = {
  code: 'CARDS_BELIEF_NORMALISED',
  description:
    'Weights are non-negative with a positive total, reduced by their common factor, and sum to one',
  scope: 'round',
  run({ definition, seedHex, roundId, count }) {
    const deal = deriveDeal(seedHex, definition, roundId);
    const steps = deriveRevealSteps(definition, deal, conformanceChoices(definition));
    const failures: ConformanceFailure[] = [];
    for (let prefix = 0; prefix <= steps.length; prefix += 1) {
      const slice = steps.slice(0, prefix);
      const vector = cardsBeliefVector(definition, slice);
      count('beliefVectors');
      if (vector.total <= 0n)
        failures.push(
          failure('CARDS_BELIEF_NORMALISED', '$.belief', 'Weight total is not strictly positive'),
        );
      if (vector.weights.some((weight) => weight < 0n))
        failures.push(failure('CARDS_BELIEF_NORMALISED', '$.belief', 'A weight is negative'));
      if (vector.weights.reduce((sum, weight) => sum + weight, 0n) !== vector.total)
        failures.push(
          failure('CARDS_BELIEF_NORMALISED', '$.belief', 'Weights do not sum to the total'),
        );
      let sum = rational(0n);
      for (let position = 0; position < definition.ladder.dealt; position += 1)
        sum = {
          numerator:
            sum.numerator * weightProbability(vector, position).denominator +
            weightProbability(vector, position).numerator * sum.denominator,
          denominator: sum.denominator * weightProbability(vector, position).denominator,
        };
      if (!rationalEqual(rational(sum.numerator, sum.denominator), rational(1n)))
        failures.push(
          failure(
            'CARDS_BELIEF_NORMALISED',
            '$.belief',
            'Position probabilities do not sum to one',
          ),
        );
      // A reveal must eliminate to exactly zero, never to an epsilon: a position
      // whose weight is zero has to price at exactly zero as well.
      for (let position = 0; position < definition.ladder.dealt; position += 1)
        if (
          (vector.weights[position] === 0n) !==
          (claimProbability(definition, slice, { kind: 'position', positions: [position] })
            .numerator ===
            0n)
        )
          failures.push(
            failure(
              'CARDS_BELIEF_NORMALISED',
              '$.belief',
              `Position ${position} disagrees between the weight vector and the price`,
            ),
          );
    }
    return failures;
  },
};

const selectorIsPrecommitted: Check = {
  code: 'CARDS_SELECTOR_PRECOMMITTED',
  description:
    'Selectors derive from the seed alone and drive the reveal through the declared eligibility rule',
  scope: 'round',
  run({ definition, seedHex, roundId, count }) {
    const deal = deriveDeal(seedHex, definition, roundId);
    const standalone = deriveSelectors(seedHex, definition, roundId);
    const failures: ConformanceFailure[] = [];
    count('selectorSweeps');
    if (
      standalone.length !== deal.selectors.length ||
      standalone.some((selector, index) => selector !== deal.selectors[index])
    )
      failures.push(
        failure(
          'CARDS_SELECTOR_PRECOMMITTED',
          '$.deal.selectors',
          'Selectors depend on something other than the seed and the definition',
        ),
      );
    // Sweep every legal backing: the selectors must not move, and each reveal
    // must be exactly the sealed index into the eligible set.
    const width = definition.backing.maxOpenBeforeReveal;
    const positions = Array.from({ length: definition.ladder.dealt }, (_value, index) => index);
    const backings: number[][] = [];
    const build = (start: number, current: number[]): void => {
      if (current.length === width) {
        backings.push([...current]);
        return;
      }
      for (let index = start; index < positions.length; index += 1) {
        current.push(positions[index] as number);
        build(index + 1, current);
        current.pop();
      }
    };
    build(0, []);
    for (const backing of backings) {
      count('backingSweeps');
      const choices = backing.map((position, index) => ({
        index,
        kind: 'back' as const,
        position,
      }));
      const steps = deriveRevealSteps(definition, deal, choices);
      const backed = new Set(backing);
      const revealed = new Set<number>();
      steps.forEach((step, index) => {
        const eligible = eligiblePositions(definition, backed, revealed);
        if (eligible[deal.selectors[index] as number] !== step.position)
          failures.push(
            failure(
              'CARDS_SELECTOR_PRECOMMITTED',
              `$.steps[${index}]`,
              'Reveal is not the sealed index into the eligible set',
            ),
          );
        revealed.add(step.position);
      });
    }
    return failures;
  },
};

const revealIsDeterministic: Check = {
  code: 'CARDS_REVEAL_DETERMINISTIC',
  description: 'A transcript re-derives, round-trips its wire form, and rejects a tampered deal',
  scope: 'round',
  run({ definition, seedHex, roundId, count }) {
    const choices = conformanceChoices(definition);
    const first = buildCardsTranscript(seedHex, definition, roundId, choices);
    const second = buildCardsTranscript(seedHex, definition, roundId, choices);
    count('transcripts', 2);
    const failures: ConformanceFailure[] = [];
    if (
      JSON.stringify(cardsTranscriptToWire(first)) !== JSON.stringify(cardsTranscriptToWire(second))
    )
      failures.push(
        failure('CARDS_REVEAL_DETERMINISTIC', '$.steps', 'Two derivations from one seed differ'),
      );
    const decoded = deserializeCardsTranscript(cardsTranscriptToWire(first));
    if (
      JSON.stringify(cardsTranscriptToWire(decoded)) !==
      JSON.stringify(cardsTranscriptToWire(first))
    )
      failures.push(
        failure('CARDS_REVEAL_DETERMINISTIC', '$', 'Transcript does not survive its own wire form'),
      );
    if (!verifyCardsTranscript(seedHex, definition, cardsTranscriptToWire(first)).ok)
      failures.push(
        failure(
          'CARDS_REVEAL_DETERMINISTIC',
          '$.commitment',
          'A freshly built transcript fails to verify',
        ),
      );
    const tampered = {
      ...cardsTranscriptToWire(first),
      deal: {
        ranks: [...first.deal.ranks].reverse(),
        selectors: [...first.deal.selectors],
      },
    };
    const result = verifyCardsTranscript(seedHex, definition, tampered);
    if (result.ok)
      failures.push(
        failure('CARDS_REVEAL_DETERMINISTIC', '$.deal', 'A rewritten deal still verified'),
      );
    return failures;
  },
};

const terminalOffersNothing: Check = {
  code: 'CARDS_TERMINAL_OFFERS_NOTHING',
  description:
    'No action is offered where the backed cover is decided, and one is wherever it is not',
  scope: 'definition',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    const offersAnything = definition.pricing.actions.length > 0;
    forEachCanonicalState(definition, ({ backed, steps, belief }) => {
      count('offerStates');
      for (const position of backed) {
        const offers = offeredActions(definition, belief, [position], {
          stepRevision: steps.length,
          excluded: new Set([...backed].filter((other) => other !== position)),
        });
        const terminal = isTerminalCover(belief, [position]);
        if (terminal && offers.length > 0)
          failures.push(
            failure(
              'CARDS_TERMINAL_OFFERS_NOTHING',
              '$.pricing.actions',
              'A decided position was still offered an action',
            ),
          );
        if (!terminal && offersAnything && steps.length > 0 && offers.length === 0)
          failures.push(
            failure(
              'CARDS_TERMINAL_OFFERS_NOTHING',
              '$.pricing.actions',
              'A live position was offered nothing at all',
            ),
          );
      }
    });
    return failures;
  },
};

const actionsAreValueNeutral: Check = {
  code: 'CARDS_ACTIONS_VALUE_NEUTRAL',
  description:
    'Every liquidating action realises exactly the fair value it was priced from, in every state',
  scope: 'definition',
  run({ definition, count }) {
    const analysis = analyseDefinition(definition);
    count('valueNeutralityCells', analysis.decisionCells);
    const failures: ConformanceFailure[] = [];
    if (!analysis.pricingIdentityHolds)
      failures.push(
        failure(
          'CARDS_ACTIONS_VALUE_NEUTRAL',
          '$.pricing',
          'A liquidating action does not realise the value it was priced from',
        ),
      );
    if (definition.pricing.liquidationSpread.numerator === 0n && !analysis.actionsValueNeutral)
      failures.push(
        failure(
          'CARDS_ACTIONS_VALUE_NEUTRAL',
          '$.pricing.liquidationSpread',
          'A zero spread must leave every offered action with the identical exact value',
        ),
      );
    return failures;
  },
};

const policyReturnIsExtremal: Check = {
  code: 'CARDS_POLICY_RETURN_EXTREMAL',
  description:
    'The argmin and argmax policies over the whole reachable space return exactly what is declared',
  scope: 'definition',
  run({ definition, count }) {
    const analysis = analyseDefinition(definition);
    count('policyLines', analysis.lines);
    const failures: ConformanceFailure[] = [];
    if (!rationalEqual(analysis.bestPolicyReturn, definition.pricing.entryRtp))
      failures.push(
        failure(
          'CARDS_POLICY_RETURN_EXTREMAL',
          '$.pricing.entryRtp',
          `The best legal policy returns ${analysis.bestPolicyReturn.numerator}/${analysis.bestPolicyReturn.denominator}, not the declared entry RTP`,
        ),
      );
    if (compare(analysis.worstPolicyReturn, analysis.bestPolicyReturn) > 0)
      failures.push(
        failure(
          'CARDS_POLICY_RETURN_EXTREMAL',
          '$.pricing',
          'The worst legal policy returns more than the best one',
        ),
      );
    if (
      definition.pricing.liquidationSpread.numerator === 0n &&
      !rationalEqual(analysis.worstPolicyReturn, definition.pricing.entryRtp)
    )
      failures.push(
        failure(
          'CARDS_POLICY_RETURN_EXTREMAL',
          '$.pricing.entryRtp',
          `With a zero spread the worst legal policy must also return the entry RTP, not ${analysis.worstPolicyReturn.numerator}/${analysis.worstPolicyReturn.denominator}`,
        ),
      );
    return failures;
  },
};

const marketsAreReachable: Check = {
  code: 'CARDS_MARKET_REACHABLE',
  description: 'Every side market can pay, and prices at exactly the declared entry RTP',
  scope: 'definition',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    for (const market of definition.sideMarkets) {
      count('markets');
      const probability = claimProbability(definition, [], { kind: 'market', marketId: market.id });
      if (probability.numerator === 0n) {
        failures.push(
          failure('CARDS_MARKET_REACHABLE', '$.sideMarkets', `${market.id} can never pay`),
        );
        continue;
      }
      const realised = multiply(probability, entryMultiplier(definition, probability));
      if (!rationalEqual(realised, definition.pricing.entryRtp))
        failures.push(
          failure(
            'CARDS_MARKET_REACHABLE',
            '$.sideMarkets',
            `${market.id} realises ${realised.numerator}/${realised.denominator}, not the declared entry RTP`,
          ),
        );
    }
    return failures;
  },
};

const minStakeIsSufficient: Check = {
  code: 'CARDS_MIN_STAKE_SUFFICIENT',
  description:
    'The minimum stake is at least the non-zero-credit threshold, and that threshold is tight',
  scope: 'definition',
  run({ definition, count }) {
    const analysis = analyseDefinition(definition);
    count('stakeThresholds');
    const failures: ConformanceFailure[] = [];
    if (definition.pricing.minStakeCredits < analysis.minStakeThreshold)
      failures.push(
        failure(
          'CARDS_MIN_STAKE_SUFFICIENT',
          '$.pricing.minStakeCredits',
          `A live claim can settle at zero credits below ${analysis.minStakeThreshold}`,
        ),
      );
    const at = analysis.nonZeroCreditThreshold;
    if (floorRational(multiply(analysis.minPositivePayoutMultiple, rational(at))) < 1n)
      failures.push(
        failure(
          'CARDS_MIN_STAKE_SUFFICIENT',
          '$.pricing.minStakeCredits',
          'The published threshold still credits zero on the smallest reachable payout',
        ),
      );
    // And it is the *smallest* stake that does the job it claims to do: one
    // credit below it, the smallest reachable payout really does credit zero.
    if (
      at > 1n &&
      floorRational(multiply(analysis.minPositivePayoutMultiple, rational(at - 1n))) !== 0n
    )
      failures.push(
        failure(
          'CARDS_MIN_STAKE_SUFFICIENT',
          '$.pricing.minStakeCredits',
          'The published threshold is not the smallest one that avoids a zero credit',
        ),
      );
    return failures;
  },
};

const capNeverBinds: Check = {
  code: 'CARDS_CAP_NEVER_BINDS',
  description: 'When capMustNotBind, the reachable maximum is strictly below the cap',
  scope: 'definition',
  run({ definition, count }) {
    if (!definition.risk.capMustNotBind) return [];
    const analysis = analyseDefinition(definition);
    count('capChecks');
    return compare(analysis.maxPayoutMultiple, rational(definition.risk.maxWinMultiple)) >= 0
      ? [
          failure(
            'CARDS_CAP_NEVER_BINDS',
            '$.risk.maxWinMultiple',
            `A reachable payout of ${analysis.maxPayoutMultiple.numerator}/${analysis.maxPayoutMultiple.denominator} stake reaches the cap`,
          ),
        ]
      : [];
  },
};

const seedMixesClientEntropy: Check = {
  code: 'CARDS_SEED_MIXES_CLIENT_ENTROPY',
  description: 'The round seed changes when only the client seed changes, and requires one',
  scope: 'round',
  run({ definition, seedHex, roundId, count }) {
    const failures: ConformanceFailure[] = [];
    const clientSeeds = ['00'.repeat(16), `${'00'.repeat(15)}01`, `${'00'.repeat(15)}02`];
    const seeds = clientSeeds.map((clientSeed) =>
      composeRoundSeed({ definition, roundId, operatorSeed: seedHex, clientSeed, nonce: 0 }),
    );
    count('composedSeeds', seeds.length);
    if (new Set(seeds).size !== seeds.length)
      failures.push(
        failure(
          'CARDS_SEED_MIXES_CLIENT_ENTROPY',
          '$.seed',
          'Two client seeds produced the same round seed',
        ),
      );
    if (seeds.some((seed) => seed === seedHex))
      failures.push(
        failure(
          'CARDS_SEED_MIXES_CLIENT_ENTROPY',
          '$.seed',
          'The operator seed alone determined the round seed',
        ),
      );
    const deals = seeds.map((seed) => JSON.stringify(deriveDeal(seed, definition, roundId)));
    if (new Set(deals).size === 1)
      failures.push(
        failure(
          'CARDS_SEED_MIXES_CLIENT_ENTROPY',
          '$.deal',
          'Three client seeds produced the identical deal',
        ),
      );
    if (definition.seed.clientEntropy === 'required') {
      try {
        composeRoundSeed({ definition, roundId, operatorSeed: seedHex, clientSeed: '', nonce: 0 });
        failures.push(
          failure(
            'CARDS_SEED_MIXES_CLIENT_ENTROPY',
            '$.seed.clientEntropy',
            'A required client seed was not required',
          ),
        );
      } catch {
        // Expected: the definition demands player entropy in every round seed.
      }
    }
    return failures;
  },
};

const snapshotIsRevalidated: Check = {
  code: 'CARDS_SNAPSHOT_NOT_REVALIDATED',
  description: 'restore() round-trips its own snapshots and rejects re-sealed tampered ones',
  scope: 'round',
  run({ definition, seedHex, roundId, count }) {
    const failures: ConformanceFailure[] = [];
    const reject = (message: string): void => {
      failures.push(failure('CARDS_SNAPSHOT_NOT_REVALIDATED', '$.snapshot', message));
    };
    const empty = new CardsBook(definition).snapshot();
    const staked = stakedCardsSnapshot(definition, seedHex, roundId);
    count('snapshots', 2);
    for (const snapshot of [empty, staked])
      try {
        const restored = CardsBook.restore(definition, JSON.stringify(snapshot));
        if (JSON.stringify(restored.snapshot()) !== JSON.stringify(snapshot))
          reject('A restored book does not re-serialize identically');
      } catch (error) {
        reject(`Restore rejected its own snapshot: ${String(error)}`);
      }

    // Every mutation is re-sealed, so each is judged on its merits: a store that
    // can rewrite a field can recompute the checksum over it, and a case the
    // hash catches proves nothing about the validation underneath.
    const reseal = (value: Record<string, unknown>): string =>
      JSON.stringify({
        ...value,
        snapshotHash: snapshotHash({ ...value, snapshotHash: undefined }),
      });
    const selections = staked.selections as unknown as Record<string, unknown>[];
    const tampers: readonly string[] = [
      reseal({ ...staked, liquidBalance: '999999' }),
      reseal({ ...staked, capBasisStake: '999999' }),
      reseal({ ...staked, terminal: true }),
      reseal({ ...staked, ledgerRevision: 9 }),
      reseal({ ...staked, stepRevision: 0 }),
      reseal({ ...staked, definition: { ...staked.definition, fingerprint: '0'.repeat(64) } }),
      // The money-bearing rewrites: a bigger stake, a bigger claim, and a
      // different backed position all have to die on the open receipt.
      reseal({
        ...staked,
        selections: selections.map((row, index) =>
          index === 0 ? { ...row, stake: '999999' } : row,
        ),
      }),
      reseal({
        ...staked,
        selections: selections.map((row, index) =>
          index === 0 ? { ...row, claim: { numerator: '999999', denominator: '1' } } : row,
        ),
      }),
      reseal({
        ...staked,
        selections: selections.map((row, index) =>
          index === 0 && row.kind === 'position'
            ? {
                ...row,
                openedPosition: definition.ladder.dealt - 1,
                positions: [definition.ladder.dealt - 1],
              }
            : row,
        ),
      }),
      // A rewritten reveal has to die on the digest every receipt was fenced to.
      reseal({
        ...staked,
        steps: (staked.steps as unknown as Record<string, unknown>[]).map((step) => ({
          ...step,
          rank: ((step.rank as number) % definition.ladder.size) + 1,
        })),
      }),
      // Not re-sealed: the checksum still has to catch plain corruption.
      JSON.stringify({ ...staked, snapshotHash: '0'.repeat(64) }),
    ];
    for (const tampered of tampers) {
      count('snapshotTampers');
      try {
        CardsBook.restore(definition, tampered);
        reject('Restore accepted a tampered snapshot');
      } catch {
        // Expected: a tampered snapshot must not restore.
      }
    }
    return failures;
  },
};

export const SEQUENTIAL_CARDS_CHECKS: readonly Check[] = Object.freeze([
  definitionIsFrozen,
  eligibleSetIsNonEmpty,
  terminalOffersNothing,
  actionsAreValueNeutral,
  policyReturnIsExtremal,
  marketsAreReachable,
  minStakeIsSufficient,
  capNeverBinds,
  beliefIsExhaustive,
  beliefIsNormalised,
  selectorIsPrecommitted,
  revealIsDeterministic,
  seedMixesClientEntropy,
  snapshotIsRevalidated,
]);
