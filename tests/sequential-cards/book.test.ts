import { describe, expect, it } from 'vitest';
import { floor as floorRational, multiply, rational } from '../../src/core/rational.js';
import { commandFingerprint } from '../../src/core/ledger.js';
import { snapshotHash } from '../../src/core/snapshot.js';
import { defineCardsGame } from '../../src/modules/sequential-cards/adapter.js';
import type { RevealStep } from '../../src/modules/sequential-cards/contracts.js';
import {
  cardsBelief,
  objectivePositionOf,
  objectiveRankOf,
} from '../../src/modules/sequential-cards/deck.js';
import { coverProbability, fairValue } from '../../src/modules/sequential-cards/pricing.js';
import {
  duoMiddleReference,
  triadMiddleReference,
} from '../../src/modules/sequential-cards/references.js';
import { CardsBook } from '../../src/modules/sequential-cards/round-book.js';
import { deriveRevealSteps, stepDigest } from '../../src/modules/sequential-cards/steps.js';
import { buildCardsTranscript } from '../../src/modules/sequential-cards/transcript.js';
import { deriveDeal } from '../../src/modules/sequential-cards/truth.js';
import { seed } from '../helpers.js';
import { cardsAdmission } from '../support/cards-admission.js';

type Definition = typeof triadMiddleReference;

/** Opens a ticket and applies every reveal, so a test starts at a decision. */
async function openedRound(
  definition: Definition,
  seedHex: string,
  roundId: string,
  selections: Parameters<CardsBook['open']>[0]['selections'],
  reveals = definition.reveal.count,
): Promise<{ book: CardsBook; steps: readonly RevealStep[] }> {
  const book = new CardsBook(definition);
  await book.open({
    idempotencyKey: 'open',
    expectedStepRevision: 0,
    roundId,
    ...cardsAdmission(definition, seedHex, roundId),
    selections,
  });
  const deal = deriveDeal(seedHex, definition, roundId);
  const steps = deriveRevealSteps(definition, deal, book.choices);
  for (let index = 0; index < reveals; index += 1)
    await book.advanceReveal({
      idempotencyKey: `reveal-${index}`,
      expectedStepRevision: index,
      step: steps[index] as RevealStep,
    });
  return { book, steps };
}

/**
 * The first seed whose round leaves the backed card live with a live rival.
 *
 * The search is a deterministic scan over the conformance seed sequence, not a
 * random draw: the test that uses it always runs the same round.
 */
function liveSeed(definition: Definition, backed: number, roundId: string): string {
  const choices = Array.from(
    { length: definition.backing.maxOpenBeforeReveal },
    (_value, index) => ({ index, kind: 'back' as const, position: index }),
  );
  for (let index = 0; index < 400; index += 1) {
    const seedHex = seed(index);
    const deal = deriveDeal(seedHex, definition, roundId);
    const belief = cardsBelief(definition, deriveRevealSteps(definition, deal, choices));
    const hidden = belief.record.hidden;
    const weight = belief.positionWeights[backed] as bigint;
    if (
      hidden.includes(backed) &&
      weight > 0n &&
      weight < belief.total &&
      hidden.some(
        (position) => position !== backed && (belief.positionWeights[position] as bigint) > 0n,
      )
    )
      return seedHex;
  }
  throw new Error('no live seed found');
}

/** The first seed whose round settles the objective onto `backed`. */
function winningSeed(definition: Definition, backed: number, roundId: string): string {
  for (let index = 0; index < 400; index += 1) {
    const seedHex = seed(index);
    const deal = deriveDeal(seedHex, definition, roundId);
    if (objectivePositionOf(definition, deal.ranks) === backed) return seedHex;
  }
  throw new Error('no winning seed found');
}

describe('sequential-cards: the multi-position round book', () => {
  it('opens one ticket, prices every row at entryRtp / p, and debits it once', async () => {
    const { book } = await openedRound(
      triadMiddleReference,
      seed(1),
      'r-open',
      [
        { id: 'MIDDLE', kind: 'position', position: 1, stake: 100n },
        { id: 'CORE', kind: 'market', marketId: 'BAND:CORE', stake: 25n },
      ],
      0,
    );
    expect(book.capBasisStake).toBe(125n);
    expect(book.liquidBalance).toBe(0n);
    expect(book.choices).toEqual([{ index: 0, kind: 'back', position: 1 }]);
    const middle = book.selections.find((selection) => selection.id === 'MIDDLE');
    // 100 x (24/25) / (1/3) = 288 exactly.
    expect(middle?.claim).toEqual(rational(288n));
    const core = book.selections.find((selection) => selection.id === 'CORE');
    // 25 x (24/25) / (53/143) = 3432/53, carried exactly rather than rounded.
    expect(core?.claim).toEqual(rational(3432n, 53n));
    expect(book.ledgerRevision).toBe(1);
  });

  it('holds two backed positions and liquidates one without touching the other', async () => {
    const definition = duoMiddleReference;
    const roundId = 'r-duo';
    const seedHex = liveSeed(definition, 0, roundId);
    const { book } = await openedRound(definition, seedHex, roundId, [
      { id: 'A', kind: 'position', position: 0, stake: 20n },
      { id: 'B', kind: 'position', position: 1, stake: 40n },
      { id: 'BAND', kind: 'market', marketId: 'BAND:LOW', stake: 10n },
    ]);
    expect(book.capBasisStake).toBe(70n);
    expect(book.selections).toHaveLength(3);

    const belief = book.belief();
    const live = book.selections.filter(
      (selection) =>
        selection.kind === 'position' &&
        coverProbability(belief, selection.positions).numerator > 0n &&
        book.offers(selection.id).includes('cash'),
    );
    expect(live.length).toBeGreaterThan(0);
    const target = live[0] as (typeof live)[number];
    const expected = floorRational(
      fairValue(definition, target.claim, coverProbability(belief, target.positions)),
    );
    const receipt = await book.cash({
      idempotencyKey: 'cash-one',
      expectedStepRevision: book.stepRevision,
      selectionId: target.id,
    });
    expect(receipt.credited).toBe(expected);
    expect(receipt.debited).toBe(0n);
    expect(book.liquidBalance).toBe(expected);
    // The other selections are untouched: one credit boundary per selection.
    expect(book.selections.filter((selection) => selection.status === 'live').length).toBe(2);
    expect(book.terminal).toBe(false);

    const transcript = buildCardsTranscript(seedHex, definition, roundId, book.choices);
    const settled = await book.settle({
      idempotencyKey: 'settle',
      expectedStepRevision: book.stepRevision,
      revealedSeed: seedHex,
      transcript,
    });
    expect(book.terminal).toBe(true);
    expect(book.liquidBalance).toBe(expected + settled.credited);
    // The round-wide ceiling is a multiple of the whole ticket, not of one row.
    expect(book.liquidBalance).toBeLessThanOrEqual(70n * definition.risk.maxWinMultiple);
  });

  it('transforms a claim on a switch with no credit boundary and exact fair value', async () => {
    const definition = triadMiddleReference;
    const roundId = 'r-switch';
    const seedHex = liveSeed(definition, 0, roundId);
    const { book } = await openedRound(definition, seedHex, roundId, [
      { id: 'M', kind: 'position', position: 0, stake: 100n },
    ]);
    const belief = book.belief();
    const before = book.selections[0] as (typeof book.selections)[number];
    const other = belief.record.hidden.find((position) => position !== 0) as number;
    const from = coverProbability(belief, before.positions);
    const to = coverProbability(belief, [other]);
    const receipt = await book.switchClaim({
      idempotencyKey: 'switch',
      expectedStepRevision: 1,
      selectionId: 'M',
      positions: [other],
    });
    expect([receipt.debited, receipt.credited]).toEqual([0n, 0n]);
    expect(book.liquidBalance).toBe(0n);
    const after = book.selections[0] as (typeof book.selections)[number];
    expect(after.positions).toEqual([other]);
    // Fair value is preserved exactly: q x claim' == p x claim.
    expect(multiply(to, after.claim)).toEqual(multiply(from, before.claim));
    expect(book.decisions).toEqual([
      { selectionId: 'M', action: 'switch', stepRevision: 1, positions: [other] },
    ]);
    // One action per decision window: a second one is refused, not re-priced.
    await expect(
      book.cash({ idempotencyKey: 'cash', expectedStepRevision: 1, selectionId: 'M' }),
    ).rejects.toMatchObject({
      code: 'CLAIM_REJECTED',
      details: { reason: 'DECISION_ALREADY_TAKEN' },
    });
  });

  it('hedges evenly on a split and settles on either covered card', async () => {
    const definition = triadMiddleReference;
    const roundId = 'r-split';
    const seedHex = liveSeed(definition, 0, roundId);
    const { book } = await openedRound(definition, seedHex, roundId, [
      { id: 'M', kind: 'position', position: 0, stake: 100n },
    ]);
    const belief = book.belief();
    const hidden = [...belief.record.hidden];
    expect(hidden).toHaveLength(2);
    const before = book.selections[0] as (typeof book.selections)[number];
    const value = fairValue(definition, before.claim, coverProbability(belief, before.positions));
    await book.splitClaim({
      idempotencyKey: 'split',
      expectedStepRevision: 1,
      selectionId: 'M',
      positions: hidden,
    });
    const after = book.selections[0] as (typeof book.selections)[number];
    expect([...after.positions].sort()).toEqual([...hidden].sort());
    // The even split pays the same amount whichever hidden card is the middle.
    expect(multiply(coverProbability(belief, hidden), after.claim)).toEqual(value);

    const transcript = buildCardsTranscript(seedHex, definition, roundId, book.choices);
    const objective = objectivePositionOf(definition, transcript.deal.ranks);
    const receipt = await book.settle({
      idempotencyKey: 'settle',
      expectedStepRevision: 1,
      revealedSeed: seedHex,
      transcript,
    });
    expect(receipt.credited).toBe(hidden.includes(objective) ? floorRational(after.claim) : 0n);
  });

  it('offers nothing at all once the reveal has decided the position', async () => {
    const definition = triadMiddleReference;
    const roundId = 'r-terminal';
    // Sweep seeds until the cut kills the backed card outright.
    let found = false;
    for (let index = 0; index < 200 && !found; index += 1) {
      const seedHex = seed(index);
      const { book } = await openedRound(definition, seedHex, roundId, [
        { id: 'M', kind: 'position', position: 0, stake: 25n },
      ]);
      const belief = book.belief();
      if (coverProbability(belief, [0]).numerator !== 0n) continue;
      found = true;
      expect(book.offers('M')).toEqual([]);
      for (const attempt of [
        book.cash({ idempotencyKey: 'c', expectedStepRevision: 1, selectionId: 'M' }),
        book.switchClaim({
          idempotencyKey: 's',
          expectedStepRevision: 1,
          selectionId: 'M',
          positions: [belief.record.hidden.find((p) => p !== 0) as number],
        }),
      ])
        await expect(attempt).rejects.toMatchObject({
          code: 'CLAIM_REJECTED',
          details: { reason: 'POSITION_SETTLED' },
        });
      const transcript = buildCardsTranscript(seedHex, definition, roundId, book.choices);
      const receipt = await book.settle({
        idempotencyKey: 'settle',
        expectedStepRevision: 1,
        revealedSeed: seedHex,
        transcript,
      });
      // p = 0 settles at exactly zero, with no epsilon anywhere in the path.
      expect(receipt.credited).toBe(0n);
    }
    expect(found).toBe(true);
  });

  it('refuses to move a claim onto an outcome of probability exactly zero', async () => {
    const definition = triadMiddleReference;
    const roundId = 'r-unpriceable';
    let found = false;
    for (let index = 0; index < 200 && !found; index += 1) {
      const seedHex = seed(index);
      const { book } = await openedRound(definition, seedHex, roundId, [
        { id: 'M', kind: 'position', position: 0, stake: 25n },
      ]);
      const belief = book.belief();
      const other = belief.record.hidden.find((position) => position !== 0) as number;
      if (
        coverProbability(belief, [0]).numerator === 0n ||
        coverProbability(belief, [other]).numerator !== 0n
      )
        continue;
      found = true;
      expect(book.offers('M')).toEqual(['hold', 'cash']);
      await expect(
        book.switchClaim({
          idempotencyKey: 's',
          expectedStepRevision: 1,
          selectionId: 'M',
          positions: [other],
        }),
      ).rejects.toMatchObject({
        code: 'CLAIM_REJECTED',
        details: { reason: 'ACTION_NOT_OFFERED' },
      });
    }
    expect(found).toBe(true);
  });

  it('admits a pre-reveal re-back under move and refuses it under reject', async () => {
    const { book } = await openedRound(
      triadMiddleReference,
      seed(2),
      'r-reback',
      [{ id: 'M', kind: 'position', position: 0, stake: 25n }],
      0,
    );
    const before = (book.selections[0] as (typeof book.selections)[number]).claim;
    expect(book.offers('M')).toEqual(['hold', 'switch']);
    await book.switchClaim({
      idempotencyKey: 'reback',
      expectedStepRevision: 0,
      selectionId: 'M',
      positions: [2],
    });
    const after = book.selections[0] as (typeof book.selections)[number];
    // The prior is uniform, so a re-back moves no value at all.
    expect(after.claim).toEqual(before);
    expect(after.positions).toEqual([2]);
    // And the choice log moves with it: the reveal may now take position 0.
    expect(book.choices).toEqual([{ index: 0, kind: 'back', position: 2 }]);

    const strict = await openedRound(
      duoMiddleReference,
      seed(2),
      'r-noreback',
      [
        { id: 'A', kind: 'position', position: 0, stake: 10n },
        { id: 'B', kind: 'position', position: 1, stake: 10n },
      ],
      0,
    );
    expect(strict.book.offers('A')).toEqual(['hold']);
    await expect(
      strict.book.switchClaim({
        idempotencyKey: 'reback',
        expectedStepRevision: 0,
        selectionId: 'A',
        positions: [3],
      }),
    ).rejects.toMatchObject({
      code: 'CLAIM_REJECTED',
      details: { reason: 'REBACK_REJECTED' },
    });
  });

  it.each([
    [
      'a stake below the minimum',
      [{ id: 'M', kind: 'position' as const, position: 0, stake: 5n }],
      'STAKE_BELOW_MINIMUM',
    ],
    [
      'a stake off the step lattice',
      [{ id: 'M', kind: 'position' as const, position: 0, stake: 30n }],
      'STAKE_BELOW_MINIMUM',
    ],
    [
      'a ticket of side markets alone',
      [{ id: 'B', kind: 'market' as const, marketId: 'BAND:LOW', stake: 25n }],
      'CHOICE_REQUIRED',
    ],
    [
      'two selections on one position',
      [
        { id: 'A', kind: 'position' as const, position: 0, stake: 25n },
        { id: 'B', kind: 'position' as const, position: 0, stake: 25n },
      ],
      'POSITION_ALREADY_BACKED',
    ],
    [
      'more backed positions than the definition admits',
      [
        { id: 'A', kind: 'position' as const, position: 0, stake: 25n },
        { id: 'B', kind: 'position' as const, position: 1, stake: 25n },
      ],
      'POSITION_ALREADY_BACKED',
    ],
    [
      'a repeated selection id',
      [
        { id: 'A', kind: 'position' as const, position: 0, stake: 25n },
        { id: 'A', kind: 'market' as const, marketId: 'BAND:LOW', stake: 25n },
      ],
      'DUPLICATE_SELECTION',
    ],
  ])('refuses a ticket with %s', async (_label, selections, reason) => {
    const book = new CardsBook(triadMiddleReference);
    await expect(
      book.open({
        idempotencyKey: 'open',
        expectedStepRevision: 0,
        roundId: 'r-ticket',
        ...cardsAdmission(triadMiddleReference, seed(1), 'r-ticket'),
        selections,
      }),
    ).rejects.toMatchObject({ details: { reason } });
    expect(book.capBasisStake).toBeUndefined();
  });

  it('replays an exact retry and refuses a reused key with a different payload', async () => {
    const book = new CardsBook(triadMiddleReference);
    const request = {
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId: 'r-idem',
      ...cardsAdmission(triadMiddleReference, seed(1), 'r-idem'),
      selections: [{ id: 'M', kind: 'position' as const, position: 0, stake: 25n }],
    };
    const first = await book.open(request);
    const retry = await book.open(request);
    expect(retry).toEqual(first);
    expect(book.ledgerRevision).toBe(1);
    expect(book.capBasisStake).toBe(25n);
    await expect(
      book.open({
        ...request,
        selections: [{ id: 'M', kind: 'position', position: 1, stake: 25n }],
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      book.advanceReveal({
        idempotencyKey: 'reveal',
        expectedStepRevision: 3,
        step: { index: 0, position: 1, rank: 4, sorted: [0, 2], label: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'STALE_FRAME' });
  });

  it('refuses a settlement that is not this round, and one before the schedule ends', async () => {
    const definition = triadMiddleReference;
    const roundId = 'r-settle';
    const seedHex = seed(3);
    const { book } = await openedRound(
      definition,
      seedHex,
      roundId,
      [{ id: 'M', kind: 'position', position: 0, stake: 25n }],
      0,
    );
    const transcript = buildCardsTranscript(seedHex, definition, roundId, book.choices);
    await expect(
      book.settle({
        idempotencyKey: 'early',
        expectedStepRevision: 0,
        revealedSeed: seedHex,
        transcript,
      }),
    ).rejects.toMatchObject({ details: { reason: 'CHOICE_CONFLICT' } });

    const deal = deriveDeal(seedHex, definition, roundId);
    const steps = deriveRevealSteps(definition, deal, book.choices);
    await book.advanceReveal({
      idempotencyKey: 'reveal',
      expectedStepRevision: 0,
      step: steps[0] as RevealStep,
    });
    await expect(
      book.settle({
        idempotencyKey: 'wrong-round',
        expectedStepRevision: 1,
        revealedSeed: seedHex,
        transcript: buildCardsTranscript(seedHex, definition, 'another-round', book.choices),
      }),
      // A proof that verifies on its own is still not this round: two rounds
      // routinely publish the same reveal, so the round identity is what stops
      // a book settling on somebody else's deal.
    ).rejects.toMatchObject({ code: 'COMMITMENT_MISMATCH' });
    await expect(
      book.settle({
        idempotencyKey: 'wrong-seed',
        expectedStepRevision: 1,
        revealedSeed: seed(99),
        transcript,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSCRIPT' });
    expect(book.terminal).toBe(false);
  });

  /**
   * The regression a single-basis cap would reintroduce.
   *
   * The ceiling is a multiple of everything the player risked, so a second
   * independently funded row raises it. Pinning it to whichever row came first
   * would truncate a legitimate win on the other.
   */
  it('caps a credit at the ceiling the whole ticket paid for, not the first row', async () => {
    const capped = defineCardsGame({
      ...triadMiddleReference,
      id: 'triad-capped-v1',
      risk: { maxWinMultiple: 2n, capMustNotBind: false },
    });
    const roundId = 'r-cap';
    const seedHex = winningSeed(capped, 0, roundId);

    const single = await openedRound(capped, seedHex, roundId, [
      { id: 'M', kind: 'position', position: 0, stake: 25n },
    ]);
    const alone = await single.book.settle({
      idempotencyKey: 'settle',
      expectedStepRevision: 1,
      revealedSeed: seedHex,
      transcript: buildCardsTranscript(seedHex, capped, roundId, single.book.choices),
    });
    // The claim is 72; a 25-credit basis at 2x tops out at 50.
    expect(alone.capped).toBe(true);
    expect(alone.credited).toBe(50n);
    expect(single.book.liquidBalance).toBeLessThanOrEqual(25n * 2n);

    const ticket = await openedRound(capped, seedHex, roundId, [
      { id: 'M', kind: 'position', position: 0, stake: 25n },
      { id: 'B', kind: 'market', marketId: 'EXACT:2', stake: 25n },
    ]);
    const together = await ticket.book.settle({
      idempotencyKey: 'settle',
      expectedStepRevision: 1,
      revealedSeed: seedHex,
      transcript: buildCardsTranscript(seedHex, capped, roundId, ticket.book.choices),
    });
    expect(ticket.book.capBasisStake).toBe(50n);
    expect(together.capped).toBe(false);
    expect(together.credited).toBe(72n);
    expect(ticket.book.liquidBalance).toBeLessThanOrEqual(50n * 2n);
  });

  it('restores a settled round by re-deriving it, and rejects re-sealed tampering', async () => {
    const definition = triadMiddleReference;
    const roundId = 'r-restore';
    const seedHex = liveSeed(definition, 0, roundId);
    const { book } = await openedRound(definition, seedHex, roundId, [
      { id: 'M', kind: 'position', position: 0, stake: 100n },
      { id: 'B', kind: 'market', marketId: 'BAND:CORE', stake: 25n },
    ]);
    const other = book.belief().record.hidden.find((position) => position !== 0) as number;
    await book.switchClaim({
      idempotencyKey: 'switch',
      expectedStepRevision: 1,
      selectionId: 'M',
      positions: [other],
    });
    const transcript = buildCardsTranscript(seedHex, definition, roundId, book.choices);
    await book.settle({
      idempotencyKey: 'settle',
      expectedStepRevision: 1,
      revealedSeed: seedHex,
      transcript,
    });
    const snapshot = book.snapshot() as unknown as Record<string, unknown>;
    const restored = CardsBook.restore(
      definition,
      JSON.stringify(snapshot),
      book.publishedRound ?? null,
    );
    expect(restored.snapshot()).toEqual(book.snapshot());
    expect(restored.terminal).toBe(true);
    expect(restored.decisions).toEqual(book.decisions);

    const decisions = snapshot.decisions as Record<string, unknown>[];
    const selections = snapshot.selections as Record<string, unknown>[];
    for (const mutation of [
      { liquidBalance: '999999' },
      { capBasisStake: '999999' },
      { terminal: false },
      { ledgerRevision: 9 },
      { decisions: [] },
      // A rewritten decision target: the claim would be worth something else.
      { decisions: decisions.map((decision) => ({ ...decision, positions: [0] })) },
      // A rewritten claim: restore recomputes it and refuses the copy.
      {
        selections: selections.map((selection, index) =>
          index === 0 ? { ...selection, claim: { numerator: '1', denominator: '1' } } : selection,
        ),
      },
      // A rewritten settlement outcome.
      {
        settlement: {
          ...(snapshot.settlement as Record<string, unknown>),
          objectiveRank:
            ((snapshot.settlement as { objectiveRank: number }).objectiveRank % 11) + 2,
        },
      },
    ]) {
      const tampered = {
        ...snapshot,
        ...mutation,
        snapshotHash: snapshotHash({ ...snapshot, ...mutation, snapshotHash: undefined }),
      };
      expect(
        () => CardsBook.restore(definition, JSON.stringify(tampered), book.publishedRound ?? null),
        JSON.stringify(Object.keys(mutation)),
      ).toThrowError(
        expect.objectContaining({
          code: expect.stringMatching(/INVALID_SNAPSHOT|DEFINITION_MISMATCH/u),
        }),
      );
    }

    // A rewritten round identity is what pins the proof, and it is now refused
    // by the published-binding comparison before any re-derivation runs. Kept
    // out of the loop above so that this stronger, earlier guard cannot silently
    // absorb a case the deep checks are supposed to catch on their merits.
    const repointed = {
      ...snapshot,
      roundId: 'somebody-elses-round',
      snapshotHash: snapshotHash({
        ...snapshot,
        roundId: 'somebody-elses-round',
        snapshotHash: undefined,
      }),
    };
    expect(() =>
      CardsBook.restore(definition, JSON.stringify(repointed), book.publishedRound ?? null),
    ).toThrowError(
      expect.objectContaining({ code: 'COMMITMENT_MISMATCH', path: '$.expectedBinding' }),
    );
  });

  it('re-derives the choice log a re-back moved, and refuses a rewritten one', async () => {
    const definition = triadMiddleReference;
    const roundId = 'r-reback-restore';
    const { book } = await openedRound(
      definition,
      seed(8),
      roundId,
      [{ id: 'M', kind: 'position', position: 0, stake: 25n }],
      0,
    );
    await book.switchClaim({
      idempotencyKey: 'reback',
      expectedStepRevision: 0,
      selectionId: 'M',
      positions: [2],
    });
    expect(book.choices).toEqual([{ index: 0, kind: 'back', position: 2 }]);
    const snapshot = book.snapshot() as unknown as Record<string, unknown>;
    expect(
      CardsBook.restore(definition, JSON.stringify(snapshot), book.publishedRound ?? null).choices,
    ).toEqual(book.choices);
    // The log is rebuilt from the open receipt and the transform log, so a
    // rewritten one cannot survive even with the checksum recomputed over it.
    const tampered = {
      ...snapshot,
      choices: [{ index: 0, kind: 'back', position: 1 }],
    };
    expect(() =>
      CardsBook.restore(
        definition,
        JSON.stringify({
          ...tampered,
          snapshotHash: snapshotHash({ ...tampered, snapshotHash: undefined }),
        }),
        book.publishedRound ?? null,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  /**
   * `stakeScope: 'per-selection'` has to be true of the money, not only of the
   * validation.
   *
   * Two winning markets on one ticket must credit `floor(a) + floor(b)`, the same
   * as cashing them one at a time. Summing the rationals first and flooring once
   * would let one selection's fractional part finance another's — here that is
   * exactly one credit, and one credit that came from nowhere is a defect
   * whatever its size.
   */
  it('floors each winning selection on its own, with no fractional carry between them', async () => {
    const definition = triadMiddleReference;
    const roundId = 'r-carry';
    let found = false;
    for (let index = 0; index < 400 && !found; index += 1) {
      const seedHex = seed(index);
      const deal = deriveDeal(seedHex, definition, roundId);
      if (objectiveRankOf(definition, deal.ranks) !== 7) continue;
      if (objectivePositionOf(definition, deal.ranks) === 0) continue;
      found = true;
      const { book } = await openedRound(definition, seedHex, roundId, [
        { id: 'M', kind: 'position', position: 0, stake: 25n },
        { id: 'CORE', kind: 'market', marketId: 'BAND:CORE', stake: 25n },
        { id: 'SEVEN', kind: 'market', marketId: 'EXACT:7', stake: 25n },
      ]);
      const receipt = await book.settle({
        idempotencyKey: 'settle',
        expectedStepRevision: 1,
        revealedSeed: seedHex,
        transcript: buildCardsTranscript(seedHex, definition, roundId, book.choices),
      });
      // 25 x (24/25) / (53/143) = 3432/53 -> 64;  25 x (24/25) / (18/143) = 572/3 -> 190.
      expect(floorRational(rational(3432n, 53n))).toBe(64n);
      expect(floorRational(rational(572n, 3n))).toBe(190n);
      expect(receipt.credited).toBe(254n);
      // Flooring the sum instead would have paid one credit more.
      expect(floorRational(rational(3432n * 3n + 572n * 53n, 159n))).toBe(255n);
    }
    expect(found).toBe(true);
  });

  /**
   * A settled snapshot is re-verified against the seed it reveals.
   *
   * The forgery below is internally perfect: the outcome, the settle receipt's
   * fingerprint and credited amount, the liquid balance, and the checksum are
   * all recomputed to agree with each other. It still dies, because restore
   * re-derives the deal from the revealed seed rather than believing what the
   * snapshot says the deal produced.
   */
  it('refuses a settled snapshot whose outcome contradicts its own revealed seed', async () => {
    const definition = triadMiddleReference;
    const roundId = 'r-forged';
    const seedHex = liveSeed(definition, 0, roundId);
    const { book } = await openedRound(definition, seedHex, roundId, [
      { id: 'M', kind: 'position', position: 0, stake: 25n },
    ]);
    await book.settle({
      idempotencyKey: 'settle',
      expectedStepRevision: 1,
      revealedSeed: seedHex,
      transcript: buildCardsTranscript(seedHex, definition, roundId, book.choices),
    });
    const snapshot = JSON.parse(JSON.stringify(book.snapshot())) as Record<string, unknown>;
    const settlement = snapshot.settlement as Record<string, unknown>;
    const truthful = objectivePositionOf(
      definition,
      deriveDeal(seedHex, definition, roundId).ranks,
    );
    const forgedPosition = truthful === 0 ? 1 : 0;
    const forged: Record<string, unknown> = {
      ...settlement,
      objectivePosition: forgedPosition,
      objectiveRank: 7,
    };
    const receipts = snapshot.receipts as Record<string, unknown>[];
    const settleEntry = receipts[receipts.length - 1] as Record<string, unknown>;
    const settleReceipt = settleEntry.receipt as Record<string, unknown>;
    const fingerprint = commandFingerprint('settle', [
      stepDigest(book.steps),
      forged.revealedSeed as string,
      forged.commitment as string,
      forged.objectiveRank as number,
      forged.objectivePosition as number,
    ]);
    // The credited figure is recomputed to match the forged outcome exactly, so
    // nothing internal to the snapshot disagrees with anything else.
    const credited = forgedPosition === 0 ? String(floorRational(rational(72n * 25n, 25n))) : '0';
    const tampered = {
      ...snapshot,
      settlement: forged,
      liquidBalance: credited,
      receipts: [
        ...receipts.slice(0, -1),
        {
          fingerprint,
          receipt: {
            ...settleReceipt,
            commandFingerprint: fingerprint,
            credited,
            balanceDelta: credited,
          },
        },
      ],
    };
    expect(() =>
      CardsBook.restore(
        definition,
        JSON.stringify({
          ...tampered,
          snapshotHash: snapshotHash({ ...tampered, snapshotHash: undefined }),
        }),
        book.publishedRound ?? null,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  it('refuses a ticket longer than the definition can hold, before reading a row', async () => {
    const book = new CardsBook(triadMiddleReference);
    const rows = Array.from({ length: 5_000 }, (_value, index) => ({
      id: `row-${index}`,
      kind: 'market' as const,
      marketId: 'BAND:LOW',
      stake: 25n,
    }));
    await expect(
      book.open({
        idempotencyKey: 'flood',
        expectedStepRevision: 0,
        roundId: 'r-flood',
        ...cardsAdmission(triadMiddleReference, seed(1), 'r-flood'),
        selections: rows,
      }),
    ).rejects.toMatchObject({ code: 'CLAIM_REJECTED', details: { reason: 'DUPLICATE_SELECTION' } });
  });

  /**
   * The reveal boundary, pinned as behaviour rather than left in a docstring.
   *
   * `CardsBook` holds a definition and no seed, so `advanceReveal` validates a
   * step as **public record** — structure, eligibility, cumulative sorts — and
   * cannot establish that it came from the sealed deal. A fabricated step that
   * clears those rules is applied, the belief moves to it, and a mid-round
   * `cash` credits against it. `settle` refuses the round afterwards, but the
   * credit has already been made, and a host that never settles is never
   * contradicted.
   *
   * This test exists so that the boundary `docs/modules/sequential-cards.md`
   * §6.2 and §12 publish is a checked claim, and so that a future revision which
   * closes it — by giving the book the sealed deal, say — fails here loudly
   * rather than leaving the documentation overstating the gap.
   */
  it('applies a reveal the sealed deal never produced, and credits against it', async () => {
    const seedHex = seed(0x9c);
    const roundId = 'r-provenance';
    const book = new CardsBook(triadMiddleReference);
    await book.open({
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId,
      ...cardsAdmission(triadMiddleReference, seedHex, roundId),
      selections: [{ id: 's1', kind: 'position', position: 0, stake: 100n }],
    });
    const deal = deriveDeal(seedHex, triadMiddleReference, roundId);
    const honest = deriveRevealSteps(triadMiddleReference, deal, book.choices)[0] as RevealStep;

    // A different eligible position, a rank of our choosing, and a published
    // sort that suits us. Nothing here came from the sealed deal.
    const other = honest.position === 1 ? 2 : 1;
    const forged: RevealStep = Object.freeze({
      index: 0,
      position: other,
      rank: 2,
      sorted: Object.freeze(other === 1 ? [0, 2] : [0, 1]),
      label: `${triadMiddleReference.reveal.modelVersion}:0`,
    });
    expect(forged.rank).not.toBe(deal.ranks[other]);

    const applied = await book.advanceReveal({
      idempotencyKey: 'reveal-forged',
      expectedStepRevision: 0,
      step: forged,
    });
    expect(applied.action).toBe('reveal');
    expect(book.stepRevision).toBe(1);

    // And it is worth money: the sealed board would have decided this position,
    // the forged one leaves it live and generously priced.
    const cashed = await book.cash({
      idempotencyKey: 'cash-forged',
      expectedStepRevision: 1,
      selectionId: 's1',
    });
    expect(cashed.credited).toBe(240n);

    // Settlement is where provenance is finally established, and it refuses —
    // after the credit, which is exactly why the host owns the derivation.
    await expect(
      book.settle({
        idempotencyKey: 'settle',
        expectedStepRevision: 1,
        revealedSeed: seedHex,
        transcript: buildCardsTranscript(seedHex, triadMiddleReference, roundId, book.choices),
      }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPT_MISMATCH' });
  });

  it('refuses a definition that charges a second margin on liquidation', () => {
    expect(() =>
      defineCardsGame({
        ...triadMiddleReference,
        id: 'triad-spread-v1',
        pricing: { ...triadMiddleReference.pricing, liquidationSpread: rational(1n, 100n) },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVALID_ADAPTER',
        details: expect.objectContaining({ reason: 'INVALID_LIQUIDATION_SPREAD' }),
      }),
    );
  });

  it('restores a mid-round book with a live claim and a cashed one', async () => {
    const definition = duoMiddleReference;
    const roundId = 'r-mid';
    const seedHex = liveSeed(definition, 0, roundId);
    const { book } = await openedRound(definition, seedHex, roundId, [
      { id: 'A', kind: 'position', position: 0, stake: 20n },
      { id: 'B', kind: 'position', position: 1, stake: 10n },
    ]);
    const cashable = book.selections.find((selection) =>
      book.offers(selection.id).includes('cash'),
    );
    expect(cashable).toBeDefined();
    await book.cash({
      idempotencyKey: 'cash',
      expectedStepRevision: book.stepRevision,
      selectionId: (cashable as { id: string }).id,
    });
    const snapshot = book.snapshot();
    const restored = CardsBook.restore(
      definition,
      JSON.stringify(snapshot),
      book.publishedRound ?? null,
    );
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.terminal).toBe(false);
    expect(restored.liquidBalance).toBe(book.liquidBalance);
    expect(restored.capBasisStake).toBe(30n);
  });
});
