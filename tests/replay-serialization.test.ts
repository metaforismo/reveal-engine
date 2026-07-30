import { describe, expect, it } from 'vitest';
import { makeTranscript } from '../src/modules/progressive-market/fairness.js';
import { initialPosterior } from '../src/modules/progressive-market/posterior.js';
import { RoundBook } from '../src/modules/progressive-market/round-book.js';
import {
  binaryBeaconReference,
  constellationReference,
} from '../src/modules/progressive-market/references/index.js';
import { snapshotHash } from '../src/core/snapshot.js';
import { advanceAll, seed } from './helpers.js';

/**
 * Recomputes the checksum, so a mutation below is rejected by the validation it
 * targets rather than by the hash. Anyone who can rewrite a stored snapshot can
 * recompute the hash over it, so the hash is never the interesting rejection.
 */
const reseal = (snapshot: Record<string, unknown>): Record<string, unknown> => {
  const { snapshotHash: _replaced, ...base } = snapshot;
  return { ...base, snapshotHash: snapshotHash(base) };
};

describe('snapshot, reconnect, and deterministic replay', () => {
  it('restores byte-identical state at every frame boundary', async () => {
    const seedHex = seed(21);
    const transcript = makeTranscript(seedHex, binaryBeaconReference, 'reconnect');
    const binding = { roundId: transcript.context.roundId, commitment: transcript.commitment };
    let book = new RoundBook(
      binaryBeaconReference,
      initialPosterior(binaryBeaconReference),
      binding,
    );
    for (const event of transcript.evidence) {
      await book.advanceFrame(event);
      const serialized = book.serialize();
      book = RoundBook.restore(binaryBeaconReference, serialized, binding);
      expect(book.serialize()).toBe(serialized);
    }
    await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 3,
      outcome: transcript.truth,
      stake: 100n,
    });
    const beforeSettle = book.serialize();
    const restored = RoundBook.restore(binaryBeaconReference, beforeSettle, binding);
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
    const book = new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference), {
      roundId: transcript.context.roundId,
      commitment: transcript.commitment,
    });
    await advanceAll(book, transcript);
    const snapshot = JSON.parse(book.serialize()) as Record<string, unknown>;
    expect(() =>
      RoundBook.restore(
        binaryBeaconReference,
        reseal({ ...snapshot, liquidBalance: '999' }) as never,
        book.publishedRound ?? null,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
    expect(() =>
      RoundBook.restore(
        constellationReference,
        book.serialize(),
        book.publishedRound ?? null,
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'ADAPTER_MISMATCH' }),
    );
  });

  it('rejects unknown snapshot fields and malformed receipt wire values', async () => {
    const transcript = makeTranscript(seed(24), binaryBeaconReference, 'snapshot-schema');
    const book = new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference), {
      roundId: transcript.context.roundId,
      commitment: transcript.commitment,
    });
    await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 0,
      outcome: transcript.truth,
      stake: 10n,
    });
    const snapshot = JSON.parse(book.serialize()) as Record<string, unknown>;
    expect(() =>
      RoundBook.restore(
        binaryBeaconReference,
        { ...snapshot, extra: true } as never,
        book.publishedRound ?? null,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
    const receipts = structuredClone(snapshot.receipts) as Array<{
      receipt: { balanceDelta: string };
    }>;
    receipts[0]!.receipt.balanceDelta = 'not-an-integer';
    expect(() =>
      RoundBook.restore(
        binaryBeaconReference,
        reseal({ ...snapshot, receipts }) as never,
        book.publishedRound ?? null,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  it('replays the same commands to the same terminal snapshot', async () => {
    const seedHex = seed(23);
    const transcript = makeTranscript(seedHex, binaryBeaconReference, 'replay');
    async function run(): Promise<string> {
      const book = new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference), {
        roundId: transcript.context.roundId,
        commitment: transcript.commitment,
      });
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
