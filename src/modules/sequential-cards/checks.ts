import { RevealEngineError } from '../../api/errors.js';
import { RECEIPT_SCHEMA, commandFingerprint, toWireReceipt } from '../../core/ledger.js';
import type { ConformanceFailure, ModuleConformanceCheck } from '../../core/module.js';
import {
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
import {
  coverProbability,
  entryMultiplier,
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

/**
 * The credited integer is never below the whole part of the claim.
 *
 * It is a property of the **conversion**, not a promise that a control pays: an
 * outcome that does not settle credits nothing. What it does mean is that when a
 * claim settles, the whole part a player was shown is a floor on the credit — so
 * `settlementTotal` must agree with `floor` on every reachable payout at every
 * stake on the lattice, and must never be more than one credit short of the
 * exact rational.
 */
const roundingNeverUnderpays: Check = {
  code: 'CARDS_ROUNDING_NEVER_UNDERPAYS',
  description: 'The credited integer equals the whole part of the claim on every reachable payout',
  scope: 'definition',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    const analysis = analyseDefinition(definition);
    const step = definition.pricing.stakeStepCredits;
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
    for (const multiple of [analysis.maxPayoutMultiple, analysis.minPositivePayoutMultiple])
      for (let index = 0n; index < 8n; index += 1n) {
        count('roundingProbes');
        const stake = definition.pricing.minStakeCredits + index * step;
        const claim = multiply(rational(stake), multiple);
        const whole = floorRational(claim);
        const credited = settlementTotal(definition, [probe('one', stake, claim)], 0, 0);
        if (credited.denominator !== 1n || credited.numerator !== whole)
          failures.push(
            failure(
              'CARDS_ROUNDING_NEVER_UNDERPAYS',
              '$.pricing.rounding',
              `A settled claim of ${claim.numerator}/${claim.denominator} credited ${credited.numerator}/${credited.denominator}, not its whole part ${whole}`,
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
        // records: two winning selections must credit the sum of their own
        // floors, never the floor of their sum. Flooring the aggregate lets one
        // selection's fractional part finance another's, so settling two rows
        // together would pay a credit that cashing them one at a time does not.
        const together = settlementTotal(
          definition,
          [probe('one', stake, claim), probe('two', stake, claim)],
          0,
          0,
        );
        count('roundingPairProbes');
        if (together.denominator !== 1n || together.numerator !== whole * 2n)
          failures.push(
            failure(
              'CARDS_ROUNDING_NEVER_UNDERPAYS',
              '$.pricing.rounding',
              `Two claims of ${claim.numerator}/${claim.denominator} credited ${together.numerator}/${together.denominator} together, not ${whole * 2n} — one row's remainder financed another's`,
            ),
          );
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
  identicalActionsAreEnumerated,
  policyReturnIsExtremal,
  marketsAreReachable,
  minStakeIsSufficient,
  roundingNeverUnderpays,
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
