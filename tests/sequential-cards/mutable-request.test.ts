import { describe, expect, it } from 'vitest';
import { deriveDeal } from '../../src/modules/sequential-cards/truth.js';
import { deriveRevealSteps } from '../../src/modules/sequential-cards/steps.js';
import {
  triadDormantReference,
  triadMiddleReference,
} from '../../src/modules/sequential-cards/references.js';
import { cardsFingerprint } from '../../src/modules/sequential-cards/adapter.js';
import { deriveRoundingSeed } from '../../src/modules/sequential-cards/credits.js';
import { buildCardsTranscript } from '../../src/modules/sequential-cards/transcript.js';
import { CardsBook } from '../../src/modules/sequential-cards/round-book.js';
import type { RevealStep } from '../../src/modules/sequential-cards/contracts.js';
import { seed } from '../helpers.js';
import { cardsAdmission } from '../support/cards-admission.js';

const definition = triadMiddleReference;
const dormant = triadDormantReference;
const SEED = seed(77);

/**
 * The request object belongs to the caller, and the caller keeps writing to it.
 *
 * `CommandLedger.execute` serialises every command behind an `await`, so the
 * body of a command runs on a **later microtask** than the validation that
 * guarded it. Anything the book re-reads from the request after that point is a
 * value nobody validated and nobody fingerprinted: the price, the debit, the
 * stored selection and the receipt would then be functions of four different
 * reads of one field. The rule the book holds to is read once, validate the
 * read, and use only the read — and these are the tests that hold it there.
 *
 * The two shapes below are the two ways a caller can move a value under the
 * command: a plain object mutated synchronously while the promise is pending
 * (which needs no exotic input at all — an RGS that pools request objects would
 * do it by accident), and an accessor that answers differently on a later read.
 */
describe('sequential-cards: a command prices what it validated', () => {
  const openWith = async (
    book: CardsBook,
    selections: readonly unknown[],
    roundId: string,
  ): Promise<Awaited<ReturnType<CardsBook['open']>>> =>
    book.open({
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId,
      ...cardsAdmission(dormant, SEED, roundId),
      ...cardsAdmission(definition, seed(1), roundId),
      selections: selections as never,
    });

  it('ignores a ticket row mutated while the open command is pending', async () => {
    const row = { id: 'a', kind: 'position' as const, position: 0, stake: 25n };
    const book = new CardsBook(definition);
    const pending = openWith(book, [row], 'mutable-open');
    // Plain data, mutated in place, synchronously, before the awaited command
    // body runs. No accessors and no proxies: an RGS that pools or normalises
    // request objects would do exactly this by accident.
    row.stake = 1_000_000_000n;
    row.position = 2;
    const receipt = await pending;
    const selection = book.selections[0];

    expect(receipt.debited).toBe(25n);
    expect(book.capBasisStake).toBe(25n);
    expect(selection?.stake).toBe(25n);
    expect(selection?.openedPosition).toBe(0);
    // 25 credits at 24/25 RTP on a 1/3 prior: 25 · (24/25) / (1/3) = 72.
    expect(selection?.claim).toEqual({ numerator: 72n, denominator: 1n });
    // The receipt fingerprints what the round actually holds, so it reconnects.
    expect(() =>
      CardsBook.restore(definition, book.serialize(), book.publishedRound ?? null),
    ).not.toThrow();
  });

  it('reads each ticket field exactly once, however the row answers', async () => {
    let stakeReads = 0;
    let positionReads = 0;
    const row = {
      id: 'a',
      kind: 'position' as const,
      get stake(): bigint {
        stakeReads += 1;
        // Honest for the first read, inflated on every read after it.
        return stakeReads === 1 ? 25n : 1_000_000_000n;
      },
      get position(): number {
        positionReads += 1;
        return positionReads === 1 ? 0 : 2;
      },
    };
    const book = new CardsBook(definition);
    const receipt = await openWith(book, [row], 'accessor-open');

    expect(stakeReads).toBe(1);
    expect(positionReads).toBe(1);
    expect(receipt.debited).toBe(25n);
    expect(book.selections[0]?.stake).toBe(25n);
    expect(book.selections[0]?.claim).toEqual({ numerator: 72n, denominator: 1n });
    expect(() =>
      CardsBook.restore(definition, book.serialize(), book.publishedRound ?? null),
    ).not.toThrow();
  });

  it('stores the reveal it fingerprinted, not the one the caller kept editing', async () => {
    const roundId = 'mutable-reveal';
    const book = new CardsBook(definition);
    await openWith(book, [{ id: 'a', kind: 'position', position: 0, stake: 25n }], roundId);
    const deal = deriveDeal(SEED, definition, roundId);
    const honest = deriveRevealSteps(definition, deal, book.choices)[0] as RevealStep;
    const step = { ...honest, sorted: [...honest.sorted] };

    const pending = book.advanceReveal({
      idempotencyKey: 'reveal',
      expectedStepRevision: 0,
      step: step as RevealStep,
    });
    step.rank = (honest.rank % definition.ladder.size) + 1;
    step.sorted.reverse();
    await pending;

    expect(book.steps[0]?.rank).toBe(honest.rank);
    expect(book.steps[0]?.sorted).toEqual(honest.sorted);
    // ADR 0005 Decision 2 made a reveal a ledger command so the board could not
    // say something the receipts had not signed. This is that property.
    expect(() =>
      CardsBook.restore(definition, book.serialize(), book.publishedRound ?? null),
    ).not.toThrow();
  });

  it('stores the cover it fingerprinted when the target array is rewritten', async () => {
    const roundId = 'mutable-switch';
    const book = new CardsBook(definition);
    await openWith(book, [{ id: 'a', kind: 'position', position: 0, stake: 25n }], roundId);
    const deal = deriveDeal(SEED, definition, roundId);
    const step = deriveRevealSteps(definition, deal, book.choices)[0] as RevealStep;
    await book.advanceReveal({ idempotencyKey: 'reveal', expectedStepRevision: 0, step });

    const belief = book.belief();
    const targets = belief.record.hidden.filter(
      (position) => position !== 0 && (belief.positionWeights[position] as bigint) > 0n,
    );
    if (targets.length === 0) throw new Error('the fixture needs a live switch target');
    const target = targets[0] as number;
    const positions = [target];
    const pending = book.switchClaim({
      idempotencyKey: 'switch',
      expectedStepRevision: 1,
      selectionId: 'a',
      positions,
    });
    positions[0] = step.position;
    await pending;

    expect(book.selections[0]?.positions).toEqual([target]);
    expect(book.decisions[0]?.positions).toEqual([target]);
    expect(() =>
      CardsBook.restore(definition, book.serialize(), book.publishedRound ?? null),
    ).not.toThrow();
  });

  it('settles dormant on the window it validated, not the one the caller rewrote', async () => {
    // The dormant path adds two fields the caller owns and the module cannot
    // re-derive — the measured seconds and the early reason — so both are read
    // once, before the ledger's `await`, and only the reads are used. A request
    // that clears the window and then rewrites itself must not settle a round
    // the module refused, and one refused before the window must leave the
    // round exactly as it found it.
    const roundId = 'mutable-dormant';
    const book = new CardsBook(dormant);
    await book.open({
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId,
      ...cardsAdmission(dormant, SEED, roundId),
      selections: [{ id: 'a', kind: 'position', position: 0, stake: 25n }],
      roundingSeed: deriveRoundingSeed(SEED, cardsFingerprint(dormant), roundId),
    });
    const deal = deriveDeal(SEED, dormant, roundId);
    const step = deriveRevealSteps(dormant, deal, book.choices)[0] as RevealStep;
    await book.advanceReveal({ idempotencyKey: 'reveal', expectedStepRevision: 0, step });

    const window = dormant.dormancy?.windowSeconds as number;
    const request: Record<string, unknown> = {
      idempotencyKey: 'dormant',
      expectedStepRevision: 1,
      revealedSeed: SEED,
      transcript: buildCardsTranscript(SEED, dormant, roundId, book.choices),
      elapsedSeconds: window,
    };
    const pending = book.settleDormant(request as never);
    // Moved under the pending command: neither may change what settles.
    request.elapsedSeconds = 0;
    request.reason = 'account-state-changed';
    await pending;
    expect(book.settlementReason).toBe('ROUND_DORMANT');
    expect(() =>
      CardsBook.restore(dormant, book.serialize(), book.publishedRound ?? null),
    ).not.toThrow();

    // And the refusal leaves nothing behind: a second round refused a second
    // short of the window is untouched, whatever the request says afterwards.
    const second = new CardsBook(dormant);
    await second.open({
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId: `${roundId}-2`,
      ...cardsAdmission(dormant, SEED, `${roundId}-2`),
      selections: [{ id: 'a', kind: 'position', position: 0, stake: 25n }],
      roundingSeed: deriveRoundingSeed(SEED, cardsFingerprint(dormant), `${roundId}-2`),
    });
    const secondDeal = deriveDeal(SEED, dormant, `${roundId}-2`);
    const secondStep = deriveRevealSteps(dormant, secondDeal, second.choices)[0] as RevealStep;
    await second.advanceReveal({
      idempotencyKey: 'reveal',
      expectedStepRevision: 0,
      step: secondStep,
    });
    const early: Record<string, unknown> = {
      idempotencyKey: 'dormant',
      expectedStepRevision: 1,
      revealedSeed: SEED,
      transcript: buildCardsTranscript(SEED, dormant, `${roundId}-2`, second.choices),
      elapsedSeconds: window - 1,
    };
    await expect(second.settleDormant(early as never)).rejects.toThrowError();
    early.elapsedSeconds = window;
    expect(second.terminal).toBe(false);
    expect(second.liquidBalance).toBe(0n);
    expect(second.settlementReason).toBeNull();
  });
});
