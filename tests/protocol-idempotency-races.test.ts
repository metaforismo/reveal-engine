import { describe, expect, it } from 'vitest';
import { makeTranscript } from '../src/modules/progressive-market/fairness.js';
import { initialPosterior } from '../src/modules/progressive-market/posterior.js';
import { RoundBook } from '../src/modules/progressive-market/round-book.js';
import {
  binaryBeaconReference,
  constellationReference,
} from '../src/modules/progressive-market/references/index.js';
import { advanceAll, completedBook, seed } from './helpers.js';

describe('idempotency, stale frames, races, and atomicity', () => {
  it.each([
    ['changed stake', { expectedFrameRevision: 0, outcome: 0, stake: 2n }],
    ['changed outcome', { expectedFrameRevision: 0, outcome: 1, stake: 1n }],
    ['changed revision', { expectedFrameRevision: 1, outcome: 0, stake: 1n }],
  ])('rejects key reuse with %s', async (_, changed) => {
    const book = new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference));
    await book.open({ idempotencyKey: 'key', expectedFrameRevision: 0, outcome: 0, stake: 1n });
    await expect(book.open({ idempotencyKey: 'key', ...changed })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('rejects cross-action key reuse instead of returning the wrong receipt', async () => {
    const book = new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference));
    await book.open({
      idempotencyKey: 'collision',
      expectedFrameRevision: 0,
      outcome: 0,
      stake: 10n,
    });
    await expect(
      book.sell({ idempotencyKey: 'collision', expectedFrameRevision: 0 }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(book.position).toBeDefined();
    expect(book.ledgerRevision).toBe(1);
  });

  it('linearizes concurrent identical and conflicting opens', async () => {
    const book = new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference));
    const results = await Promise.allSettled([
      ...Array.from({ length: 32 }, () =>
        book.open({ idempotencyKey: 'same', expectedFrameRevision: 0, outcome: 0, stake: 100n }),
      ),
      book.open({ idempotencyKey: 'same', expectedFrameRevision: 0, outcome: 1, stake: 100n }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(32);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(book.ledgerRevision).toBe(1);
  });

  it('rejects stale action frames after evidence advances', async () => {
    const seedHex = seed(6);
    const transcript = makeTranscript(seedHex, binaryBeaconReference, 'stale');
    const book = new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference));
    await book.advanceFrame(transcript.evidence[0]!);
    await expect(
      book.open({ idempotencyKey: 'stale', expectedFrameRevision: 0, outcome: 0, stake: 1n }),
    ).rejects.toMatchObject({ code: 'STALE_FRAME' });
    expect(book.ledgerRevision).toBe(0);
  });

  it('keeps state unchanged when settlement proof is invalid', async () => {
    const { book, transcript } = await completedBook(binaryBeaconReference, seed(7), 'atomic');
    await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 3,
      outcome: transcript.truth,
      stake: 10n,
    });
    const before = book.serialize();
    await expect(
      book.settle({
        idempotencyKey: 'bad',
        expectedFrameRevision: 3,
        revealedSeed: seed(99),
        transcript,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSCRIPT' });
    expect(book.serialize()).toBe(before);
    expect(book.terminal).toBe(false);
  });

  it('linearizes sell-versus-settle without double positive credit', async () => {
    const { book, transcript } = await completedBook(binaryBeaconReference, seed(10), 'race');
    await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 3,
      outcome: transcript.truth,
      stake: 100n,
    });
    const results = await Promise.allSettled([
      book.sell({ idempotencyKey: 'sell', expectedFrameRevision: 3 }),
      book.settle({
        idempotencyKey: 'settle',
        expectedFrameRevision: 3,
        revealedSeed: seed(10),
        transcript,
      }),
    ]);
    const credits = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value.credited] : [],
    );
    expect(credits.filter((credit) => credit > 0n).length).toBeLessThanOrEqual(1);
    expect(book.terminal || book.position === undefined).toBe(true);
  });

  it('rejects posterior from another adapter at construction', () => {
    expect(
      () => new RoundBook(binaryBeaconReference, initialPosterior(constellationReference)),
    ).toThrowError(expect.objectContaining({ code: 'ADAPTER_MISMATCH' }));
  });
});
