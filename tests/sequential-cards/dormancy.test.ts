import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RevealEngineError } from '../../src/api/errors.js';
import { snapshotHash } from '../../src/core/snapshot.js';
import { floor as floorRational, rational } from '../../src/core/rational.js';
import {
  cardsFingerprint,
  cardsRoundOf,
  defineCardsGame,
} from '../../src/modules/sequential-cards/adapter.js';
import {
  convertToCredits,
  deriveRoundingSeed,
} from '../../src/modules/sequential-cards/credits.js';
import { cardsBelief, objectiveRankOf } from '../../src/modules/sequential-cards/deck.js';
import { coverProbability, fairValue } from '../../src/modules/sequential-cards/pricing.js';
import {
  cascadeMiddleReference,
  triadDormantReference,
  triadMiddleReference,
} from '../../src/modules/sequential-cards/references.js';
import { CardsBook, dormantFingerprint } from '../../src/modules/sequential-cards/round-book.js';
import { deriveRevealSteps, stepDigest } from '../../src/modules/sequential-cards/steps.js';
import { buildCardsTranscript } from '../../src/modules/sequential-cards/transcript.js';
import { deriveDeal } from '../../src/modules/sequential-cards/truth.js';
import type { RevealStep } from '../../src/modules/sequential-cards/contracts.js';
import {
  buildFrozenDormantCardsRound,
  frozenDormantDefinition,
} from '../support/frozen-cards-round.js';
import { seed } from '../helpers.js';

/**
 * The dormant settlement: what the module can check, and what it cannot.
 *
 * `triad/docs/ENGINE.md` §9 is explicit that the module owns no clock —
 * `settleDormant` is a command the host calls and the window is a declared
 * parameter — so the division of labour under test here is narrow and stated:
 * the host measures the seconds, and the module refuses everything around them.
 * Every case below is either a refusal the module owes, or the one price a
 * system settlement is allowed to pay.
 */

const definition = triadDormantReference;
const SEED = seed(71);
const ROUND = 'dormant-round-1';
const WINDOW = 86_400;

type Mutable = Record<string, unknown>;

function reseal(value: Mutable): string {
  return JSON.stringify({
    ...value,
    snapshotHash: snapshotHash({ ...value, snapshotHash: undefined }),
  });
}

/** A round staked on a backed position and a side market, one reveal in. */
async function stakedRound(
  subject = definition,
  seedHex = SEED,
  roundId = ROUND,
): Promise<{ book: CardsBook; steps: readonly RevealStep[] }> {
  const book = new CardsBook(subject);
  await book.open({
    idempotencyKey: 'open',
    expectedStepRevision: 0,
    roundId,
    selections: [
      { id: 'MIDDLE', kind: 'position', position: 0, stake: subject.pricing.minStakeCredits },
      {
        id: 'BAND',
        kind: 'market',
        marketId: subject.sideMarkets[0]?.id as string,
        stake: subject.pricing.minStakeCredits,
      },
    ],
    ...(subject.pricing.rounding === 'stochastic'
      ? { roundingSeed: deriveRoundingSeed(seedHex, cardsFingerprint(subject), roundId) }
      : {}),
  });
  const deal = deriveDeal(seedHex, subject, roundId);
  const steps = deriveRevealSteps(subject, deal, book.choices);
  await book.advanceReveal({
    idempotencyKey: 'reveal-0',
    expectedStepRevision: 0,
    step: steps[0] as RevealStep,
  });
  return { book, steps };
}

describe('sequential-cards: the dormant settlement', () => {
  it('refuses a window the host has not measured to the end', async () => {
    const { book } = await stakedRound();
    const transcript = buildCardsTranscript(SEED, definition, ROUND, book.choices);
    let refusal: unknown;
    try {
      await book.settleDormant({
        idempotencyKey: 'early',
        expectedStepRevision: 1,
        revealedSeed: SEED,
        transcript,
        elapsedSeconds: WINDOW - 1,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(RevealEngineError);
    expect((refusal as RevealEngineError).code).toBe('CLAIM_REJECTED');
    expect((refusal as RevealEngineError).details).toMatchObject({ reason: 'ROUND_NOT_DORMANT' });
    // Refused, and the round is untouched: no credit, no terminal flag.
    expect(book.terminal).toBe(false);
    expect(book.liquidBalance).toBe(0n);
    expect(book.settlementReason).toBeNull();
  });

  it('settles at the window, crediting the board price and the deal', async () => {
    const { book } = await stakedRound();
    const belief = book.belief();
    const backed = book.selections.find((row) => row.id === 'MIDDLE');
    const market = book.selections.find((row) => row.id === 'BAND');
    if (backed === undefined || market === undefined) throw new Error('fixture');
    const deal = deriveDeal(SEED, definition, ROUND);
    const objectiveRank = objectiveRankOf(definition, deal.ranks);
    const transcript = buildCardsTranscript(SEED, definition, ROUND, book.choices);

    // Re-derived here from the two published rules rather than from the
    // module's own helper: a live position is liquidated at `p · claim` against
    // the board the player was looking at, and a market settles from the deal.
    const liquidation = fairValue(
      definition,
      backed.claim,
      coverProbability(belief, backed.positions),
    );
    const marketWins = (
      definition.sideMarkets.find((row) => row.id === market.marketId)?.winningRanks ?? []
    ).includes(objectiveRank);

    const receipt = await book.settleDormant({
      idempotencyKey: 'dormant',
      expectedStepRevision: 1,
      revealedSeed: SEED,
      transcript,
      elapsedSeconds: WINDOW,
    });
    expect(receipt.action).toBe('settleDormant');
    expect(receipt.debited).toBe(0n);
    expect(book.terminal).toBe(true);
    expect(book.settlementReason).toBe('ROUND_DORMANT');
    // Under the settlement draw a credit is the whole part plus a bounded draw,
    // so the credited integer is pinned between the two integers the rule
    // admits for each row and never outside them.
    const lower = floorRational(liquidation) + (marketWins ? floorRational(market.claim) : 0n);
    const upper =
      lower +
      (liquidation.numerator % liquidation.denominator === 0n ? 0n : 1n) +
      (marketWins && market.claim.numerator % market.claim.denominator !== 0n ? 1n : 0n);
    expect(receipt.credited).toBeGreaterThanOrEqual(lower);
    expect(receipt.credited).toBeLessThanOrEqual(upper);
    expect(book.liquidBalance).toBe(receipt.credited);
  });

  it('settles a row that already acted at the value it acted from', async () => {
    // The subtle half of the cap argument. `settleDormant` deliberately does
    // **not** apply the one-action-per-window rule — `triad/docs/DESIGN.md`
    // §10.6 rule 8 requires the account-state path to work while the round is
    // live, not only while a decision is available — so a row that split or
    // switched inside the current window can still be liquidated by the system
    // in that same window, which no player command can do. That is only sound
    // because a transformation preserves fair value exactly at the zero spread
    // this module requires: `q · claim' = p · claim`. So the amount the system
    // pays is a payout the definition-time walk already recorded at that
    // revision, and the reachable maximum still bounds it with no second walk.
    let compared = 0;
    for (let index = 0; index < 40; index += 1) {
      const seedHex = seed(500 + index);
      const roundId = `dormant-after-action-${index}`;
      const { book } = await stakedRound(definition, seedHex, roundId);
      if (!book.offers('MIDDLE').includes('split')) continue;
      const belief = book.belief();
      const live = belief.record.hidden.filter(
        (position) => (belief.positionWeights[position] as bigint) > 0n,
      );
      if (live.length < 2) continue;
      const before = book.selections.find((row) => row.id === 'MIDDLE');
      if (before === undefined) throw new Error('fixture');
      const valueBefore = fairValue(
        definition,
        before.claim,
        coverProbability(belief, before.positions),
      );
      await book.splitClaim({
        idempotencyKey: 'split',
        expectedStepRevision: 1,
        selectionId: 'MIDDLE',
        positions: [...live].sort((left, right) => left - right),
      });
      // The player can take nothing more in this window.
      expect(book.offers('MIDDLE')).toEqual([]);
      const after = book.selections.find((row) => row.id === 'MIDDLE');
      if (after === undefined) throw new Error('fixture');
      const valueAfter = fairValue(
        definition,
        after.claim,
        coverProbability(book.belief(), after.positions),
      );
      // Exactly equal, in rationals, with no epsilon and no re-reduction.
      expect(valueAfter).toEqual(valueBefore);
      const market = book.selections.find((row) => row.id === 'BAND');
      if (market === undefined) throw new Error('fixture');
      const objectiveRank = objectiveRankOf(
        definition,
        deriveDeal(seedHex, definition, roundId).ranks,
      );
      const marketCredit = (
        definition.sideMarkets.find((row) => row.id === market.marketId)?.winningRanks ?? []
      ).includes(objectiveRank)
        ? convertToCredits(
            definition,
            market.claim,
            { selectionId: market.id, sequence: book.ledgerRevision + 1 },
            {
              roundingSeed: deriveRoundingSeed(seedHex, cardsFingerprint(definition), roundId),
              round: cardsRoundOf(definition, roundId),
            },
          ).credits
        : 0n;
      const receipt = await book.settleDormant({
        idempotencyKey: 'dormant',
        expectedStepRevision: 1,
        revealedSeed: seedHex,
        transcript: buildCardsTranscript(seedHex, definition, roundId, book.choices),
        elapsedSeconds: WINDOW,
      });
      const whole = floorRational(valueAfter) + marketCredit;
      expect(receipt.credited === whole || receipt.credited === whole + 1n).toBe(true);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(8);
  });

  it('pays a liquidation, not the outcome, on the row the reveal made a certainty', async () => {
    // The whole economic content of `onDormant: 'cash'`: the system settlement
    // is the price the board was showing, so it can never pay more than the
    // claim it liquidates and can never be worth choosing over the player's own
    // decision.
    const { book } = await stakedRound();
    const backed = book.selections.find((row) => row.id === 'MIDDLE');
    if (backed === undefined) throw new Error('fixture');
    const probability = coverProbability(book.belief(), backed.positions);
    const transcript = buildCardsTranscript(SEED, definition, ROUND, book.choices);
    const receipt = await book.settleDormant({
      idempotencyKey: 'dormant',
      expectedStepRevision: 1,
      revealedSeed: SEED,
      transcript,
      elapsedSeconds: WINDOW * 10,
    });
    const settledWhole = floorRational(backed.claim);
    if (probability.numerator < probability.denominator)
      expect(receipt.credited).toBeLessThan(settledWhole);
  });

  it('credits exactly what a cash-out would have, plus the markets, on every round it can', async () => {
    // `onDormant: 'cash'` as an equality rather than as a description. The two
    // paths are run separately from the same seed and the same command
    // sequence, so the settlement draw is taken under the identical event, and
    // the dormant credit has to be the cash-out the player did not take plus
    // whatever the markets settle for on their own.
    let compared = 0;
    for (let index = 0; index < 24; index += 1) {
      const seedHex = seed(300 + index);
      const roundId = `dormant-equiv-${index}`;
      const cashed = (await stakedRound(definition, seedHex, roundId)).book;
      if (!cashed.offers('MIDDLE').includes('cash')) continue;
      const cashReceipt = await cashed.cash({
        idempotencyKey: 'cash',
        expectedStepRevision: 1,
        selectionId: 'MIDDLE',
      });

      const dormant = (await stakedRound(definition, seedHex, roundId)).book;
      const market = dormant.selections.find((row) => row.id === 'BAND');
      if (market === undefined) throw new Error('fixture');
      const deal = deriveDeal(seedHex, definition, roundId);
      const objectiveRank = objectiveRankOf(definition, deal.ranks);
      const marketWins = (
        definition.sideMarkets.find((row) => row.id === market.marketId)?.winningRanks ?? []
      ).includes(objectiveRank);
      const marketCredit = marketWins
        ? convertToCredits(
            definition,
            market.claim,
            { selectionId: market.id, sequence: dormant.ledgerRevision + 1 },
            {
              roundingSeed: deriveRoundingSeed(seedHex, cardsFingerprint(definition), roundId),
              round: cardsRoundOf(definition, roundId),
            },
          ).credits
        : 0n;
      const receipt = await dormant.settleDormant({
        idempotencyKey: 'dormant',
        expectedStepRevision: 1,
        revealedSeed: seedHex,
        transcript: buildCardsTranscript(seedHex, definition, roundId, dormant.choices),
        elapsedSeconds: WINDOW,
      });
      expect(receipt.credited).toBe(cashReceipt.credited + marketCredit);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(8);
  });

  it('settles early only under a reason the definition declares', async () => {
    const { book } = await stakedRound();
    const transcript = buildCardsTranscript(SEED, definition, ROUND, book.choices);
    await expect(
      book.settleDormant({
        idempotencyKey: 'bad-reason',
        expectedStepRevision: 1,
        revealedSeed: SEED,
        transcript,
        elapsedSeconds: 0,
        reason: 'operator-discretion' as never,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'INVALID_SETTLEMENT_REASON' }),
      }),
    );
    const receipt = await book.settleDormant({
      idempotencyKey: 'excluded',
      expectedStepRevision: 1,
      revealedSeed: SEED,
      transcript,
      elapsedSeconds: 0,
      reason: 'account-state-changed',
    });
    expect(receipt.action).toBe('settleDormant');
    expect(book.settlementReason).toBe('ACCOUNT_STATE_CHANGED');
    // The two system paths are never conflated: the reason is inside the
    // command fingerprint, so the same round settled the other way is a
    // different command.
    expect(book.terminal).toBe(true);
  });

  it('refuses a round that never became decidable, and one with no policy at all', async () => {
    const book = new CardsBook(definition);
    await book.open({
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId: ROUND,
      selections: [{ id: 'MIDDLE', kind: 'position', position: 0, stake: 25n }],
      roundingSeed: deriveRoundingSeed(SEED, cardsFingerprint(definition), ROUND),
    });
    const transcript = buildCardsTranscript(SEED, definition, ROUND, book.choices);
    await expect(
      book.settleDormant({
        idempotencyKey: 'pre-cut',
        expectedStepRevision: 0,
        revealedSeed: SEED,
        transcript,
        elapsedSeconds: WINDOW * 10,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'ROUND_NOT_DORMANT' }),
      }),
    );

    // A definition that declares no policy has no dormant path, and says so
    // rather than settling anyway.
    const plain = new CardsBook(triadMiddleReference);
    await plain.open({
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId: ROUND,
      selections: [{ id: 'MIDDLE', kind: 'position', position: 0, stake: 25n }],
    });
    await expect(
      plain.settleDormant({
        idempotencyKey: 'no-policy',
        expectedStepRevision: 0,
        revealedSeed: SEED,
        transcript: buildCardsTranscript(SEED, triadMiddleReference, ROUND, plain.choices),
        elapsedSeconds: WINDOW * 10,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'ROUND_NOT_DORMANT' }),
      }),
    );
  });

  it('refuses a proof for another round, and a tape the credits did not come from', async () => {
    const { book } = await stakedRound();
    const otherTranscript = buildCardsTranscript(
      seed(72),
      definition,
      'another-round',
      book.choices,
    );
    await expect(
      book.settleDormant({
        idempotencyKey: 'wrong-round',
        expectedStepRevision: 1,
        revealedSeed: seed(72),
        transcript: otherTranscript,
        elapsedSeconds: WINDOW,
      }),
    ).rejects.toBeInstanceOf(RevealEngineError);

    // A round whose tape does not derive from the seed being revealed is
    // refused on the dormant path exactly as it is on `settle`.
    const mismatched = new CardsBook(definition);
    await mismatched.open({
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId: ROUND,
      selections: [{ id: 'MIDDLE', kind: 'position', position: 0, stake: 25n }],
      roundingSeed: deriveRoundingSeed(seed(99), cardsFingerprint(definition), ROUND),
    });
    const deal = deriveDeal(SEED, definition, ROUND);
    const steps = deriveRevealSteps(definition, deal, mismatched.choices);
    await mismatched.advanceReveal({
      idempotencyKey: 'reveal-0',
      expectedStepRevision: 0,
      step: steps[0] as RevealStep,
    });
    await expect(
      mismatched.settleDormant({
        idempotencyKey: 'wrong-tape',
        expectedStepRevision: 1,
        revealedSeed: SEED,
        transcript: buildCardsTranscript(SEED, definition, ROUND, mismatched.choices),
        elapsedSeconds: WINDOW,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'TRANSCRIPT_MISMATCH' }));
  });

  it('settles a round abandoned part-way through its reveal schedule', async () => {
    // Two reveals, settled after the first: the board the player abandoned is
    // the board they are paid on, and the proof's steps extend the round's
    // rather than equalling them.
    const cascade = defineCardsGame({
      ...cascadeMiddleReference,
      id: 'cascade-dormant-v1',
      dormancy: { windowSeconds: 3_600, onDormant: 'cash', earlySettlementReasons: [] },
    });
    const { book } = await stakedRound(cascade, seed(73), 'cascade-dormant-round');
    expect(book.stepRevision).toBe(1);
    expect(cascade.reveal.count).toBe(2);
    const transcript = buildCardsTranscript(
      seed(73),
      cascade,
      'cascade-dormant-round',
      book.choices,
    );
    await book.settleDormant({
      idempotencyKey: 'dormant',
      expectedStepRevision: 1,
      revealedSeed: seed(73),
      transcript,
      elapsedSeconds: 3_600,
    });
    expect(book.terminal).toBe(true);
    expect(book.stepRevision).toBe(1);
    // And an early reason is refused where the definition declares none.
    const second = (await stakedRound(cascade, seed(74), 'cascade-dormant-round-2')).book;
    await expect(
      second.settleDormant({
        idempotencyKey: 'early',
        expectedStepRevision: 1,
        revealedSeed: seed(74),
        transcript: buildCardsTranscript(
          seed(74),
          cascade,
          'cascade-dormant-round-2',
          second.choices,
        ),
        elapsedSeconds: 0,
        reason: 'account-state-changed',
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'INVALID_SETTLEMENT_REASON' }),
      }),
    );

    // The partially-revealed dormant snapshot round-trips.
    const restored = CardsBook.restore(cascade, book.serialize());
    expect(restored.serialize()).toBe(book.serialize());
    expect(restored.settlementReason).toBe('ROUND_DORMANT');
  });

  it('round-trips a dormant snapshot and refuses every rewrite of its reason', async () => {
    const { book } = await stakedRound();
    const transcript = buildCardsTranscript(SEED, definition, ROUND, book.choices);
    await book.settleDormant({
      idempotencyKey: 'dormant',
      expectedStepRevision: 1,
      revealedSeed: SEED,
      transcript,
      elapsedSeconds: WINDOW,
    });
    const serialized = book.serialize();
    expect(CardsBook.restore(definition, serialized).serialize()).toBe(serialized);
    const snapshot = JSON.parse(serialized) as Mutable;
    expect(snapshot.settlementReason).toBe('ROUND_DORMANT');

    // Relabelled after the fact. The reason is inside the receipt fingerprint,
    // so the rest of the log staying consistent buys the forgery nothing.
    expect(() =>
      CardsBook.restore(
        definition,
        reseal({ ...snapshot, settlementReason: 'ACCOUNT_STATE_CHANGED' }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVALID_SNAPSHOT',
        message: 'Settle receipt does not match the settlement record',
      }),
    );
    // Erased: a system settlement that will not say why it happened is a system
    // settlement presented as the player's own.
    expect(() =>
      CardsBook.restore(definition, reseal({ ...snapshot, settlementReason: null })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
    // Invented: a reason neither this module nor the definition knows.
    expect(() =>
      CardsBook.restore(definition, reseal({ ...snapshot, settlementReason: 'HOUSE_CHOICE' })),
    ).toThrowError(
      expect.objectContaining({
        message: 'A system settlement records the reason it was taken under',
      }),
    );
  });

  it('refuses a system reason on a settlement the player took', async () => {
    const { book } = await stakedRound();
    const transcript = buildCardsTranscript(SEED, definition, ROUND, book.choices);
    await book.settle({
      idempotencyKey: 'settle',
      expectedStepRevision: 1,
      revealedSeed: SEED,
      transcript,
    });
    const snapshot = JSON.parse(book.serialize()) as Mutable;
    expect(snapshot.settlementReason).toBeNull();
    expect(() =>
      CardsBook.restore(definition, reseal({ ...snapshot, settlementReason: 'ROUND_DORMANT' })),
    ).toThrowError(
      expect.objectContaining({
        message: 'A settlement the player took records no system reason',
      }),
    );
  });

  it('refuses a dormant receipt on a definition that declares no policy', async () => {
    // The action exists in the module's list because one definition uses it,
    // which is exactly the case a snapshot store would reach for: a round of a
    // definition with no dormant path, carrying a receipt for one.
    const plain = triadMiddleReference;
    const { book } = await stakedRound(plain, seed(75), 'plain-round');
    const snapshot = JSON.parse(book.serialize()) as Mutable;
    const receipts = snapshot.receipts as { fingerprint: string; receipt: Mutable }[];
    const forged = reseal({
      ...snapshot,
      terminal: true,
      receipts: [
        ...receipts,
        {
          fingerprint: receipts[0]?.fingerprint as string,
          receipt: {
            ...(receipts[0]?.receipt as Mutable),
            action: 'settleDormant',
            ledgerRevision: receipts.length + 1,
            frameRevision: 1,
            debited: '0',
            credited: '0',
            balanceDelta: '0',
          },
        },
      ],
      ledgerRevision: receipts.length + 1,
    });
    expect(() => CardsBook.restore(plain, forged)).toThrowError(
      expect.objectContaining({ code: 'INVALID_SNAPSHOT' }),
    );
    // And the key itself is refused on a definition with no policy: the key set
    // is a function of the definition, not of the payload.
    expect(() =>
      CardsBook.restore(plain, reseal({ ...snapshot, settlementReason: null })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  it('is idempotent, and refuses a second settlement', async () => {
    const { book } = await stakedRound();
    const transcript = buildCardsTranscript(SEED, definition, ROUND, book.choices);
    const request = {
      idempotencyKey: 'dormant',
      expectedStepRevision: 1,
      revealedSeed: SEED,
      transcript,
      elapsedSeconds: WINDOW,
    } as const;
    const first = await book.settleDormant(request);
    const replay = await book.settleDormant(request);
    expect(replay).toEqual(first);
    expect(book.liquidBalance).toBe(first.credited);
    await expect(
      book.settle({
        idempotencyKey: 'settle-after',
        expectedStepRevision: 1,
        revealedSeed: SEED,
        transcript,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'ROUND_TERMINAL' }));
  });

  it('prices the dormant settlement from the frame the receipt claims', async () => {
    // The pairing the blocker of the previous round was about, on the branch
    // this round added: a settlement re-fenced to the pre-reveal belief would
    // liquidate a claim grown after the reveal at the price before it.
    const { book } = await stakedRound();
    const transcript = buildCardsTranscript(SEED, definition, ROUND, book.choices);
    await book.settleDormant({
      idempotencyKey: 'dormant',
      expectedStepRevision: 1,
      revealedSeed: SEED,
      transcript,
      elapsedSeconds: WINDOW,
    });
    const snapshot = JSON.parse(book.serialize()) as Mutable;
    const receipts = snapshot.receipts as { fingerprint: string; receipt: Mutable }[];
    const refenced = reseal({
      ...snapshot,
      receipts: receipts.map((entry) =>
        entry.receipt.action === 'settleDormant'
          ? { ...entry, receipt: { ...entry.receipt, frameRevision: 0 } }
          : entry,
      ),
    });
    expect(() => CardsBook.restore(definition, refenced)).toThrowError(
      expect.objectContaining({
        message: 'Receipt is fenced to a step revision the round was not standing at',
      }),
    );
  });

  it('refuses a dormant settlement on a round that never reached its first reveal', async () => {
    // The live command refuses this, and so must a snapshot of it: with no
    // reveal installed, a receipt fenced to revision 0 satisfies the frame rule
    // the previous round's blocker installed, so the only thing left to refuse
    // it is the rule that a system settlement needs a decidable board.
    const book = new CardsBook(definition);
    await book.open({
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId: ROUND,
      selections: [{ id: 'MIDDLE', kind: 'position', position: 0, stake: 25n }],
      roundingSeed: deriveRoundingSeed(SEED, cardsFingerprint(definition), ROUND),
    });
    const snapshot = JSON.parse(book.serialize()) as Mutable;
    const deal = deriveDeal(SEED, definition, ROUND);
    const transcript = buildCardsTranscript(SEED, definition, ROUND, book.choices);
    const record = {
      revealedSeed: SEED,
      commitment: transcript.commitment,
      objectiveRank: objectiveRankOf(definition, deal.ranks),
      objectivePosition: deal.ranks.indexOf(objectiveRankOf(definition, deal.ranks)),
    };
    const fingerprint = dormantFingerprint(stepDigest([]), {
      ...record,
      reason: 'ROUND_DORMANT',
    });
    const receipts = snapshot.receipts as { fingerprint: string; receipt: Mutable }[];
    const forged = reseal({
      ...snapshot,
      terminal: true,
      settlement: record,
      settlementReason: 'ROUND_DORMANT',
      receipts: [
        ...receipts,
        {
          fingerprint,
          receipt: {
            ...(receipts[0]?.receipt as Mutable),
            idempotencyKey: 'forged-dormant',
            commandFingerprint: fingerprint,
            action: 'settleDormant',
            ledgerRevision: receipts.length + 1,
            frameRevision: 0,
            debited: '0',
            credited: '0',
            balanceDelta: '0',
          },
        },
      ],
      ledgerRevision: receipts.length + 1,
      selections: (snapshot.selections as Mutable[]).map((row) => ({ ...row, status: 'settled' })),
    });
    expect(() => CardsBook.restore(definition, forged)).toThrowError(
      expect.objectContaining({
        message: 'A dormant settlement cannot precede the reveal that made the board decidable',
      }),
    );
  });

  it('never prices a dormant settlement above the claim it liquidates', async () => {
    // Swept rather than sampled: over sixteen seeds, every dormant settlement
    // credits no more than the whole claim the round was carrying, so the
    // reachable maximum `defineCardsGame` proves the cap against still bounds
    // this path.
    for (let index = 0; index < 16; index += 1) {
      const seedHex = seed(200 + index);
      const roundId = `dormant-sweep-${index}`;
      const { book } = await stakedRound(definition, seedHex, roundId);
      const rows = book.selections;
      const belief = cardsBelief(definition, book.steps);
      const ceiling = rows.reduce(
        (total, row) =>
          total +
          floorRational(
            row.kind === 'position'
              ? fairValue(definition, row.claim, coverProbability(belief, row.positions))
              : row.claim,
          ) +
          1n,
        0n,
      );
      const receipt = await book.settleDormant({
        idempotencyKey: 'dormant',
        expectedStepRevision: 1,
        revealedSeed: seedHex,
        transcript: buildCardsTranscript(seedHex, definition, roundId, book.choices),
        elapsedSeconds: WINDOW,
      });
      expect(receipt.credited).toBeLessThanOrEqual(ceiling);
      expect(receipt.credited).toBeGreaterThanOrEqual(0n);
      expect(CardsBook.restore(definition, book.serialize()).serialize()).toBe(book.serialize());
    }
  });

  it('refuses a dormancy policy the module cannot honour exactly', () => {
    const cases: readonly [string, unknown, string][] = [
      [
        'a window of zero seconds',
        { windowSeconds: 0, onDormant: 'cash', earlySettlementReasons: [] },
        'INVALID_DORMANCY_POLICY',
      ],
      [
        'a window past the module bound',
        { windowSeconds: 31_536_001, onDormant: 'cash', earlySettlementReasons: [] },
        'INVALID_DORMANCY_POLICY',
      ],
      [
        'a fractional window',
        { windowSeconds: 1.5, onDormant: 'cash', earlySettlementReasons: [] },
        'INVALID_DORMANCY_POLICY',
      ],
      [
        'a resolution that voids instead of paying',
        { windowSeconds: 60, onDormant: 'void', earlySettlementReasons: [] },
        'INVALID_DORMANCY_POLICY',
      ],
      [
        'a repeated early reason',
        {
          windowSeconds: 60,
          onDormant: 'cash',
          earlySettlementReasons: ['account-state-changed', 'account-state-changed'],
        },
        'INVALID_SETTLEMENT_REASON',
      ],
      [
        'an early reason the module does not know',
        { windowSeconds: 60, onDormant: 'cash', earlySettlementReasons: ['operator-discretion'] },
        'INVALID_SETTLEMENT_REASON',
      ],
      ['a policy that is not an object', 'yes', 'INVALID_DORMANCY_POLICY'],
    ];
    for (const [label, dormancy, reason] of cases)
      expect(
        () =>
          defineCardsGame({
            ...triadMiddleReference,
            id: 'dormancy-fault-v1',
            dormancy,
          } as never),
        label,
      ).toThrowError(
        expect.objectContaining({
          code: 'INVALID_ADAPTER',
          details: expect.objectContaining({ reason }),
        }),
      );
  });

  it('refuses a resolution the board does not offer in every decision state', () => {
    // `onDormant` must be an action the round would have offered, and that is
    // proved by walking the reachable states rather than by reading the action
    // list: a system settlement in a state with no price is a system settlement
    // that would have to invent one.
    expect(() =>
      defineCardsGame({
        ...triadMiddleReference,
        id: 'dormancy-unofferable-v1',
        pricing: { ...triadMiddleReference.pricing, actions: ['switch', 'split'] },
        dormancy: { windowSeconds: 60, onDormant: 'cash', earlySettlementReasons: [] },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVALID_ADAPTER',
        details: expect.objectContaining({ reason: 'ACTION_NOT_OFFERED' }),
      }),
    );
  });

  it('seals the policy into the fingerprint and nothing else', () => {
    // A definition with the policy and one without are different adapters, and
    // a definition without one is byte-identical to what this module sealed
    // before dormancy existed — which is why every pre-existing fixture still
    // matches.
    expect(cardsFingerprint(triadDormantReference)).not.toBe(
      cardsFingerprint(triadMiddleReference),
    );
    expect(cardsFingerprint(triadMiddleReference)).toBe(
      cardsFingerprint(defineCardsGame({ ...triadMiddleReference })),
    );
    expect('dormancy' in triadMiddleReference).toBe(false);
    // And a snapshot of a definition with no policy carries no trace of one.
    expect(
      Object.keys(new CardsBook(triadMiddleReference).snapshot()).includes('settlementReason'),
    ).toBe(false);
    expect(
      Object.keys(new CardsBook(triadDormantReference).snapshot()).includes('settlementReason'),
    ).toBe(true);
  });

  it('matches the committed dormant wire fixture field for field', async () => {
    // A dormancy-declaring definition writes one key nothing else writes and
    // mints a terminal receipt under a fingerprint that binds the reason. Both
    // are wire-format decisions, so both are frozen on disk rather than
    // round-tripped: a rebuilt round moves both sides of a round trip together
    // and would happily accept a changed encoding.
    const fixture = JSON.parse(
      readFileSync('tests/fixtures/cards-book-dormant-v1.json', 'utf8'),
    ) as Record<string, unknown>;
    const rebuilt = await buildFrozenDormantCardsRound();
    expect(fixture.snapshot).toEqual(JSON.parse(JSON.stringify(rebuilt.snapshot)));
    expect(fixture.receipts).toEqual(JSON.parse(JSON.stringify(rebuilt.receipts)));
    const snapshot = fixture.snapshot as Mutable;
    expect(Object.keys(snapshot)).toContain('settlementReason');
    expect(snapshot.settlementReason).toBe('ROUND_DORMANT');
    expect((fixture.receipts as { action: string }[]).map((entry) => entry.action)).toEqual([
      'open',
      'reveal',
      'switch',
      'settleDormant',
    ]);
    const restored = CardsBook.restore(frozenDormantDefinition, JSON.stringify(snapshot));
    expect(restored.terminal).toBe(true);
    expect(restored.settlementReason).toBe('ROUND_DORMANT');
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.liquidBalance).toBeLessThanOrEqual(
      125n * frozenDormantDefinition.risk.maxWinMultiple,
    );
  });

  it('keeps a dormant settlement inside the round cap', async () => {
    // The cap chain is the same one every credit goes through, so a dormant
    // settlement cannot be the path that escapes it. A 1x rail on a definition
    // that admits one makes the ceiling bite.
    const capped = defineCardsGame({
      ...triadMiddleReference,
      id: 'dormant-capped-v1',
      risk: { maxWinMultiple: 2n, capMustNotBind: false },
      dormancy: { windowSeconds: 60, onDormant: 'cash', earlySettlementReasons: [] },
    });
    const { book } = await stakedRound(capped, seed(76), 'dormant-capped-round');
    const receipt = await book.settleDormant({
      idempotencyKey: 'dormant',
      expectedStepRevision: 1,
      revealedSeed: seed(76),
      transcript: buildCardsTranscript(seed(76), capped, 'dormant-capped-round', book.choices),
      elapsedSeconds: 60,
    });
    const basis = book.capBasisStake as bigint;
    expect(receipt.credited).toBeLessThanOrEqual(basis * capped.risk.maxWinMultiple);
    expect(CardsBook.restore(capped, book.serialize()).serialize()).toBe(book.serialize());
    expect(rational(receipt.credited).denominator).toBe(1n);
  });
});
