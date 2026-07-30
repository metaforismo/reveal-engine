import { describe, expect, it } from 'vitest';
import { defineGame } from '../src/modules/progressive-market/adapter.js';
import { makeTranscript } from '../src/modules/progressive-market/fairness.js';
import { initialPosterior } from '../src/modules/progressive-market/posterior.js';
import { rational } from '../src/core/rational.js';
import { RoundBook } from '../src/modules/progressive-market/round-book.js';
import {
  binaryBeaconReference,
  constellationReference,
} from '../src/modules/progressive-market/references/index.js';
import { advanceAll, completedBook, seed } from './helpers.js';

describe('protocol accounting and exact claims', () => {
  it('keeps contingent payout exact until settlement', async () => {
    const transcript = makeTranscript(seed(1), constellationReference, 'exact');
    const book = new RoundBook(constellationReference, initialPosterior(constellationReference), {
      roundId: transcript.context.roundId,
      commitment: transcript.commitment,
    });
    await book.open({ idempotencyKey: 'open', expectedFrameRevision: 0, outcome: 0, stake: 1n });
    expect(book.position?.contingentPayout).toEqual(rational(97n, 50n));
  });

  it('charges the first-entry margin once and keeps re-entry unshaded', async () => {
    const transcript = makeTranscript(seed(2), constellationReference, 're-entry');
    const book = new RoundBook(constellationReference, initialPosterior(constellationReference), {
      roundId: transcript.context.roundId,
      commitment: transcript.commitment,
    });
    const open = await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 0,
      outcome: 0,
      stake: 1000n,
    });
    const sold = await book.sell({ idempotencyKey: 'sell', expectedFrameRevision: 0 });
    expect(open.debited).toBe(1000n);
    expect(sold.credited).toBe(967n);
    const reentry = await book.open({
      idempotencyKey: 'reopen',
      expectedFrameRevision: 0,
      outcome: 0,
      stake: sold.credited,
    });
    expect(reentry.debited).toBe(967n);
    expect(book.position?.contingentPayout).toEqual(rational(1934n));
    expect(book.position?.capBasisStake).toBe(1000n);
  });

  it('preserves chain cap basis and cannot bypass max win through sell/re-entry', async () => {
    const game = defineGame({
      ...constellationReference,
      adapterVersion: 'cap-test',
      risk: { maxWinMultiple: 1n },
    });
    const seedHex = seed(13);
    const transcript = makeTranscript(seedHex, game, 'cap-chain');
    const book = new RoundBook(game, initialPosterior(game), {
      roundId: transcript.context.roundId,
      commitment: transcript.commitment,
    });
    const pickedTruth = transcript.truth;
    await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 0,
      outcome: pickedTruth,
      stake: 100n,
    });
    const sell = await book.sell({ idempotencyKey: 'sell', expectedFrameRevision: 0 });
    await book.open({
      idempotencyKey: 'reopen',
      expectedFrameRevision: 0,
      outcome: pickedTruth,
      stake: sell.credited,
    });
    await advanceAll(book, transcript);
    const settlement = await book.settle({
      idempotencyKey: 'settle',
      expectedFrameRevision: transcript.evidence.length,
      revealedSeed: seedHex,
      transcript,
    });
    expect(book.liquidBalance).toBeLessThanOrEqual(100n);
    expect(settlement.capped || book.liquidBalance < 100n).toBe(true);
  });

  it('conserves debits and credits under exact retries', async () => {
    const { book, transcript } = await completedBook(binaryBeaconReference, seed(4), 'accounting');
    const open = await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: book.frame.revision,
      outcome: transcript.truth,
      stake: 250n,
    });
    const duplicate = await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: book.frame.revision,
      outcome: transcript.truth,
      stake: 250n,
    });
    const settle = await book.settle({
      idempotencyKey: 'settle',
      expectedFrameRevision: book.frame.revision,
      revealedSeed: seed(4),
      transcript,
    });
    const settleDuplicate = await book.settle({
      idempotencyKey: 'settle',
      expectedFrameRevision: book.frame.revision,
      revealedSeed: seed(4),
      transcript,
    });
    expect(duplicate).toBe(open);
    expect(settleDuplicate).toBe(settle);
    expect(open.balanceDelta + settle.balanceDelta).toBe(settle.credited - 250n);
    expect(book.ledgerRevision).toBe(2);
  });

  it('makes losing settlement and empty settlement explicit zero credits', async () => {
    const seedHex = seed(8);
    const transcript = makeTranscript(seedHex, binaryBeaconReference, 'lose');
    const book = new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference), {
      roundId: transcript.context.roundId,
      commitment: transcript.commitment,
    });
    await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 0,
      outcome: 1 - transcript.truth,
      stake: 10n,
    });
    await advanceAll(book, transcript);
    const receipt = await book.settle({
      idempotencyKey: 'settle',
      expectedFrameRevision: 3,
      revealedSeed: seedHex,
      transcript,
    });
    expect(receipt.credited).toBe(0n);
    expect(book.terminal).toBe(true);
  });
});
