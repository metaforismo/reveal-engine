import { describe, expect, it } from 'vitest';
import { makeTranscript } from '../src/modules/progressive-market/fairness.js';
import { initialPosterior } from '../src/modules/progressive-market/posterior.js';
import { RoundBook } from '../src/modules/progressive-market/round-book.js';
import {
  binaryBeaconReference,
  constellationReference,
} from '../src/modules/progressive-market/references/index.js';
import { advanceAll, seed } from './helpers.js';

describe('snapshot, reconnect, and deterministic replay', () => {
  it('restores byte-identical state at every frame boundary', async () => {
    const seedHex = seed(21);
    const transcript = makeTranscript(seedHex, binaryBeaconReference, 'reconnect');
    let book = new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference));
    for (const event of transcript.evidence) {
      await book.advanceFrame(event);
      const serialized = book.serialize();
      book = RoundBook.restore(binaryBeaconReference, serialized);
      expect(book.serialize()).toBe(serialized);
    }
    await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 3,
      outcome: transcript.truth,
      stake: 100n,
    });
    const beforeSettle = book.serialize();
    const restored = RoundBook.restore(binaryBeaconReference, beforeSettle);
    const receipt = await restored.settle({
      idempotencyKey: 'settle',
      expectedFrameRevision: 3,
      revealedSeed: seedHex,
      transcript,
    });
    const duplicate = await restored.settle({
      idempotencyKey: 'settle',
      expectedFrameRevision: 3,
      revealedSeed: seedHex,
      transcript,
    });
    expect(duplicate).toEqual(receipt);
  });

  it('rejects tampered snapshot and cross-adapter restore', async () => {
    const transcript = makeTranscript(seed(22), binaryBeaconReference, 'snapshot-tamper');
    const book = new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference));
    await advanceAll(book, transcript);
    const snapshot = JSON.parse(book.serialize()) as Record<string, unknown>;
    expect(() =>
      RoundBook.restore(binaryBeaconReference, { ...snapshot, liquidBalance: '999' } as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
    expect(() => RoundBook.restore(constellationReference, book.serialize())).toThrowError(
      expect.objectContaining({ code: 'ADAPTER_MISMATCH' }),
    );
  });

  it('rejects unknown snapshot fields and malformed receipt wire values', async () => {
    const transcript = makeTranscript(seed(24), binaryBeaconReference, 'snapshot-schema');
    const book = new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference));
    await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 0,
      outcome: transcript.truth,
      stake: 10n,
    });
    const snapshot = JSON.parse(book.serialize()) as Record<string, unknown>;
    expect(() =>
      RoundBook.restore(binaryBeaconReference, { ...snapshot, extra: true } as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
    const receipts = structuredClone(snapshot.receipts) as Array<{
      receipt: { balanceDelta: string };
    }>;
    receipts[0]!.receipt.balanceDelta = 'not-an-integer';
    expect(() =>
      RoundBook.restore(binaryBeaconReference, { ...snapshot, receipts } as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  it('replays the same commands to the same terminal snapshot', async () => {
    const seedHex = seed(23);
    const transcript = makeTranscript(seedHex, binaryBeaconReference, 'replay');
    async function run(): Promise<string> {
      const book = new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference));
      await book.open({
        idempotencyKey: 'open',
        expectedFrameRevision: 0,
        outcome: transcript.truth,
        stake: 77n,
      });
      await advanceAll(book, transcript);
      await book.settle({
        idempotencyKey: 'settle',
        expectedFrameRevision: 3,
        revealedSeed: seedHex,
        transcript,
      });
      return book.serialize();
    }
    expect(await run()).toBe(await run());
  });
});
