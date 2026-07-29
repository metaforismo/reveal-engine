import { RevealEngineError } from '../../api/errors.js';
import { RECEIPT_SCHEMA, commandFingerprint, toWireReceipt } from '../../core/ledger.js';
import type { ConformanceFailure, ModuleConformanceCheck } from '../../core/module.js';
import {
  add,
  compare,
  equal as rationalEqual,
  floor as floorRational,
  multiply,
  rational,
  type Rational,
} from '../../core/rational.js';
import { snapshotHash } from '../../core/snapshot.js';
import { weightProbability } from '../../core/weights.js';
import { cardsFingerprint, defineCardsGame } from './adapter.js';
import { analyseDefinition, forEachCanonicalState } from './analysis.js';
import type {
  CardsRejectionReason,
  PlayerChoice,
  RevealStep,
  SequentialCardsDefinition,
} from './contracts.js';
import {
  cardsBelief,
  cardsBeliefVector,
  claimProbability,
  forEachCombination,
  objectivePositionOf,
  reachableObjectiveRanks,
  type CardsBelief,
} from './deck.js';
import { payableWithinCap } from '../../core/payments.js';
import {
  convertToCredits,
  creditsFromDraw,
  deriveRoundingSeed,
  roundingCommitment,
  type CreditTape,
} from './credits.js';
import { cardsRoundOf } from './adapter.js';
import {
  coverProbability,
  entryMultiplier,
  fairValue,
  isTerminalCover,
  livePositions,
  offeredActions,
  transformedClaim,
} from './pricing.js';
import {
  CardsBook,
  assertTicketComposition,
  openFingerprint as openTicketFingerprint,
  settlementTotal,
  type CardsBookSnapshot,
  type CardsSelection,
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
import { assertPlayerChoices, eligibleSetSize } from './validation.js';
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
  // A stochastic definition credits from a committed tape, and the tape is a
  // one-way derivative of the same seed this round is derived from — so the
  // snapshot a conformance check hand-builds is the snapshot a real round of
  // that definition writes, tape and all.
  const roundingSeed =
    definition.pricing.rounding === 'stochastic'
      ? deriveRoundingSeed(seedHex, cardsFingerprint(definition), roundId)
      : undefined;
  const openFingerprint = openTicketFingerprint(
    roundId,
    rows,
    roundingSeed === undefined ? undefined : roundingCommitment(roundingSeed),
  );
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
    ...(roundingSeed === undefined ? {} : { roundingSeed }),
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

/** One offered control, as the pair that fixes its whole return distribution. */
interface ControlOutcome {
  readonly label: string;
  readonly claim: Rational;
  readonly favourable: bigint;
}

/** Belief weight a cover carries, counted here rather than read from a price. */
function coverWeight(belief: CardsBelief, cover: readonly number[]): bigint {
  let favourable = 0n;
  for (const position of cover) favourable += belief.positionWeights[position] as bigint;
  return favourable;
}

/** Every subset of `live` of width at least two, in ascending order. */
function splitCoversOf(live: readonly number[]): number[][] {
  const sets: number[][] = [];
  for (let width = 2; width <= live.length; width += 1)
    forEachCombination(live.length, width, (indices) =>
      sets.push(indices.map((index) => live[index] as number)),
    );
  return sets;
}

/**
 * Every cover a claim that started on `start` can be holding when the board is
 * at `steps`, re-derived forward through the controls the definition offers.
 *
 * This is the reachability `analysis.ts` gets as a side effect of its claim
 * walk, rebuilt here from the offer rules alone so the two enumerations are
 * independent up to the shared definition of what is offered.
 */
function reachableCovers(
  definition: SequentialCardsDefinition,
  start: number,
  steps: readonly RevealStep[],
  beliefAt: (revision: number) => CardsBelief,
): number[][] {
  let covers: number[][] = [[start]];
  for (let revision = 1; revision < steps.length; revision += 1) {
    const belief = beliefAt(revision);
    const live = livePositions(belief);
    const seen = new Set(covers.map((cover) => cover.join(',')));
    const next = [...covers];
    const add = (cover: readonly number[]): void => {
      const key = cover.join(',');
      if (seen.has(key)) return;
      seen.add(key);
      next.push([...cover]);
    };
    for (const cover of covers) {
      if (isTerminalCover(belief, cover)) continue;
      const offers = offeredActions(definition, belief, cover, {
        stepRevision: revision,
        excluded: new Set<number>(),
      });
      if (offers.includes('switch'))
        for (const target of live) if (!cover.includes(target)) add([target]);
      if (offers.includes('split')) for (const set of splitCoversOf(live)) add(set);
    }
    covers = next;
  }
  return covers;
}

/**
 * The states where a control does nothing, found by comparing distributions.
 *
 * `CARDS_ACTIONS_VALUE_NEUTRAL` is the check a game author will assume covers
 * this, and it does not: with `liquidationSpread = 0` **every** action has the
 * same expected value by construction, so the value-neutrality check passes in
 * exactly the state where a control is a relabelled hold. Only the distribution
 * separates them — the amount and the belief weight it lands on, compared leaf
 * value by leaf value — and this walk reports how many such states a definition
 * has rather than letting a revision assert there are none.
 *
 * Two things make it fail, and both are defects in the module rather than
 * judgements about a definition. The module's own definition-time walk must
 * reach the identical set of cells and agree cell for cell — two independent
 * enumerations of one property disagreeing is a defect in one of them, never a
 * figure to publish. And a coincidence must have the module's stated cause: two
 * actions coincide **because their covers carry exactly equal probability**, so
 * a pair that matches on the distribution while the covers price differently
 * would mean the claim transformation and the belief had come apart.
 *
 * What it deliberately does **not** do is refuse a definition whose control is a
 * no-op in every state that offers it. `triad/docs/ENGINE.md` §5.6 asks for that
 * ("a definition that offers such a control without declaring it fails") and it
 * cannot be honoured here for two reasons: a definition has no field to declare
 * it in, and `switch` before the first reveal is a **re-back** — it changes which
 * card is backed and therefore which card the reveal may take — so a control
 * that is a relabelled hold after every reveal can still be a real control
 * before the first one. `identicalActionDecoyControls` reports the count instead,
 * and `docs/modules/sequential-cards.md` §12 states the disclosure obligation
 * that leaves with the game.
 */
const identicalActionsAreEnumerated: Check = {
  code: 'CARDS_IDENTICAL_ACTIONS_ENUMERATED',
  description:
    'States where two offered controls share one return distribution are enumerated by comparing whole distributions, and reported',
  scope: 'definition',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    const analysis = analyseDefinition(definition);
    const beliefs = new Map<string, CardsBelief>();
    const offeredCount = new Map<string, number>();
    const noOpCount = new Map<string, number>();
    const signatures = new Set<string>();
    let cells = 0;
    let noOpCells = 0;

    forEachCanonicalState(definition, ({ backed, steps, belief }) => {
      if (steps.length === 0) return;
      const key = (revision: number): string =>
        steps
          .slice(0, revision)
          .map((step) => `${step.position}:${step.rank}`)
          .join('|');
      const beliefAt = (revision: number): CardsBelief => {
        const memo = beliefs.get(key(revision));
        if (memo !== undefined) return memo;
        const value = cardsBelief(definition, steps.slice(0, revision));
        beliefs.set(key(revision), value);
        return value;
      };
      const live = livePositions(belief);
      // One walk per backed position, exactly as the definition-time analysis
      // starts one claim per backed position: the two enumerations have to
      // stand on the same reachable set for their counts to be comparable.
      for (const start of backed) {
        for (const cover of reachableCovers(definition, start, steps, beliefAt)) {
          if (isTerminalCover(belief, cover)) continue;
          const offers = offeredActions(definition, belief, cover, {
            stepRevision: steps.length,
            excluded: new Set<number>(),
          });
          if (offers.length === 0) continue;
          cells += 1;
          const probability = coverProbability(belief, cover);
          const outcomes: ControlOutcome[] = [
            { label: 'hold', claim: rational(1n), favourable: coverWeight(belief, cover) },
          ];
          if (offers.includes('switch'))
            for (const target of live) {
              if (cover.includes(target)) continue;
              outcomes.push({
                label: `switch:${target}`,
                claim: transformedClaim(
                  definition,
                  rational(1n),
                  probability,
                  coverProbability(belief, [target]),
                ),
                favourable: coverWeight(belief, [target]),
              });
            }
          if (offers.includes('split'))
            for (const set of splitCoversOf(live))
              outcomes.push({
                label: `split:${set.join('-')}`,
                claim: transformedClaim(
                  definition,
                  rational(1n),
                  probability,
                  coverProbability(belief, set),
                ),
                favourable: coverWeight(belief, set),
              });
          for (const outcome of outcomes)
            if (outcome.label !== 'hold') {
              const control = outcome.label.split(':')[0] as string;
              offeredCount.set(control, (offeredCount.get(control) ?? 0) + 1);
            }
          let identicalHere = false;
          for (let left = 0; left < outcomes.length; left += 1)
            for (let right = left + 1; right < outcomes.length; right += 1) {
              const one = outcomes[left] as ControlOutcome;
              const other = outcomes[right] as ControlOutcome;
              if (one.favourable !== other.favourable || !rationalEqual(one.claim, other.claim))
                continue;
              identicalHere = true;
              // The stated cause of every coincidence: equal cover probability
              // against the shared denominator. A pair that agrees on the
              // distribution while the covers price differently would mean the
              // claim transformation and the belief had come apart.
              if (
                !rationalEqual(
                  rational(one.favourable, belief.total),
                  rational(other.favourable, belief.total),
                )
              )
                failures.push(
                  failure(
                    'CARDS_IDENTICAL_ACTIONS_ENUMERATED',
                    '$.pricing',
                    `'${one.label}' and '${other.label}' share a return distribution while their covers price differently`,
                  ),
                );
              for (const outcome of [one, other])
                if (outcome.label !== 'hold') {
                  const control = outcome.label.split(':')[0] as string;
                  noOpCount.set(control, (noOpCount.get(control) ?? 0) + 1);
                }
              signatures.add(
                `${belief.positionWeights.join(',')}/${belief.total}|${cover.join('-')}|${one.label}~${other.label}`,
              );
            }
          if (identicalHere) noOpCells += 1;
        }
      }
    });

    let decoys = 0;
    for (const [control, offered] of offeredCount)
      if (offered > 0 && (noOpCount.get(control) ?? 0) >= offered) decoys += 1;
    count('identicalActionCellsExamined', cells);
    count('identicalActionCells', noOpCells);
    count('identicalActionSignatures', signatures.size);
    count('identicalActionDecoyControls', decoys);

    if (noOpCells !== analysis.identicalActionCells)
      failures.push(
        failure(
          'CARDS_IDENTICAL_ACTIONS_ENUMERATED',
          '$.pricing',
          `This walk found ${noOpCells} no-op cell(s) and the definition-time walk found ${analysis.identicalActionCells}; two enumerations of the same reachable set disagree`,
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

/**
 * The reveal reads the choice log **only** through the eligibility rule.
 *
 * `CARDS_SELECTOR_PRECOMMITTED` establishes that the selector comes from the
 * seed alone. That is half the property: a selector sealed before the backing
 * exists is still free to be applied to a set the backing chose, and a
 * derivation that consulted the log for anything beyond narrowing that set
 * would let a player move the cut by moving their claim. So this walks every
 * admissible backing of the declared width, re-derives each reveal by hand as
 * `eligiblePositions(backed, revealed)[selector]`, and — the part that is the
 * actual claim — asserts that two different backings inducing the identical
 * eligible sets produce the identical reveals.
 */
const revealIsChoiceBound: Check = {
  code: 'CARDS_REVEAL_CHOICE_BOUND',
  description: 'A reveal depends on the choice log only through the declared eligibility rule',
  scope: 'round',
  run({ definition, seedHex, roundId, count }) {
    const failures: ConformanceFailure[] = [];
    const deal = deriveDeal(seedHex, definition, roundId);
    const byEligibility = new Map<string, string>();
    forEachCombination(
      definition.ladder.dealt,
      definition.backing.maxOpenBeforeReveal,
      (chosen) => {
        count('choiceBoundBackings');
        const choices = chosen.map((position, index) => ({
          index,
          kind: 'back' as const,
          position,
        }));
        const backed = new Set(chosen);
        const steps = deriveRevealSteps(definition, deal, choices);
        const revealed = new Set<number>();
        const eligibility: string[] = [];
        steps.forEach((step, index) => {
          const eligible = eligiblePositions(definition, backed, revealed);
          eligibility.push(eligible.join('.'));
          const selector = deal.selectors[index] as number;
          if (step.position !== eligible[selector])
            failures.push(
              failure(
                'CARDS_REVEAL_CHOICE_BOUND',
                `$.steps[${index}].position`,
                'A reveal is not the sealed selector indexing the eligible set',
              ),
            );
          revealed.add(step.position);
        });
        // The eligible sets are the entire channel the log is allowed to use, so
        // equal channels must give equal reveals whatever the backing was. The
        // order the log was written in is not part of that channel either.
        const value = JSON.stringify(steps);
        const reordered = [...chosen]
          .reverse()
          .map((position, index) => ({ index, kind: 'back' as const, position }));
        if (JSON.stringify(deriveRevealSteps(definition, deal, reordered)) !== value)
          failures.push(
            failure(
              'CARDS_REVEAL_CHOICE_BOUND',
              '$.choices',
              'Reordering the backing log changed the reveal it derives',
            ),
          );
        const key = eligibility.join('|');
        const seen = byEligibility.get(key);
        if (seen === undefined) byEligibility.set(key, value);
        else if (seen !== value)
          failures.push(
            failure(
              'CARDS_REVEAL_CHOICE_BOUND',
              '$.steps',
              'Two backings with identical eligible sets derived different reveals',
            ),
          );
      },
    );
    return failures;
  },
};

/**
 * At most `maxOpenBeforeReveal` positions are open when a reveal derives.
 *
 * The selector was sealed against a set whose size is `dealt − i − width`, so a
 * log of any other width indexes a set that is not the one the commitment was
 * made against. That has to be a refusal at the derivation, not a clamp.
 */
const backingStaysSingle: Check = {
  code: 'CARDS_SINGLE_BACKED_POSITION',
  description: 'A reveal derives only against a backing log of exactly the declared width',
  scope: 'round',
  run({ definition, seedHex, roundId, count }) {
    const failures: ConformanceFailure[] = [];
    const deal = deriveDeal(seedHex, definition, roundId);
    const width = definition.backing.maxOpenBeforeReveal;
    const conforming = conformanceChoices(definition);
    count('backingWidths');
    try {
      deriveRevealSteps(definition, deal, conforming);
    } catch (error) {
      failures.push(
        failure(
          'CARDS_SINGLE_BACKED_POSITION',
          '$.choices',
          `A conforming backing log did not derive: ${String(error)}`,
        ),
      );
    }
    const refuses = (label: string, choices: readonly unknown[]): void => {
      count('backingRefusals');
      try {
        assertPlayerChoices(definition, choices);
        deriveRevealSteps(definition, deal, choices);
        failures.push(
          failure('CARDS_SINGLE_BACKED_POSITION', '$.choices', `${label} was accepted`),
        );
      } catch {
        // Expected: the log is not the one the selector was sealed against.
      }
    };
    refuses('A backing log wider than the definition admits', [
      ...conforming,
      { index: width, kind: 'back', position: (width % definition.ladder.dealt) as number },
    ]);
    refuses(
      'A backing log that backs one position twice',
      Array.from({ length: width + 1 }, (_value, index) => ({ index, kind: 'back', position: 0 })),
    );
    if (definition.reveal.eligibility === 'unbacked' && width > 1)
      refuses('A backing log narrower than the selector was sealed against', conforming.slice(1));
    return failures;
  },
};

/**
 * A ticket satisfies the definition's own composition rules.
 *
 * `open()` and `restore()` share one rule set precisely so this can be checked
 * once and hold at both boundaries. The conforming ticket must pass and each
 * malformed variant must be refused with a reason a host can branch on.
 */
const ticketIsWellFormed: Check = {
  code: 'CARDS_TICKET_WELL_FORMED',
  description:
    'A ticket clears the declared stake lattice, backing width and backed-market rule at both boundaries',
  scope: 'round',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    const refuse = (message: string, path: string, reason: CardsRejectionReason): never => {
      throw new RevealEngineError('CLAIM_REJECTED', message, path, { reason });
    };
    const rows = conformanceTicket(definition);
    count('ticketCompositions');
    try {
      assertTicketComposition(definition, rows, refuse);
    } catch (error) {
      failures.push(
        failure(
          'CARDS_TICKET_WELL_FORMED',
          '$.selections',
          `The conformance ticket does not clear its own rules: ${String(error)}`,
        ),
      );
    }
    const step = definition.pricing.stakeStepCredits;
    const minimum = definition.pricing.minStakeCredits;
    const variants: readonly [string, readonly TicketSelection[]][] = [
      ['an empty ticket', []],
      [
        'a stake below the declared minimum',
        rows.map((row, index) => (index === 0 ? { ...row, stake: minimum - step } : row)),
      ],
      [
        'a stake off the declared lattice',
        rows.map((row, index) => (index === 0 ? { ...row, stake: minimum + 1n } : row)),
      ],
      ['a ticket with no backed position', rows.filter((row) => row.kind !== 'position')],
      ['a ticket that repeats a selection id', rows.map((row) => ({ ...row, id: 'same' }))],
    ];
    for (const [label, variant] of variants) {
      count('ticketRefusals');
      try {
        assertTicketComposition(definition, variant, refuse);
        failures.push(failure('CARDS_TICKET_WELL_FORMED', '$.selections', `${label} was accepted`));
      } catch {
        // Expected: the ticket is not one this definition can price.
      }
    }
    return failures;
  },
};

/** A definition-scoped tape, so a rule-aware check can convert without a round. */
function probeTape(definition: SequentialCardsDefinition): CreditTape | undefined {
  if (definition.pricing.rounding !== 'stochastic') return undefined;
  const roundId = 'conformance-rounding';
  return {
    roundingSeed: deriveRoundingSeed(`${'0'.repeat(63)}1`, cardsFingerprint(definition), roundId),
    round: cardsRoundOf(definition, roundId),
  };
}

/** Every reachable payout multiple at every probe stake, as an exact claim. */
function* roundingProbeClaims(
  definition: SequentialCardsDefinition,
): Generator<{ readonly stake: bigint; readonly claim: Rational }, void, void> {
  const analysis = analyseDefinition(definition);
  const step = definition.pricing.stakeStepCredits;
  for (const multiple of [analysis.maxPayoutMultiple, analysis.minPositivePayoutMultiple])
    for (let index = 0n; index < 8n; index += 1n) {
      const stake = definition.pricing.minStakeCredits + index * step;
      yield { stake, claim: multiply(rational(stake), multiple) };
    }
}

/**
 * The credited integer is never below the whole part of the claim.
 *
 * It is a property of the **conversion**, not a promise that a control pays: an
 * outcome that does not settle credits nothing. What it does mean is that when a
 * claim settles, the whole part a player was shown is a floor on the credit —
 * under `'floor'` because that is what flooring is, and under `'stochastic'`
 * because the draw pays `q` or `q + 1` and never `q − 1`. `triad/docs/MATH.md`
 * §13.3 property 2 states exactly that, and it is what makes the integer on a
 * control a floor on the credit rather than an estimate of it.
 */
const roundingNeverUnderpays: Check = {
  code: 'CARDS_ROUNDING_NEVER_UNDERPAYS',
  description: 'The credited integer is the whole part of the claim, or one credit above it',
  scope: 'definition',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    const tape = probeTape(definition);
    const stochastic = definition.pricing.rounding === 'stochastic';
    const probe = (id: string, stake: bigint, claim: Rational): CardsSelection =>
      Object.freeze({
        id,
        kind: 'position' as const,
        marketId: null,
        openedPosition: 0,
        positions: Object.freeze([0]),
        stake,
        claim,
        decidedAtStepRevision: 0,
        status: 'live' as const,
        credited: 0n,
      });
    for (const { stake, claim } of roundingProbeClaims(definition)) {
      count('roundingProbes');
      const whole = floorRational(claim);
      const event = { tape, sequence: 7 };
      const credited = settlementTotal(definition, [probe('one', stake, claim)], 0, 0, event);
      const bonus = convertToCredits(
        definition,
        claim,
        { selectionId: 'one', sequence: 7 },
        tape,
      ).credits;
      if (credited.denominator !== 1n || credited.numerator !== bonus)
        failures.push(
          failure(
            'CARDS_ROUNDING_NEVER_UNDERPAYS',
            '$.pricing.rounding',
            `A settled claim of ${claim.numerator}/${claim.denominator} credited ${credited.numerator}/${credited.denominator}, not the ${bonus} its declared rounding rule converts it to`,
          ),
        );
      // Never below the whole part, and never more than one credit above it.
      if (credited.numerator < whole || credited.numerator > whole + (stochastic ? 1n : 0n))
        failures.push(
          failure(
            'CARDS_ROUNDING_NEVER_UNDERPAYS',
            '$.pricing.rounding',
            `${credited.numerator} is not the whole part of ${claim.numerator}/${claim.denominator}, nor one credit above it`,
          ),
        );
      // The whole part is a floor, never a rounding: it is at most the exact
      // claim and never more than one credit short of it.
      if (compare(rational(whole), claim) > 0 || compare(rational(whole + 1n), claim) <= 0)
        failures.push(
          failure(
            'CARDS_ROUNDING_NEVER_UNDERPAYS',
            '$.pricing.rounding',
            `${whole} is not the whole part of ${claim.numerator}/${claim.denominator}`,
          ),
        );
      // The part that is not a tautology, and the defect ADR 0005 Decision 6
      // records: two winning selections must credit the sum of their **own**
      // conversions, never the conversion of their sum. Aggregating first lets
      // one selection's fractional part finance another's, so settling two rows
      // together would pay a credit that cashing them one at a time does not —
      // and under the draw each row must get its own draw, under its own id,
      // rather than one draw applied twice.
      const together = settlementTotal(
        definition,
        [probe('one', stake, claim), probe('two', stake, claim)],
        0,
        0,
        event,
      );
      const separately =
        bonus +
        convertToCredits(definition, claim, { selectionId: 'two', sequence: 7 }, tape).credits;
      count('roundingPairProbes');
      if (together.denominator !== 1n || together.numerator !== separately)
        failures.push(
          failure(
            'CARDS_ROUNDING_NEVER_UNDERPAYS',
            '$.pricing.rounding',
            `Two claims of ${claim.numerator}/${claim.denominator} credited ${together.numerator}/${together.denominator} together, not ${separately} — one row's remainder financed another's`,
          ),
        );
    }
    return failures;
  },
};

/**
 * The declared rounding rule's expected credit, computed exactly.
 *
 * `triad/docs/ENGINE.md` §5.6 asks for this by name under
 * `rounding: 'stochastic'`: `E[credits] = claim` exactly, for every reachable
 * payout at every stake in the ladder. The evidence is a **count over the whole
 * draw space**, not a restatement of the comparison the conversion performs:
 * for each probe claim `q + r/d` this sweeps every `u` in `[0, d)` through
 * `creditsFromDraw` and requires that exactly `r` of them pay `q + 1`. A
 * conversion that used `<=`, or compared against `d − r`, or drew against the
 * wrong denominator, changes that count and fails here.
 *
 * With the count at `r` and the draw uniform on `[0, d)` — `uniformBigInt`'s
 * own property, covered by core's tests — the expectation is
 * `q·(d−r)/d + (q+1)·r/d = q + r/d`, the claim itself. Under `'floor'` the same
 * sweep establishes the other exact statement: the expected credit is `q` and
 * the bias is exactly `−r/d`, which is why that rule needs a minimum stake and
 * this one does not.
 */
const roundingIsUnbiased: Check = {
  code: 'CARDS_ROUNDING_UNBIASED',
  description:
    "Expected credits equal the claim exactly under 'stochastic', and the whole part under 'floor'",
  scope: 'definition',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    const stochastic = definition.pricing.rounding === 'stochastic';
    const tape = probeTape(definition);
    const sweep = (claim: Rational): void => {
      const whole = floorRational(claim);
      const remainder = claim.numerator - whole * claim.denominator;
      const denominator = claim.denominator;
      count('roundingDrawSweeps');
      // The conversion the round would really perform on this claim, decomposed.
      // Every branch below is about `credits`, so the decomposition it is
      // measured against has to come from the conversion rather than from this
      // check computing the same thing a second time and agreeing with itself.
      const conversion = convertToCredits(
        definition,
        claim,
        { selectionId: 'sweep', sequence: 0 },
        tape,
      );
      if (
        conversion.whole !== whole ||
        conversion.remainder !== remainder ||
        conversion.denominator !== denominator
      )
        failures.push(
          failure(
            'CARDS_ROUNDING_UNBIASED',
            '$.pricing.rounding',
            `The conversion of ${claim.numerator}/${claim.denominator} decomposes as ${conversion.whole} + ${conversion.remainder}/${conversion.denominator}`,
          ),
        );
      if (!stochastic) {
        // A deterministic rule takes no draw at all, and that is the property:
        // a `'floor'` definition that silently drew would be paying an
        // economics its fingerprint does not describe.
        count('roundingDraws');
        if (conversion.draw !== null || conversion.credits !== whole)
          failures.push(
            failure(
              'CARDS_ROUNDING_UNBIASED',
              '$.pricing.rounding',
              `Flooring ${claim.numerator}/${claim.denominator} credited ${conversion.credits} with draw ${String(conversion.draw)}`,
            ),
          );
        if (whole * denominator + remainder !== claim.numerator)
          failures.push(
            failure(
              'CARDS_ROUNDING_UNBIASED',
              '$.pricing.rounding',
              `Flooring ${claim.numerator}/${denominator} loses ${remainder}/${denominator}, which is not what its decomposition says`,
            ),
          );
        return;
      }
      // The realised conversion has to be the same function of its own draw as
      // the sweep below walks, or the sweep would be measuring something the
      // round never runs.
      if (
        conversion.draw !== null &&
        conversion.credits !== creditsFromDraw(claim, conversion.draw)
      )
        failures.push(
          failure(
            'CARDS_ROUNDING_UNBIASED',
            '$.pricing.rounding',
            `The realised draw ${conversion.draw} credited ${conversion.credits} rather than ${creditsFromDraw(claim, conversion.draw)}`,
          ),
        );
      if (conversion.draw === null && remainder !== 0n)
        failures.push(
          failure(
            'CARDS_ROUNDING_UNBIASED',
            '$.pricing.rounding',
            `A claim of ${claim.numerator}/${denominator} has a fractional part and took no draw`,
          ),
        );
      let paysExtra = 0n;
      for (let draw = 0n; draw < denominator; draw += 1n) {
        count('roundingDraws');
        const credits = creditsFromDraw(claim, draw);
        if (credits === whole + 1n) paysExtra += 1n;
        else if (credits !== whole) {
          failures.push(
            failure(
              'CARDS_ROUNDING_UNBIASED',
              '$.pricing.rounding',
              `Draw ${draw} on ${claim.numerator}/${claim.denominator} credited ${credits}, which is neither ${whole} nor ${whole + 1n}`,
            ),
          );
          return;
        }
      }
      if (paysExtra !== remainder)
        failures.push(
          failure(
            'CARDS_ROUNDING_UNBIASED',
            '$.pricing.rounding',
            `${paysExtra} of ${denominator} draws pay the extra credit on ${claim.numerator}/${claim.denominator}; an unbiased rule pays it on ${remainder}`,
          ),
        );
      // E[credits] · d = q·(d − paysExtra) + (q+1)·paysExtra, which must be the
      // claim's own numerator over the same denominator: bias exactly zero.
      if (whole * denominator + paysExtra !== claim.numerator)
        failures.push(
          failure(
            'CARDS_ROUNDING_UNBIASED',
            '$.pricing.rounding',
            `Expected credits of ${whole * denominator + paysExtra}/${denominator} are not the claim ${claim.numerator}/${denominator}`,
          ),
        );
    };

    // A definition's own reachable payouts are what the specification asks
    // about, and on a real paytable they cluster: `triad-middle-v1`'s extremes
    // reduce to denominators 1 and 11, so sweeping only those would leave the
    // conversion tested over two shapes. The synthetic lattice below sweeps
    // every `(whole, remainder, denominator)` up to 64 as well — 2,080 claims,
    // every draw of each — so the count is held to the remainder across the
    // whole small-denominator space rather than at the two points a paytable
    // happens to reach.
    for (let denominator = 1n; denominator <= 64n; denominator += 1n)
      for (let remainder = 0n; remainder < denominator; remainder += 1n)
        sweep(rational(7n * denominator + remainder, denominator));

    for (const { claim } of roundingProbeClaims(definition)) {
      // Above this the claim is reported rather than sampled, because a partial
      // sweep presented as a full one is the overclaim these checks exist to
      // avoid. Every reachable payout of every shipped reference is far inside.
      if (claim.denominator > 100_000n) {
        failures.push(
          failure(
            'CARDS_ROUNDING_UNBIASED',
            '$.pricing.rounding',
            `A reachable payout has denominator ${claim.denominator}, above the ${100_000n} this check can sweep exhaustively`,
          ),
        );
        continue;
      }
      sweep(claim);
    }
    return failures;
  },
};

/**
 * The extremal realised **credit** return, and what bounds it.
 *
 * `CARDS_POLICY_RETURN_EXTREMAL` settles the exact-rational return over the
 * whole policy space. This is the other half of the same question, the one
 * `triad/docs/ENGINE.md` §5.6 asks: what a player is actually credited. The two
 * are joined by the conversion, and the join is different under each rule.
 *
 * Under `'stochastic'` the conversion is unbiased at every credit event
 * (`CARDS_ROUNDING_UNBIASED` counts it), expectation is linear over the round
 * tree, and the argmin and argmax of the exact return coincide at `entryRtp` —
 * so the extremal realised credit return **is** `entryRtp`, exactly, at every
 * stake. That is asserted here as the conjunction it is.
 *
 * Under `'floor'` the join is an inequality rather than an identity: each credit
 * event loses strictly less than one credit, so a policy taking `k` of them
 * realises more than `exact − k/stake` and at most `exact`. That bound is what
 * the minimum stake is for, and it is checked at the minimum stake because that
 * is where it is loosest.
 */
const roundingIsBounded: Check = {
  code: 'CARDS_ROUNDING_BOUNDED',
  description:
    "The extremal realised credit return equals entryRtp exactly under 'stochastic', and is within one credit per credit event under 'floor'",
  scope: 'definition',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    const analysis = analyseDefinition(definition);
    const stochastic = definition.pricing.rounding === 'stochastic';
    count('creditReturnBounds');
    if (!rationalEqual(analysis.bestPolicyReturn, analysis.worstPolicyReturn))
      failures.push(
        failure(
          'CARDS_ROUNDING_BOUNDED',
          '$.pricing',
          'The exact extremal returns differ, so no statement about credits can be made from them',
        ),
      );
    else if (!rationalEqual(analysis.bestPolicyReturn, definition.pricing.entryRtp))
      failures.push(
        failure(
          'CARDS_ROUNDING_BOUNDED',
          '$.pricing.entryRtp',
          `The exact extremal return is ${analysis.bestPolicyReturn.numerator}/${analysis.bestPolicyReturn.denominator}, not the declared ${definition.pricing.entryRtp.numerator}/${definition.pricing.entryRtp.denominator}`,
        ),
      );
    const tape = probeTape(definition);
    for (const { stake, claim } of roundingProbeClaims(definition)) {
      count('creditReturnProbes');
      const credits = convertToCredits(
        definition,
        claim,
        { selectionId: 'one', sequence: 3 },
        tape,
      );
      const credited = rational(credits.credits);
      // Under either rule the credited integer is inside one credit of the
      // claim, so no policy's realised return can leave that band.
      if (compare(credited, claim) > 0 && !stochastic)
        failures.push(
          failure(
            'CARDS_ROUNDING_BOUNDED',
            '$.pricing.rounding',
            `Flooring ${claim.numerator}/${claim.denominator} credited ${credits.credits}, above the claim`,
          ),
        );
      if (
        compare(credited, add(claim, rational(1n))) >= 0 ||
        compare(add(credited, rational(1n)), claim) <= 0
      )
        failures.push(
          failure(
            'CARDS_ROUNDING_BOUNDED',
            '$.pricing.rounding',
            `A credit of ${credits.credits} is more than one credit away from ${claim.numerator}/${claim.denominator} at stake ${stake}`,
          ),
        );
      // The unbiased rule's statement is an identity, and it is the one the
      // consuming specification asks to be exact: expected credits are the claim.
      if (stochastic && credits.whole * credits.denominator + credits.remainder !== claim.numerator)
        failures.push(
          failure(
            'CARDS_ROUNDING_BOUNDED',
            '$.pricing.rounding',
            `The conversion of ${claim.numerator}/${claim.denominator} does not decompose into a whole part and a remainder`,
          ),
        );
    }
    return failures;
  },
};

interface WireEntry {
  readonly fingerprint: string;
  readonly receipt: Record<string, unknown>;
}

/**
 * The reveal receipt, re-fenced one revision forward and re-fingerprinted.
 *
 * Every other tamper in the table rewrites a **value** — a stake, a claim, a
 * rank, the checksum — and the receipt algebra alone catches all of them. This
 * one rewrites a **pairing**: the receipt is minted over the digest of the frame
 * it claims, so it is internally impeccable, and the only thing wrong with it is
 * that no command was ever standing at that revision when it ran. That is the
 * shape a forged liquidation needs, so the table has to contain it.
 */
function refenceReveal(staked: CardsBookSnapshot): WireEntry {
  const steps = staked.steps as unknown as RevealStep[];
  const frame = steps.length;
  const fingerprint = commandFingerprint('reveal', [
    stepDigest(steps.slice(0, frame)),
    ...encodeRevealStep(steps[0] as RevealStep),
  ]);
  const entry = (staked.receipts as unknown as WireEntry[]).find(
    (candidate) => candidate.receipt.action === 'reveal',
  ) as WireEntry;
  return {
    fingerprint,
    receipt: { ...entry.receipt, commandFingerprint: fingerprint, frameRevision: frame },
  };
}

/**
 * A liquidation appended to a snapshot, priced at the belief its frame implies.
 *
 * One builder produces both the legal case and the illegal ones, which is the
 * point: the credited integer, the `capped` flag, the liquid balance and the
 * selection's own record are re-derived from the frame every time, so the only
 * thing that separates the snapshot that must restore from the ones that must
 * not is whether a round could have issued the command.
 */
function forgeCash(
  definition: SequentialCardsDefinition,
  staked: CardsBookSnapshot,
  selectionId: string,
  frame: number,
  reseal: (value: Record<string, unknown>) => string,
): string {
  const rows = staked.selections as unknown as Record<string, unknown>[];
  const row = rows.find((candidate) => candidate.id === selectionId) as Record<string, unknown>;
  const wire = row.claim as { numerator: string; denominator: string };
  const steps = (staked.steps as unknown as RevealStep[]).slice(0, frame);
  const belief = cardsBelief(definition, steps);
  const value = fairValue(
    definition,
    rational(BigInt(wire.numerator), BigInt(wire.denominator)),
    coverProbability(belief, row.positions as number[]),
  );
  const liquid = BigInt(staked.liquidBalance);
  const sequence = staked.receipts.length + 1;
  const payable = payableWithinCap(
    rational(
      convertToCredits(definition, value, { selectionId, sequence }, tapeOf(definition, staked))
        .credits,
    ),
    BigInt(staked.capBasisStake as string),
    definition.risk.maxWinMultiple,
    liquid,
  );
  const fingerprint = commandFingerprint('cash', [stepDigest(steps), selectionId]);
  const receipts = [
    ...(staked.receipts as unknown as WireEntry[]),
    {
      fingerprint,
      receipt: toWireReceipt({
        schema: RECEIPT_SCHEMA,
        idempotencyKey: 'conformance-cash',
        commandFingerprint: fingerprint,
        action: 'cash',
        ledgerRevision: staked.receipts.length + 1,
        frameRevision: frame,
        debited: 0n,
        credited: payable.credited,
        balanceDelta: payable.credited,
        capped: payable.capped,
      }),
    },
  ];
  return reseal({
    ...staked,
    receipts,
    ledgerRevision: receipts.length,
    liquidBalance: String(liquid + payable.credited),
    selections: rows.map((candidate) =>
      candidate.id === selectionId
        ? {
            ...candidate,
            status: 'cashed',
            credited: String(payable.credited),
            decidedAtStepRevision: frame,
          }
        : candidate,
    ),
  });
}

/** The committed tape a snapshot's round credits from, if its definition declares one. */
function tapeOf(
  definition: SequentialCardsDefinition,
  staked: CardsBookSnapshot,
): CreditTape | undefined {
  const seed = staked.roundingSeed;
  if (typeof seed !== 'string' || staked.roundId === null) return undefined;
  return { roundingSeed: seed, round: cardsRoundOf(definition, staked.roundId) };
}

/** The first backed row of a snapshot's ticket; every reference opens one. */
function backedRowOf(staked: CardsBookSnapshot): Record<string, unknown> | undefined {
  return (staked.selections as unknown as Record<string, unknown>[]).find(
    (row) => row.kind === 'position',
  );
}

/**
 * Whether the state a staked snapshot stands in really offers a cash-out.
 *
 * The positive control needs it — a check that only ever forges is a check that
 * would still pass if `restore()` refused every liquidation ever written.
 */
function offersCashAt(
  definition: SequentialCardsDefinition,
  staked: CardsBookSnapshot,
  row: Record<string, unknown>,
): boolean {
  const belief = cardsBelief(definition, staked.steps as unknown as RevealStep[]);
  const excluded = new Set<number>();
  for (const other of staked.selections)
    if (other.id !== row.id) for (const position of other.positions) excluded.add(position);
  return offeredActions(definition, belief, row.positions as number[], {
    stepRevision: staked.stepRevision,
    excluded,
  }).includes('cash');
}

const snapshotIsRevalidated: Check = {
  code: 'CARDS_SNAPSHOT_NOT_REVALIDATED',
  description:
    'restore() round-trips its own snapshots and a legal cash-out, and rejects re-sealed tampered ones',
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
    const backed = backedRowOf(staked);
    const market = (staked.selections as unknown as Record<string, unknown>[]).find(
      (row) => row.kind === 'market',
    );

    // The positive control for the whole liquidation half of this check. The
    // same builder that writes the forgeries below writes this one, so a
    // `restore()` that refused every cash-out ever minted would fail here rather
    // than pass the table by being uniformly suspicious.
    if (backed !== undefined && offersCashAt(definition, staked, backed)) {
      count('snapshots');
      const honest = forgeCash(
        definition,
        staked,
        backed.id as string,
        staked.stepRevision,
        reseal,
      );
      try {
        const restored = CardsBook.restore(definition, honest);
        if (JSON.stringify(restored.snapshot()) !== honest)
          reject('A restored cash-out does not re-serialize identically');
        if (restored.liquidBalance <= 0n)
          reject('A restored cash-out credited nothing at the declared minimum stake');
      } catch (error) {
        reject(`Restore rejected a legal cash-out: ${String(error)}`);
      }
    }

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
      // A receipt re-fenced to a revision the round was not standing at, with
      // its fingerprint recomputed over the digest of that frame so the receipt
      // algebra has nothing to object to. Every case above is a rewritten
      // *value*; this is a rewritten *pairing*, and a pairing is what turns an
      // honest claim into a credit no reachable state produces.
      reseal({
        ...staked,
        receipts: (staked.receipts as unknown as WireEntry[]).map((entry) =>
          entry.receipt.action === 'reveal' ? refenceReveal(staked) : entry,
        ),
      }),
      // The liquidation branch, which is the only one that carries money out.
      // A cash fenced back to the pre-reveal belief prices a claim the reveal
      // already grew at the belief that existed before it: every receipt
      // re-derives, and the state is one no command sequence reaches.
      ...(backed === undefined
        ? []
        : [forgeCash(definition, staked, backed.id as string, 0, reseal)]),
      // A side market settles from the deal and has no in-round action at all,
      // so its liquidation credits exactly zero and only the rule refuses it.
      ...(market === undefined
        ? []
        : [forgeCash(definition, staked, market.id as string, staked.stepRevision, reseal)]),
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
  identicalActionsAreEnumerated,
  policyReturnIsExtremal,
  marketsAreReachable,
  minStakeIsSufficient,
  roundingNeverUnderpays,
  roundingIsUnbiased,
  roundingIsBounded,
  capNeverBinds,
  beliefIsExhaustive,
  beliefIsNormalised,
  selectorIsPrecommitted,
  revealIsDeterministic,
  revealIsChoiceBound,
  backingStaysSingle,
  ticketIsWellFormed,
  seedMixesClientEntropy,
  snapshotIsRevalidated,
]);
