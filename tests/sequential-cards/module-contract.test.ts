import { describe, expect, it } from 'vitest';
import { RevealEngineError } from '../../src/api/errors.js';
import { ENGINE_LIMITS } from '../../src/api/limits.js';
import {
  assertModuleConformance,
  checkModuleConformance,
} from '../../src/conformance/module-conformance.js';
import { sealCommitment, sealSeedCommitment } from '../../src/core/commitment.js';
import { defineLifecycleModule } from '../../src/core/module.js';
import { rational } from '../../src/core/rational.js';
import { COMMITMENT_VERSION, MODULE_API_VERSION } from '../../src/core/versions.js';
import { encodeFields, type CanonicalField } from '../../src/internal/canonical.js';
import { findModule, listModules, requireModule } from '../../src/modules/index.js';
import {
  cardsFingerprint,
  cardsRoundOf,
  defineCardsGame,
} from '../../src/modules/sequential-cards/adapter.js';
import {
  CARDS_MAX_ANALYSIS_OPS,
  estimateAnalysisWork,
} from '../../src/modules/sequential-cards/analysis.js';
import { stakedCardsSnapshot } from '../../src/modules/sequential-cards/checks.js';
import type { SequentialCardsDefinition } from '../../src/modules/sequential-cards/contracts.js';
import { cardsBelief, reachableObjectiveRanks } from '../../src/modules/sequential-cards/deck.js';
import { sequentialCards } from '../../src/modules/sequential-cards/module.js';
import {
  cascadeMiddleReference,
  duoMiddleReference,
  triadMiddleReference,
} from '../../src/modules/sequential-cards/references.js';
import { CardsBook } from '../../src/modules/sequential-cards/round-book.js';
import { deriveRevealSteps } from '../../src/modules/sequential-cards/steps.js';
import {
  buildCardsTranscript,
  cardsCommitmentBody,
  cardsSeedCommitment,
  cardsTranscriptToWire,
} from '../../src/modules/sequential-cards/transcript.js';
import { deriveDeal } from '../../src/modules/sequential-cards/truth.js';
import { seed } from '../helpers.js';

const definition = triadMiddleReference;
const choices = [{ index: 0, kind: 'back' as const, position: 1 }];

describe('sequential-cards: the lifecycle contract', () => {
  it('registers as a module and declares the shape a host branches on', () => {
    expect(listModules().map((module) => module.id)).toContain('sequential-cards');
    expect(findModule('sequential-cards')).toBe(sequentialCards);
    expect(requireModule('sequential-cards').moduleApiVersion).toBe(MODULE_API_VERSION);
    expect(sequentialCards.truth.kind).toBe('vector');
    expect(sequentialCards.steps.choiceTiming).toBe('before-step');
    expect(sequentialCards.steps.beliefSpace).toBe('marginal');
    expect(sequentialCards.book.positions).toBe('multi');
    expect(sequentialCards.book.settlement).toBe('paytable');
    expect(sequentialCards.book.maxOpenClaims).toBeGreaterThan(1);
    expect(sequentialCards.book.actions).toEqual([
      'open',
      'reveal',
      'switch',
      'split',
      'cash',
      'settle',
    ]);
    expect(sequentialCards.transcript.schema).toBe('reveal-engine/cards-transcript-v1');
    expect(sequentialCards.book.snapshotSchema).toBe('reveal-engine/cards-book-v1');
    expect(sequentialCards.steps.maxSteps).toBe(8);
    expect(Object.isFrozen(sequentialCards)).toBe(true);
    // A choice-timed module must publish both a seed pre-commitment and its log.
    expect(typeof sequentialCards.transcript.seedCommitment).toBe('function');
    expect(typeof sequentialCards.transcript.choicesOf).toBe('function');
    // A marginal belief space prices through price(), and still exposes the
    // elimination view because a board of `dealt` positions fits a flat vector.
    expect(typeof sequentialCards.steps.price).toBe('function');
    expect(typeof sequentialCards.steps.belief).toBe('function');
  });

  it('routes every declared hook to the module implementation', () => {
    const roundId = 'contract-round';
    const identity = sequentialCards.definitions.identity(definition);
    expect(identity).toMatchObject({
      moduleId: 'sequential-cards',
      moduleVersion: '1.0.0',
      definitionId: definition.id,
      definitionVersion: definition.version,
    });
    expect(identity.fingerprint).toBe(cardsFingerprint(definition));

    const round = cardsRoundOf(definition, roundId);
    const truth = sequentialCards.truth.derive(seed(5), definition, roundId);
    const steps = sequentialCards.steps.derive(seed(5), definition, round, truth, choices);
    expect(steps).toHaveLength(sequentialCards.steps.count(definition));
    expect(truth.ranks).toHaveLength(definition.ladder.dealt);
    expect(new Set(truth.ranks).size).toBe(definition.ladder.dealt);

    const transcript = sequentialCards.transcript.build(seed(5), definition, roundId, choices);
    expect(sequentialCards.truth.equal(transcript.deal, truth)).toBe(true);
    expect(sequentialCards.steps.equal(transcript.steps, steps)).toBe(true);
    expect(transcript.commitment).toBe(
      sealCommitment(
        seed(5),
        sequentialCards.transcript.commitmentBody(definition, round, truth, steps, choices),
      ),
    );
    expect(sequentialCards.verify(seed(5), definition, transcript).ok).toBe(true);
    expect(
      sequentialCards.transcript.fromWire(sequentialCards.transcript.toWire(transcript)),
    ).toEqual(transcript);
    expect(sequentialCards.transcript.choicesOf?.(transcript)).toEqual(choices);

    const belief = sequentialCards.steps.belief?.(definition, steps);
    expect(belief?.total).toBe(belief?.weights.reduce((sum, weight) => sum + weight, 0n));
    // The truth space is small enough to sweep: 1,716 deals times 2 selectors.
    expect(sequentialCards.truth.enumerate?.(definition)).toHaveLength(13 * 12 * 11 * 2);
    expect(sequentialCards.truth.enumerate?.(duoMiddleReference)).toBeUndefined();
  });

  /**
   * `encode()` is documented as the fields that bind the truth into the
   * commitment body, and core cannot enforce that: it seals whatever bytes the
   * body returns. So the guarantee has to come from the module writing the
   * layout once — and this rebuilds the sealed body out of nothing but the
   * module's public declarations.
   */
  it('composes the commitment body out of the encoders it declares', () => {
    const roundId = 'encode-round';
    const round = cardsRoundOf(definition, roundId);
    const truth = sequentialCards.truth.derive(seed(6), definition, roundId);
    const steps = sequentialCards.steps.derive(seed(6), definition, round, truth, choices);
    const bodyFrom = (
      encodeTruth: (value: typeof truth) => readonly CanonicalField[],
      encodeStep: (value: (typeof steps)[number]) => readonly CanonicalField[],
    ): Buffer =>
      encodeFields([
        'Axiom Games sequential-cards commitment',
        COMMITMENT_VERSION,
        round.moduleId,
        definition.id,
        definition.version,
        cardsFingerprint(definition),
        roundId,
        round.proofVersion,
        ...encodeTruth(truth),
        choices.length,
        ...choices.flatMap((choice) => [choice.index, choice.kind, choice.position]),
        steps.length,
        ...steps.flatMap((step) => [...encodeStep(step)]),
      ]);
    const sealed = sequentialCards.transcript.commitmentBody(
      definition,
      round,
      truth,
      steps,
      choices,
    );
    expect(
      Buffer.compare(sealed, bodyFrom(sequentialCards.truth.encode, sequentialCards.steps.encode)),
    ).toBe(0);
    // Drop a field from either declared encoder and the body stops matching,
    // which is the drift this composition exists to make impossible.
    expect(
      Buffer.compare(
        sealed,
        bodyFrom(() => [], sequentialCards.steps.encode),
      ),
    ).not.toBe(0);
    expect(
      Buffer.compare(
        sealed,
        bodyFrom(sequentialCards.truth.encode, (step) => [step.index, step.position]),
      ),
    ).not.toBe(0);
  });

  it('binds the choice log, so one seal fits exactly one decision sequence', () => {
    const roundId = 'choice-binding';
    const round = cardsRoundOf(definition, roundId);
    const truth = sequentialCards.truth.derive(seed(7), definition, roundId);
    const other = [{ index: 0, kind: 'back' as const, position: 2 }];
    const stepsA = deriveRevealSteps(definition, truth, choices);
    const stepsB = deriveRevealSteps(definition, truth, other);
    const sealA = sealCommitment(
      seed(7),
      cardsCommitmentBody(definition, round, truth, stepsA, choices),
    );
    const sealB = sealCommitment(
      seed(7),
      cardsCommitmentBody(definition, round, truth, stepsB, other),
    );
    expect(sealA).not.toBe(sealB);
    // And the same choice log against a different truth is a different seal too.
    expect(
      sealCommitment(
        seed(8),
        cardsCommitmentBody(
          definition,
          round,
          sequentialCards.truth.derive(seed(8), definition, roundId),
          stepsA,
          choices,
        ),
      ),
    ).not.toBe(sealA);
  });

  it('publishes a seed pre-commitment that covers the window before the first decision', () => {
    const roundId = 'precommit-round';
    const round = cardsRoundOf(definition, roundId);
    const published = cardsSeedCommitment(seed(9), definition, round);
    expect(published).toBe(
      sealSeedCommitment(seed(9), {
        moduleId: 'sequential-cards',
        definitionId: definition.id,
        definitionFingerprint: cardsFingerprint(definition),
        roundId,
        proofVersion: COMMITMENT_VERSION,
      }),
    );
    // It reveals nothing and it is seed-specific and economics-specific.
    expect(cardsSeedCommitment(seed(10), definition, round)).not.toBe(published);
    const transcript = buildCardsTranscript(seed(9), definition, roundId, choices);
    expect(transcript.seedCommitment).toBe(published);
    expect(
      sequentialCards.verify(seed(9), definition, {
        ...cardsTranscriptToWire(transcript),
        seedCommitment: '0'.repeat(64),
      }),
    ).toMatchObject({ ok: false, code: 'COMMITMENT_MISMATCH', path: '$.seedCommitment' });
  });

  it('verifies by pure re-derivation and classifies every failure', () => {
    const roundId = 'verify-round';
    const wire = cardsTranscriptToWire(
      buildCardsTranscript(seed(11), definition, roundId, choices),
    );
    expect(sequentialCards.verify(seed(11), definition, wire).ok).toBe(true);
    expect(sequentialCards.verify(seed(12), definition, wire)).toMatchObject({ ok: false });
    expect(
      sequentialCards.verify(seed(11), definition, {
        ...wire,
        deal: { ranks: [...wire.deal.ranks].reverse(), selectors: [...wire.deal.selectors] },
      }),
    ).toMatchObject({ ok: false, code: 'TRANSCRIPT_MISMATCH' });
    expect(
      sequentialCards.verify(seed(11), definition, {
        ...wire,
        steps: wire.steps.map((step) => ({ ...step, rank: step.rank === 1 ? 2 : 1 })),
      }),
    ).toMatchObject({ ok: false });
    expect(sequentialCards.verify(seed(11), duoMiddleReference, wire)).toMatchObject({
      ok: false,
      code: 'DEFINITION_MISMATCH',
    });
    expect(sequentialCards.verify(seed(11), definition, { schema: 'other/v1' })).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_VERSION',
    });
    expect(sequentialCards.verify(seed(11), definition, null)).toMatchObject({
      ok: false,
      code: 'INVALID_TRANSCRIPT',
    });
    expect(
      sequentialCards.verify(seed(11), definition, { ...wire, commitment: '0'.repeat(64) }),
    ).toMatchObject({ ok: false, code: 'COMMITMENT_MISMATCH' });
  });

  it('holds derivation to the step budget the module declared', () => {
    const cramped = defineLifecycleModule({
      ...sequentialCards,
      steps: { ...sequentialCards.steps, maxSteps: 1 },
    } as never) as typeof sequentialCards;
    const roundId = 'budget';
    const round = cardsRoundOf(cascadeMiddleReference, roundId);
    const truth = cramped.truth.derive(seed(13), cascadeMiddleReference, roundId);
    expect(
      sequentialCards.steps.derive(seed(13), cascadeMiddleReference, round, truth, [
        { index: 0, kind: 'back', position: 0 },
      ]),
    ).toHaveLength(2);
    expect(() =>
      cramped.steps.derive(seed(13), cascadeMiddleReference, round, truth, [
        { index: 0, kind: 'back', position: 0 },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'DERIVATION_FAILED', path: '$.steps.maxSteps' }),
    );
  });

  const mutate = (
    patch: (draft: Record<string, unknown>) => void,
  ): (() => SequentialCardsDefinition) => {
    const draft = JSON.parse(
      JSON.stringify(definition, (_key, value) =>
        typeof value === 'bigint' ? { __bigint: String(value) } : value,
      ),
    ) as Record<string, unknown>;
    const revive = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(revive);
      if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (typeof record.__bigint === 'string') return BigInt(record.__bigint);
        return Object.fromEntries(
          Object.entries(record).map(([key, child]) => [key, revive(child)]),
        );
      }
      return value;
    };
    const restored = revive(draft) as Record<string, unknown>;
    patch(restored);
    return () => defineCardsGame(restored as unknown as SequentialCardsDefinition);
  };

  it.each([
    [
      'an even hand under a middle objective',
      (draft: Record<string, unknown>) => {
        (draft.ladder as Record<string, unknown>).dealt = 4;
      },
      'INVALID_LADDER',
    ],
    [
      'a reveal that leaves nothing hidden',
      (draft: Record<string, unknown>) => {
        (draft.reveal as Record<string, unknown>).count = 3;
      },
      'INVALID_REVEAL_SPEC',
    ],
    [
      'a backing width the hand cannot carry',
      (draft: Record<string, unknown>) => {
        (draft.backing as Record<string, unknown>).maxOpenBeforeReveal = 3;
      },
      'INVALID_REVEAL_SPEC',
    ],
    [
      'a market on a rank that can never be the middle',
      (draft: Record<string, unknown>) => {
        draft.sideMarkets = [{ id: 'EXACT:1', winningRanks: [1] }];
      },
      'INVALID_SIDE_MARKET',
    ],
    [
      'unsorted winning ranks',
      (draft: Record<string, unknown>) => {
        draft.sideMarkets = [{ id: 'BAND:BAD', winningRanks: [5, 3] }];
      },
      'INVALID_SIDE_MARKET',
    ],
    [
      'a minimum stake that lets a live claim credit zero',
      (draft: Record<string, unknown>) => {
        const pricing = draft.pricing as Record<string, unknown>;
        pricing.minStakeCredits = 5n;
        pricing.stakeStepCredits = 5n;
      },
      'STAKE_BELOW_MINIMUM',
    ],
    [
      'a cap a reachable payout would reach',
      (draft: Record<string, unknown>) => {
        (draft.risk as Record<string, unknown>).maxWinMultiple = 100n;
      },
      'CAP_WOULD_BIND',
    ],
    [
      'a rounding rule this version does not implement',
      (draft: Record<string, unknown>) => {
        (draft.pricing as Record<string, unknown>).rounding = 'stochastic';
      },
      'INVALID_ROUNDING_POLICY',
    ],
    [
      'a minimum stake off the step lattice',
      (draft: Record<string, unknown>) => {
        (draft.pricing as Record<string, unknown>).stakeStepCredits = 7n;
      },
      'INVALID_STAKE_LATTICE',
    ],
    [
      'a client seed too short to be entropy',
      (draft: Record<string, unknown>) => {
        (draft.seed as Record<string, unknown>).clientSeedBytes = 4;
      },
      'MISSING_CLIENT_ENTROPY',
    ],
    // A definition is a contract about how money moves, so a field the module
    // does not implement has to be refused rather than dropped: `freezeCards
    // Definition` rebuilds field by field and `cardsFingerprint` seals field by
    // field, so an unrecognised key would neither be honoured nor sealed, and
    // two definitions differing only in it would share a fingerprint.
    [
      'a dormancy policy the module has no clock to honour',
      (draft: Record<string, unknown>) => {
        draft.dormancy = {
          windowSeconds: 86_400,
          onDormant: 'cash',
          earlySettlementReasons: ['account-state-changed'],
        };
      },
      'UNDECLARED_FIELD',
    ],
    [
      'an unknown top-level field',
      (draft: Record<string, unknown>) => {
        draft.houseEdgeBoost = 3;
      },
      'UNDECLARED_FIELD',
    ],
    [
      'an unknown pricing field',
      (draft: Record<string, unknown>) => {
        (draft.pricing as Record<string, unknown>).jackpotShare = 1;
      },
      'UNDECLARED_FIELD',
    ],
    [
      'an unknown side-market field',
      (draft: Record<string, unknown>) => {
        draft.sideMarkets = [{ id: 'BAND:CORE', winningRanks: [6, 7, 8], boost: 2 }];
      },
      'UNDECLARED_FIELD',
    ],
  ])('refuses a definition with %s', (_label, patch, reason) => {
    expect(mutate(patch)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_ADAPTER',
        details: expect.objectContaining({ reason }),
      }),
    );
  });

  /**
   * The eligible set has to survive **every** reveal, not only the first.
   *
   * A width that is legal at reveal 0 can still empty the set by reveal 1, and
   * the selector for reveal 1 was sealed against a size the round no longer has.
   * That is a definition-time failure rather than an out-of-range index at
   * settlement time.
   */
  it('refuses a backing width that empties a later reveal', () => {
    expect(() =>
      defineCardsGame({
        ...cascadeMiddleReference,
        id: 'cascade-too-wide-v1',
        backing: { ...cascadeMiddleReference.backing, maxOpenBeforeReveal: 4 },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVALID_ADAPTER',
        details: expect.objectContaining({ reason: 'INVALID_REVEAL_SPEC' }),
      }),
    );
    // A width that leaves exactly one eligible card is legal: the cut becomes
    // deterministic, which is still independent of the ranks, so every posted
    // price stays defined. `duo-middle-v1` is the shape that uses the room.
    expect(() =>
      defineCardsGame({
        ...cascadeMiddleReference,
        id: 'cascade-narrow-v1',
        backing: { ...cascadeMiddleReference.backing, maxOpenBeforeReveal: 3 },
        risk: { ...cascadeMiddleReference.risk, capMustNotBind: false },
      }),
    ).not.toThrow();
  });

  /**
   * The two capabilities the consuming game's specification declares and this
   * version does not implement have to be refused **by name**, not dropped.
   *
   * `rounding: 'stochastic'` already was. `dormancy` was not: the assertion pass
   * ignored unknown keys and `freezeCardsDefinition` rebuilt the definition
   * field by field, so a declared dormancy policy vanished without a word and
   * never entered the fingerprint — the definition would run under a policy it
   * had never agreed to. `docs/modules/sequential-cards.md` §12 carries the
   * table of what a consumer declares that this version does not implement.
   */
  it("names each capability it does not implement when a consumer's definition declares one", () => {
    const consumerShaped = {
      ...definition,
      id: 'consumer-shaped-v1',
      dormancy: {
        windowSeconds: 86_400,
        onDormant: 'cash',
        earlySettlementReasons: ['account-state-changed'],
      },
    } as unknown as SequentialCardsDefinition;
    let refusal: unknown;
    try {
      defineCardsGame(consumerShaped);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(RevealEngineError);
    const error = refusal as RevealEngineError;
    expect(error.code).toBe('INVALID_ADAPTER');
    expect(error.path).toBe('$.dormancy');
    expect(error.details).toMatchObject({ reason: 'UNDECLARED_FIELD' });
    // The refusal says what is missing and why, so an integrator is not left
    // guessing whether the field was honoured.
    expect(error.message).toContain('dormancy');
    expect(error.message).toContain('owns no clock');
    // And nothing was silently kept: the accepted reference has no such field.
    expect('dormancy' in definition).toBe(false);
  });

  /**
   * The definition-time walk is bounded in **work**, not only in cells.
   *
   * `CARDS_MAX_ANALYSIS_CELLS` counts one cell per `(state, incoming cover)`
   * pair and the work inside one cell is `O(2^dealt)` — `splitSetsOf`
   * enumerates every subset of the live positions — so the cell budget alone
   * let a legal-shaped definition burn minutes of blocked event loop before
   * being refused. The estimate is closed from the declaration in BigInt and
   * refuses before the walk starts.
   */
  it('refuses an unprovable definition before the walk starts, not after it', () => {
    for (const reference of [triadMiddleReference, duoMiddleReference, cascadeMiddleReference])
      expect(estimateAnalysisWork(reference)).toBeLessThan(CARDS_MAX_ANALYSIS_OPS);

    const oversized = {
      ...definition,
      id: 'oversized-v1',
      ladder: { size: 18, dealt: 9, objective: 'middle' as const },
      reveal: { ...definition.reveal, count: 1 },
      sideMarkets: [{ id: 'EXACT:9', winningRanks: [9] }],
      risk: { maxWinMultiple: 1_000_000n, capMustNotBind: false },
      pricing: { ...definition.pricing, minStakeCredits: 1_000_000n, stakeStepCredits: 1_000_000n },
    } as unknown as SequentialCardsDefinition;
    expect(estimateAnalysisWork(oversized)).toBeGreaterThan(CARDS_MAX_ANALYSIS_OPS);

    const started = process.hrtime.bigint();
    expect(() => defineCardsGame(oversized)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_ADAPTER',
        details: expect.objectContaining({ reason: 'ANALYSIS_SPACE_TOO_LARGE' }),
      }),
    );
    // The same shape took 27 seconds to reach the cell budget. A generous
    // ceiling here still proves the refusal no longer walks anything.
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1_000);
  });

  it('accepts a definition whose numbers it can prove, and freezes it', () => {
    const rebuilt = defineCardsGame({ ...definition });
    expect(cardsFingerprint(rebuilt)).toBe(cardsFingerprint(definition));
    expect(Object.isFrozen(rebuilt.pricing)).toBe(true);
    expect(Object.isFrozen(rebuilt.sideMarkets[0]?.winningRanks)).toBe(true);
    // A different declarative field is a different adapter, never a shared seal.
    expect(
      cardsFingerprint(
        defineCardsGame({
          ...definition,
          version: '1.0.1',
          pricing: { ...definition.pricing, entryRtp: rational(95n, 100n) },
        }),
      ),
    ).not.toBe(cardsFingerprint(definition));
  });

  it('drives a whole round through the module book hooks alone', async () => {
    const roundId = 'hooked-round';
    const seedHex = seed(19);
    const book = sequentialCards.book.create(definition);
    await book.open({
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId,
      selections: [
        { id: 'M', kind: 'position', position: 1, stake: 25n },
        { id: 'B', kind: 'market', marketId: 'BAND:LOW', stake: 25n },
      ],
    });
    const transcript = sequentialCards.transcript.build(seedHex, definition, roundId, book.choices);
    for (const [index, step] of transcript.steps.entries())
      await book.advanceReveal({
        idempotencyKey: `reveal-${index}`,
        expectedStepRevision: index,
        step,
      });
    const receipt = await book.settle({
      idempotencyKey: 'settle',
      expectedStepRevision: transcript.steps.length,
      revealedSeed: seedHex,
      transcript,
    });
    expect(receipt.action).toBe('settle');
    expect(book.terminal).toBe(true);
    const snapshot = sequentialCards.book.snapshot(book);
    const restored = sequentialCards.book.restore(definition, snapshot);
    expect(sequentialCards.book.snapshot(restored)).toEqual(snapshot);
  });

  /**
   * The conformance snapshot is re-derived by hand because checks are
   * synchronous and the book's command API is not. This pins that
   * re-derivation against a snapshot from a real round, so a change to the
   * book's shape fails loudly rather than silently reducing every tamper case
   * in `CARDS_SNAPSHOT_NOT_REVALIDATED` to something restore would reject
   * anyway.
   */
  it('builds the conformance snapshot exactly as a real staked round would', async () => {
    for (const reference of [triadMiddleReference, duoMiddleReference, cascadeMiddleReference]) {
      const seedHex = seed(3);
      const roundId = 'conformance-3';
      const book = new CardsBook(reference);
      const stake = reference.pricing.minStakeCredits;
      const market = reference.sideMarkets[0];
      await book.open({
        idempotencyKey: 'conformance-open',
        expectedStepRevision: 0,
        roundId,
        selections: [
          ...Array.from(
            { length: reference.backing.maxOpenBeforeReveal },
            (_value, index) =>
              ({ id: `backed-${index}`, kind: 'position', position: index, stake }) as const,
          ),
          ...(market === undefined
            ? []
            : ([
                { id: `market-${market.id}`, kind: 'market', marketId: market.id, stake },
              ] as const)),
        ],
      });
      const deal = deriveDeal(seedHex, reference, roundId);
      const steps = deriveRevealSteps(reference, deal, book.choices);
      await book.advanceReveal({
        idempotencyKey: 'conformance-reveal',
        expectedStepRevision: 0,
        step: steps[0] as (typeof steps)[number],
      });
      expect(book.snapshot()).toEqual(stakedCardsSnapshot(reference, seedHex, roundId));
    }
  });

  it.each([triadMiddleReference, duoMiddleReference, cascadeMiddleReference])(
    'passes its own declared conformance checks for $id',
    (reference) => {
      const report = assertModuleConformance(sequentialCards, reference, 3);
      expect(report.ok).toBe(true);
      expect(report.moduleId).toBe('sequential-cards');
      expect(report.checks).toEqual([
        'CARDS_DEFINITION_NOT_FROZEN',
        'CARDS_ELIGIBLE_SET_NONEMPTY',
        'CARDS_TERMINAL_OFFERS_NOTHING',
        'CARDS_ACTIONS_VALUE_NEUTRAL',
        'CARDS_IDENTICAL_ACTIONS_ENUMERATED',
        'CARDS_POLICY_RETURN_EXTREMAL',
        'CARDS_MARKET_REACHABLE',
        'CARDS_MIN_STAKE_SUFFICIENT',
        'CARDS_ROUNDING_NEVER_UNDERPAYS',
        'CARDS_CAP_NEVER_BINDS',
        'CARDS_BELIEF_EXHAUSTIVE',
        'CARDS_BELIEF_NORMALISED',
        'CARDS_SELECTOR_PRECOMMITTED',
        'CARDS_REVEAL_DETERMINISTIC',
        'CARDS_REVEAL_CHOICE_BOUND',
        'CARDS_SINGLE_BACKED_POSITION',
        'CARDS_TICKET_WELL_FORMED',
        'CARDS_SEED_MIXES_CLIENT_ENTROPY',
        'CARDS_SNAPSHOT_NOT_REVALIDATED',
      ]);
      // `checks` lists what was declared; `ran` is what actually executed.
      expect(report.ran).toEqual({
        CARDS_DEFINITION_NOT_FROZEN: 1,
        CARDS_ELIGIBLE_SET_NONEMPTY: 1,
        CARDS_TERMINAL_OFFERS_NOTHING: 1,
        CARDS_ACTIONS_VALUE_NEUTRAL: 1,
        CARDS_IDENTICAL_ACTIONS_ENUMERATED: 1,
        CARDS_POLICY_RETURN_EXTREMAL: 1,
        CARDS_MARKET_REACHABLE: 1,
        CARDS_MIN_STAKE_SUFFICIENT: 1,
        CARDS_ROUNDING_NEVER_UNDERPAYS: 1,
        CARDS_CAP_NEVER_BINDS: 1,
        CARDS_BELIEF_EXHAUSTIVE: 3,
        CARDS_BELIEF_NORMALISED: 3,
        CARDS_SELECTOR_PRECOMMITTED: 3,
        CARDS_REVEAL_DETERMINISTIC: 3,
        CARDS_REVEAL_CHOICE_BOUND: 3,
        CARDS_SINGLE_BACKED_POSITION: 3,
        CARDS_TICKET_WELL_FORMED: 3,
        CARDS_SEED_MIXES_CLIENT_ENTROPY: 3,
        CARDS_SNAPSHOT_NOT_REVALIDATED: 3,
      });
      // Eleven value rewrites, one re-fenced receipt, and two forged
      // liquidations — the branch that carries money out of the round.
      expect(report.counters.snapshotTampers).toBe(3 * 14);
    },
  );

  /**
   * The objectives and the unsorted board, which the shipped references do not
   * use.
   *
   * `highest` and `lowest` are total functions on a tie-free deck exactly as
   * `middle` is, and `sortRemaining: false` leaves the hidden cards
   * exchangeable — so the posterior has to spread the objective's mass evenly
   * across them rather than leaning on an order that was never published.
   */
  it.each([
    ['highest', [3, 4, 5, 6, 7, 8, 9]],
    ['lowest', [1, 2, 3, 4, 5, 6, 7]],
  ])('prices a %s objective on an unsorted board', (objective, reachable) => {
    const variant = defineCardsGame({
      ...triadMiddleReference,
      id: `variant-${objective}-v1`,
      ladder: { size: 9, dealt: 3, objective: objective as 'highest' | 'lowest' },
      reveal: {
        modelVersion: 'variant-cut/v1',
        count: 1,
        eligibility: 'unbacked',
        sortRemaining: false,
      },
      sideMarkets: [{ id: 'TARGET', winningRanks: [reachable[1] as number] }],
      pricing: { ...triadMiddleReference.pricing, minStakeCredits: 100n, stakeStepCredits: 100n },
      risk: { maxWinMultiple: 500n, capMustNotBind: false },
    });
    expect([...reachableObjectiveRanks(variant)]).toEqual(reachable);
    // A market on a rank the objective can never take is still refused.
    expect(() =>
      defineCardsGame({
        ...variant,
        id: `variant-${objective}-bad-v1`,
        sideMarkets: [{ id: 'IMPOSSIBLE', winningRanks: [objective === 'highest' ? 1 : 9] }],
      }),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'INVALID_SIDE_MARKET' }),
      }),
    );

    const roundId = 'variant-round';
    const deal = deriveDeal(seed(17), variant, roundId);
    const steps = deriveRevealSteps(variant, deal, [{ index: 0, kind: 'back', position: 0 }]);
    // Nothing about the hidden cards is disclosed when the board is unsorted.
    expect(steps[0]?.sorted).toEqual([]);
    const belief = cardsBelief(variant, steps);
    const hidden = belief.record.hidden;
    expect(hidden).toHaveLength(2);
    expect(belief.positionWeights[hidden[0] as number]).toBe(
      belief.positionWeights[hidden[1] as number],
    );
    expect(belief.positionWeights.reduce((sum, weight) => sum + weight, 0n)).toBe(belief.total);
    expect(assertModuleConformance(sequentialCards, variant, 2).ok).toBe(true);
  });

  it('reports a malformed definition instead of throwing out of the runner', () => {
    const report = checkModuleConformance(sequentialCards, {} as never, 1);
    expect(report.ok).toBe(false);
    expect(report.definitionId).toBe('<invalid>');
    expect(ENGINE_LIMITS.maxRoundClaims).toBe(sequentialCards.book.maxOpenClaims);
  });
});
