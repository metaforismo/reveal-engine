import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RevealEngineError } from '../../src/api/errors.js';
import { snapshotHash } from '../../src/core/snapshot.js';
import { floor as floorRational, multiply, rational } from '../../src/core/rational.js';
import { cardsFingerprint, defineCardsGame } from '../../src/modules/sequential-cards/adapter.js';
import {
  convertToCredits,
  creditDraw,
  creditsFromDraw,
  deriveRoundingSeed,
  roundingCommitment,
} from '../../src/modules/sequential-cards/credits.js';
import { cardsRoundOf } from '../../src/modules/sequential-cards/adapter.js';
import { coverProbability, fairValue } from '../../src/modules/sequential-cards/pricing.js';
import { cardsBelief } from '../../src/modules/sequential-cards/deck.js';
import {
  triadDormantReference,
  triadMiddleReference,
  triadStochasticReference,
} from '../../src/modules/sequential-cards/references.js';
import { CardsBook, openFingerprint } from '../../src/modules/sequential-cards/round-book.js';
import { deriveRevealSteps } from '../../src/modules/sequential-cards/steps.js';
import { deriveDeal } from '../../src/modules/sequential-cards/truth.js';
import { buildCardsTranscript } from '../../src/modules/sequential-cards/transcript.js';
import { analyseDefinition } from '../../src/modules/sequential-cards/analysis.js';
import type { RevealStep } from '../../src/modules/sequential-cards/contracts.js';
import { seed } from '../helpers.js';
import { cardsAdmission } from '../support/cards-admission.js';

/**
 * `pricing.rounding: 'stochastic'`, which `triad/docs/ENGINE.md` §4.1 declares
 * and `triad/docs/MATH.md` §13.3 argues for.
 *
 * The claim is that a credit of `q + r/d` pays `q + 1` with probability exactly
 * `r/d`, drawn from committed randomness, so the realised return in credits
 * equals the exact return at every stake and under every policy. Three things
 * have to hold for that to be more than a slogan, and each is a case below: the
 * draw is a deterministic function of the sealed seed and re-derives; the round
 * cannot be credited from a tape the seed does not produce; and the extra credit
 * is inside the cap the definition was accepted against.
 */
const stochastic = triadStochasticReference;
const ROUND = 'draw-round';
const SEED = seed(11);

function tapeFor(
  roundId: string,
  seedHex = SEED,
): {
  readonly roundingSeed: string;
  readonly round: ReturnType<typeof cardsRoundOf>;
} {
  return {
    roundingSeed: deriveRoundingSeed(seedHex, cardsFingerprint(stochastic), roundId),
    round: cardsRoundOf(stochastic, roundId),
  };
}

async function revealedRound(roundId: string, stake: bigint): Promise<CardsBook> {
  const book = new CardsBook(stochastic);
  await book.open({
    idempotencyKey: 'open',
    expectedStepRevision: 0,
    roundId,
    ...cardsAdmission(stochastic, SEED, roundId),
    selections: [
      { id: 'MIDDLE', kind: 'position', position: 0, stake },
      { id: 'BAND', kind: 'market', marketId: 'BAND:CORE', stake: 25n },
    ],
    roundingSeed: tapeFor(roundId).roundingSeed,
  });
  const deal = deriveDeal(SEED, stochastic, roundId);
  const step = deriveRevealSteps(stochastic, deal, book.choices)[0] as RevealStep;
  await book.advanceReveal({ idempotencyKey: 'reveal', expectedStepRevision: 0, step });
  return book;
}

describe('sequential-cards: the settlement draw', () => {
  it('requires the tape its declared economics need, and refuses one it does not', async () => {
    const withoutTape = new CardsBook(stochastic);
    await expect(
      withoutTape.open({
        idempotencyKey: 'open',
        expectedStepRevision: 0,
        roundId: ROUND,
        ...cardsAdmission(stochastic, SEED, ROUND),
        selections: [{ id: 'MIDDLE', kind: 'position', position: 0, stake: 25n }],
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'CLAIM_REJECTED',
        details: expect.objectContaining({ reason: 'INVALID_ROUNDING_POLICY' }),
      }),
    );

    // The converse, because a silent fallback in either direction would pay an
    // economics the definition fingerprint does not describe.
    const deterministic = new CardsBook(triadMiddleReference);
    await expect(
      deterministic.open({
        idempotencyKey: 'open',
        expectedStepRevision: 0,
        roundId: ROUND,
        ...cardsAdmission(triadMiddleReference, SEED, ROUND),
        selections: [{ id: 'MIDDLE', kind: 'position', position: 0, stake: 25n }],
        roundingSeed: tapeFor(ROUND).roundingSeed,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'INVALID_ROUNDING_POLICY' }),
      }),
    );
  });

  it('credits a cash-out from the committed draw, and the draw re-derives', async () => {
    // 110 is on no lattice this definition declares for a *ticket*, so it is set
    // through a round whose stake is a legal multiple and whose claim still
    // carries a fractional part after the reveal — which is where the draw lives.
    const book = await revealedRound(`${ROUND}-cash`, 25n);
    if (!book.offers('MIDDLE').includes('cash')) throw new Error('the fixture needs a cash-out');
    const claim = book.selections[0]?.claim;
    const value = fairValue(
      stochastic,
      claim as ReturnType<typeof rational>,
      coverProbability(book.belief(), book.selections[0]?.positions ?? []),
    );
    const whole = floorRational(value);
    const receipt = await book.cash({
      idempotencyKey: 'cash',
      expectedStepRevision: 1,
      selectionId: 'MIDDLE',
    });

    // Re-derived independently of the book: the same tape, the same event, the
    // same denominator, and the same comparison.
    const tape = tapeFor(`${ROUND}-cash`);
    const remainder = value.numerator - whole * value.denominator;
    const expected =
      remainder === 0n
        ? whole
        : creditsFromDraw(
            value,
            creditDraw(tape, { selectionId: 'MIDDLE', sequence: 3 }, value.denominator),
          );
    expect(receipt.credited).toBe(expected);
    expect(receipt.credited === whole || receipt.credited === whole + 1n).toBe(true);
    expect(book.liquidBalance).toBe(expected);

    // And it is a *choice*, not a constant: the same claim under a different
    // round id is a different event and can credit the other way.
    expect(
      convertToCredits(stochastic, value, { selectionId: 'MIDDLE', sequence: 3 }, tape).credits,
    ).toBe(expected);
  });

  it('refuses a settlement whose tape does not derive from the revealed seed', async () => {
    const roundId = `${ROUND}-settle`;
    const book = new CardsBook(stochastic);
    await book.open({
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId,
      ...cardsAdmission(stochastic, SEED, roundId),
      selections: [{ id: 'MIDDLE', kind: 'position', position: 0, stake: 25n }],
      // A tape from another round: every draw it produces is a legal uniform
      // integer, and none of them is the one this round committed to.
      roundingSeed: tapeFor('some-other-round').roundingSeed,
    });
    const deal = deriveDeal(SEED, stochastic, roundId);
    const step = deriveRevealSteps(stochastic, deal, book.choices)[0] as RevealStep;
    await book.advanceReveal({ idempotencyKey: 'reveal', expectedStepRevision: 0, step });
    await expect(
      book.settle({
        idempotencyKey: 'settle',
        expectedStepRevision: 1,
        revealedSeed: SEED,
        transcript: buildCardsTranscript(SEED, stochastic, roundId, book.choices),
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'TRANSCRIPT_MISMATCH' }));
  });

  it('restores a drawn round, and refuses one whose tape was swapped', async () => {
    const roundId = `${ROUND}-restore`;
    const book = await revealedRound(roundId, 25n);
    if (book.offers('MIDDLE').includes('cash'))
      await book.cash({ idempotencyKey: 'cash', expectedStepRevision: 1, selectionId: 'MIDDLE' });
    const restored = CardsBook.restore(stochastic, book.serialize(), book.publishedRound ?? null);
    expect(restored.snapshot()).toEqual(book.snapshot());
    expect(restored.liquidBalance).toBe(book.liquidBalance);

    const snapshot = JSON.parse(book.serialize()) as Record<string, unknown>;
    expect(typeof snapshot.roundingSeed).toBe('string');
    const reseal = (value: Record<string, unknown>): string =>
      JSON.stringify({
        ...value,
        snapshotHash: snapshotHash({ ...value, snapshotHash: undefined }),
      });

    // The open receipt binds a commitment to the tape, so a snapshot cannot
    // quietly credit from a tape whose draws pay better.
    expect(() =>
      CardsBook.restore(
        stochastic,
        reseal({ ...snapshot, roundingSeed: tapeFor('a-different-round').roundingSeed }),
        book.publishedRound ?? null,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
    // And a snapshot with no tape at all is not a round this definition played.
    const { roundingSeed: _dropped, ...tapeless } = snapshot;
    expect(() =>
      CardsBook.restore(stochastic, reseal(tapeless), book.publishedRound ?? null),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  it('keeps the deterministic wire format exactly as it was', async () => {
    // The key set is a function of the definition, not of the payload: a floor
    // snapshot that presents a tape is refused, and so is a stochastic one that
    // does not. That is what lets `cards-book-v1` mean one thing under each rule.
    const floorBook = new CardsBook(triadMiddleReference);
    await floorBook.open({
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId: 'floor-round',
      ...cardsAdmission(triadMiddleReference, SEED, 'floor-round'),
      selections: [{ id: 'MIDDLE', kind: 'position', position: 0, stake: 25n }],
    });
    const snapshot = JSON.parse(floorBook.serialize()) as Record<string, unknown>;
    expect('roundingSeed' in snapshot).toBe(false);
    expect(() =>
      CardsBook.restore(
        triadMiddleReference,
        JSON.stringify({
          ...snapshot,
          roundingSeed: tapeFor('floor-round').roundingSeed,
          snapshotHash: snapshotHash({
            ...snapshot,
            roundingSeed: tapeFor('floor-round').roundingSeed,
            snapshotHash: undefined,
          }),
        }),
        floorBook.publishedRound ?? null,
      ),
    ).toThrowError(RevealEngineError);
  });

  it('leaves the cap headroom the definition was accepted against', () => {
    const analysis = analyseDefinition(stochastic);
    // The claim ceiling is unchanged; the *credit* ceiling gains exactly one
    // credit at the minimum stake, which is where it is proportionally largest.
    expect(analysis.maxPayoutMultiple).toEqual(rational(648n, 5n));
    expect(analysis.creditCeilingMultiple).toEqual(rational(3241n, 25n));
    expect(analyseDefinition(triadMiddleReference).creditCeilingMultiple).toEqual(
      rational(648n, 5n),
    );
    // 129.64x against a 200x rail, so `triad-stochastic-v1` is accepted for the
    // same reason `triad-middle-v1` is, with the draw's credit inside it.
    expect(analysis.creditCeilingMultiple.numerator).toBeLessThan(
      analysis.creditCeilingMultiple.denominator * stochastic.risk.maxWinMultiple,
    );
  });

  it('measures the cap against the credited amount, not the claim', () => {
    // At a 25-credit minimum the extra credit is 1/25 of a stake, which no
    // integer rail can separate from the claim ceiling — so the discrimination
    // is shown on a shape where it can be: no in-round actions, so the only
    // payout is the entry claim, and a one-credit minimum, which makes the
    // draw's extra credit a whole multiple of stake.
    const draft = {
      ...triadMiddleReference,
      id: 'cap-probe-floor-v1',
      pricing: {
        ...triadMiddleReference.pricing,
        actions: [] as readonly ('switch' | 'split' | 'cash')[],
        minStakeCredits: 1n,
        stakeStepCredits: 1n,
      },
      risk: { maxWinMultiple: 100_000n, capMustNotBind: false },
    };
    const probe = defineCardsGame(draft);
    const ceiling = analyseDefinition(probe).maxPayoutMultiple;
    // The smallest integer rail the claim ceiling clears.
    const rail =
      (ceiling.numerator + ceiling.denominator - 1n) / ceiling.denominator +
      (ceiling.numerator % ceiling.denominator === 0n ? 1n : 0n);

    expect(() =>
      defineCardsGame({
        ...draft,
        id: 'cap-probe-floor-tight-v1',
        risk: { maxWinMultiple: rail, capMustNotBind: true },
      }),
    ).not.toThrow();
    // The same rail, the same claims, and one extra credit per credit event:
    // refused, because the cap has to bound what a player is credited.
    expect(() =>
      defineCardsGame({
        ...draft,
        id: 'cap-probe-draw-tight-v1',
        pricing: { ...draft.pricing, rounding: 'stochastic' as const },
        risk: { maxWinMultiple: rail, capMustNotBind: true },
      }),
    ).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'CAP_WOULD_BIND' }) }),
    );
  });

  it('matches the committed stochastic wire fixture field for field', () => {
    const fixture = JSON.parse(
      readFileSync('tests/fixtures/cards-book-stochastic-v2.json', 'utf8'),
    ) as Record<string, unknown>;
    const snapshot = fixture.snapshot as Record<string, unknown>;
    expect(snapshot.schema).toBe('reveal-engine/cards-book-v2');
    expect(Object.keys(snapshot)).toContain('roundingSeed');
    expect(snapshot.definition).toMatchObject({
      id: 'triad-stochastic-v1',
      fingerprint: cardsFingerprint(stochastic),
    });
    // The tape on the wire is the one the frozen seed produces, and the round
    // restores from the committed bytes with every credit re-derived.
    expect(snapshot.roundingSeed).toBe(
      deriveRoundingSeed(
        `${'00'.repeat(31)}2a`,
        cardsFingerprint(stochastic),
        fixture.roundId as string,
      ),
    );
    expect(roundingCommitment(snapshot.roundingSeed as string)).toMatch(/^[0-9a-f]{64}$/u);
    const restored = CardsBook.restore(stochastic, JSON.stringify(snapshot), {
      roundId: snapshot.roundId as string,
      seedCommitment: snapshot.seedCommitment as string,
    });
    expect(restored.terminal).toBe(true);
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.liquidBalance).toBeLessThanOrEqual(125n * stochastic.risk.maxWinMultiple);
  });

  it('pays the same claim differently across rounds, and averages onto it exactly', () => {
    // Not a statistical test: the mean below is exact, because the whole draw
    // space of the claim is swept rather than sampled. What the rounds add is
    // that the draw really varies with the event — a conversion that ignored the
    // tape would credit the same integer every time and still pass an
    // expectation computed from its own comparison.
    const claim = multiply(rational(1000n), rational(12n, 11n));
    const whole = floorRational(claim);
    const remainder = claim.numerator - whole * claim.denominator;
    let extras = 0;
    for (let index = 0; index < 40; index += 1) {
      const credits = convertToCredits(
        stochastic,
        claim,
        { selectionId: 'MIDDLE', sequence: index },
        tapeFor(`spread-${index}`),
      ).credits;
      expect(credits === whole || credits === whole + 1n).toBe(true);
      if (credits === whole + 1n) extras += 1;
    }
    expect(extras).toBeGreaterThan(0);
    expect(extras).toBeLessThan(40);

    let paying = 0n;
    for (let draw = 0n; draw < claim.denominator; draw += 1n)
      if (creditsFromDraw(claim, draw) === whole + 1n) paying += 1n;
    expect(paying).toBe(remainder);
    expect(whole * claim.denominator + paying).toBe(claim.numerator);
  });

  /**
   * `triad/docs/ENGINE.md` §4.1's worked definition, verbatim, minus the one
   * field this module refuses by name.
   *
   * §12.1 of the module doc claims that the consuming game's §4.1 definition now
   * constructs **as written**. That is a claim about somebody else's document,
   * so it is checked rather than asserted: the declaration below is transcribed
   * from the spec with nothing removed — `dormancy` included, which an earlier
   * revision of this test had to delete to get a definition to build — and if a
   * future revision narrows anything it declares, the rounding rule, the stake
   * lattice, the action list, the cap or the dormancy policy, this stops
   * constructing.
   */
  it("constructs the consuming game's own declared definition", () => {
    const triad = defineCardsGame({
      apiVersion: stochastic.apiVersion,
      moduleId: 'sequential-cards',
      id: 'triad-v1',
      version: '1.0.0',
      ladder: { size: 13, dealt: 3, objective: 'middle' },
      reveal: {
        modelVersion: 'triad-cut/v1',
        count: 1,
        eligibility: 'unbacked',
        sortRemaining: true,
      },
      backing: { maxOpenBeforeReveal: 1, rebackMode: 'move' },
      sideMarkets: [
        { id: 'BAND:LOW', winningRanks: [2, 3, 4, 5] },
        { id: 'BAND:CORE', winningRanks: [6, 7, 8] },
        { id: 'BAND:HIGH', winningRanks: [9, 10, 11, 12] },
        ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((rank) => ({
          id: `EXACT:${rank}`,
          winningRanks: [rank],
        })),
      ],
      ticket: { requiresBackedMarket: true, stakeScope: 'per-selection' },
      pricing: {
        entryRtp: rational(24n, 25n),
        liquidationSpread: rational(0n),
        rounding: 'stochastic',
        minStakeCredits: 25n,
        stakeStepCredits: 25n,
        actions: ['switch', 'split', 'cash'],
        splitMode: 'even',
      },
      risk: { maxWinMultiple: 200n, capMustNotBind: true },
      seed: { operatorSeedScope: 'per-round', clientEntropy: 'required', clientSeedBytes: 16 },
      dormancy: {
        windowSeconds: 86_400,
        onDormant: 'cash',
        earlySettlementReasons: ['account-state-changed'],
      },
    });
    const analysis = analyseDefinition(triad);
    expect(analysis.bestPolicyReturn).toEqual(rational(24n, 25n));
    expect(analysis.worstPolicyReturn).toEqual(rational(24n, 25n));
    expect(analysis.minStakeThreshold).toBe(25n);
    expect(analysis.nonZeroCreditThreshold).toBe(23n);
    // Every declared field survived into the frozen definition, and the whole
    // spec-shaped declaration is the reference this module ships: two
    // definitions that agree field for field are one adapter.
    expect(triad.dormancy).toEqual({
      windowSeconds: 86_400,
      onDormant: 'cash',
      earlySettlementReasons: ['account-state-changed'],
    });
    expect(cardsFingerprint({ ...triad, id: triadDormantReference.id })).toBe(
      cardsFingerprint(triadDormantReference),
    );
  });
});

/**
 * The residual §6.3 names, pinned as a **checked** claim rather than a caveat.
 *
 * Receipt fingerprints and the snapshot checksum are unkeyed, so a store that
 * can rewrite the rounding tape can rewrite the open receipt that commits to it
 * and every credit that came out of it. §6.3 says so and bounds it — one credit
 * per credit event, and only until settlement re-derives the tape from the
 * revealed seed. A test that only demonstrated refusals would leave that
 * sentence unchecked, and a future revision that closed the gap would leave the
 * documentation overstating the boundary in the other direction.
 */
describe('sequential-cards: the rounding tape is a pre-settlement residual', () => {
  it('a coordinated rewrite of the tape and its receipts restores, and settlement refuses it', async () => {
    const roundId = 'tape-residual';
    const book = new CardsBook(stochastic);
    await book.open({
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId,
      ...cardsAdmission(stochastic, SEED, roundId),
      selections: [{ id: 'MIDDLE', kind: 'position', position: 0, stake: 25n }],
      roundingSeed: tapeFor(roundId).roundingSeed,
    });
    const deal = deriveDeal(SEED, stochastic, roundId);
    const step = deriveRevealSteps(stochastic, deal, book.choices)[0] as RevealStep;
    await book.advanceReveal({ idempotencyKey: 'reveal', expectedStepRevision: 0, step });
    if (!book.offers('MIDDLE').includes('cash')) throw new Error('the fixture needs a cash-out');
    await book.cash({ idempotencyKey: 'cash', expectedStepRevision: 1, selectionId: 'MIDDLE' });

    const snapshot = JSON.parse(book.serialize()) as Record<string, unknown>;
    const selection = book.selections[0];
    const value = fairValue(
      stochastic,
      selection?.claim as ReturnType<typeof rational>,
      coverProbability(cardsBelief(stochastic, [step]), selection?.positions ?? []),
    );
    const whole = floorRational(value);

    // A tape whose draw pays the extra credit on this exact claim, found by
    // walking round ids rather than by inverting anything: the tape is a hash,
    // and an attacker who can rewrite the store can also try 20 of them.
    let better: string | undefined;
    for (let index = 0; index < 64 && better === undefined; index += 1) {
      const candidate = tapeFor(`forged-${index}`, SEED).roundingSeed;
      const credits = convertToCredits(
        stochastic,
        value,
        { selectionId: 'MIDDLE', sequence: 3 },
        { roundingSeed: candidate, round: cardsRoundOf(stochastic, roundId) },
      ).credits;
      if (credits === whole + 1n) better = candidate;
    }
    if (better === undefined) throw new Error('no candidate tape paid the extra credit');

    const rows = [{ id: 'MIDDLE', kind: 'position' as const, position: 0, stake: 25n }];
    const openFp = openFingerprint(
      roundId,
      rows,
      roundingCommitment(better),
      snapshot.seedCommitment as string,
      snapshot.clientSeed as string,
    );
    const receipts = (
      snapshot.receipts as { fingerprint: string; receipt: Record<string, unknown> }[]
    ).map((entry) =>
      entry.receipt.action === 'open'
        ? {
            fingerprint: openFp,
            receipt: { ...entry.receipt, commandFingerprint: openFp },
          }
        : entry.receipt.action === 'cash'
          ? {
              ...entry,
              receipt: {
                ...entry.receipt,
                credited: String(whole + 1n),
                balanceDelta: String(whole + 1n),
              },
            }
          : entry,
    );
    const forged = {
      ...snapshot,
      roundingSeed: better,
      receipts,
      liquidBalance: String(whole + 1n),
      selections: (snapshot.selections as Record<string, unknown>[]).map((row) => ({
        ...row,
        credited: String(whole + 1n),
      })),
    };
    const sealed = JSON.stringify({
      ...forged,
      snapshotHash: snapshotHash({ ...forged, snapshotHash: undefined }),
    });

    // It restores. That is the residual, and it is worth exactly one credit.
    const restored = CardsBook.restore(stochastic, sealed, book.publishedRound ?? null);
    expect(restored.liquidBalance).toBe(whole + 1n);
    expect(restored.liquidBalance - book.liquidBalance).toBe(1n);

    // And it dies at settlement, because the tape does not derive from the seed.
    await expect(
      restored.settle({
        idempotencyKey: 'settle',
        expectedStepRevision: 1,
        revealedSeed: SEED,
        transcript: buildCardsTranscript(SEED, stochastic, roundId, restored.choices),
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'TRANSCRIPT_MISMATCH' }));
  });
});
