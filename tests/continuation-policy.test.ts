import { describe, expect, it } from 'vitest';
import { deriveMaxContinuations } from '../src/core/continuation.js';
import { rational } from '../src/core/rational.js';
import {
  binaryBeaconReference,
  blackSignalReference,
} from '../src/modules/progressive-market/references/index.js';
import { defineGame } from '../src/modules/progressive-market/adapter.js';
import { makeTranscript } from '../src/modules/progressive-market/fairness.js';
import { initialPosterior } from '../src/modules/progressive-market/posterior.js';
import { RoundBook } from '../src/modules/progressive-market/round-book.js';
import { seed } from './helpers.js';

describe('continuation policy derivation', () => {
  it.each([
    [9700n, 4],
    [9650n, 3],
    [9550n, 2],
    [9450n, 1],
  ])('matches the title RTP ladder at %s/10000', (rtp, expected) => {
    expect(deriveMaxContinuations(rational(rtp, 10_000n), rational(8_500n, 10_000n))).toBe(
      expected,
    );
  });

  it('pins the compatibility reference to two host-managed rides', () => {
    expect(blackSignalReference.adapterVersion).toBe('1.1.0');
    expect(blackSignalReference.risk.continuation?.maxRides).toBe(2);
  });

  it('rejects invalid probabilities and unbounded searches', () => {
    expect(() => deriveMaxContinuations(rational(11n, 10n), rational(1n, 2n))).toThrowError(
      expect.objectContaining({ code: 'INVALID_RATIONAL' }),
    );
    expect(() => deriveMaxContinuations(rational(1n), rational(1n), 65)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONTEXT' }),
    );
  });

  it('refuses a base round that is already below its own floor', () => {
    // "Zero continuations permitted" and "your base game violates the floor"
    // are different answers and must not share a return value.
    expect(() => deriveMaxContinuations(rational(1n, 2n), rational(17n, 20n))).toThrowError(
      expect.objectContaining({ code: 'INVALID_RATIONAL', path: '$.roundRtp' }),
    );
    expect(deriveMaxContinuations(rational(17n, 20n), rational(17n, 20n))).toBe(0);
  });

  it('enforces the derived ride limit in the book, instead of only declaring it', async () => {
    const game = defineGame({
      ...binaryBeaconReference,
      id: 'ride-limited-v1',
      risk: { maxWinMultiple: 5000n, continuation: { maxRides: 1, rtpFloor: rational(1n, 2n) } },
    });
    const transcript = makeTranscript(seed(9), game, 'rides');
    const book = new RoundBook(game, initialPosterior(game));
    await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 0,
      outcome: transcript.truth,
      stake: 1000n,
    });
    await book.advanceFrame(transcript.evidence[0]!);
    const sold = await book.sell({ idempotencyKey: 'sell-1', expectedFrameRevision: 1 });
    await book.open({
      idempotencyKey: 'ride-1',
      expectedFrameRevision: 1,
      outcome: transcript.truth,
      stake: sold.credited,
    });
    await book.advanceFrame(transcript.evidence[1]!);
    const second = await book.sell({ idempotencyKey: 'sell-2', expectedFrameRevision: 2 });
    await expect(
      book.open({
        idempotencyKey: 'ride-2',
        expectedFrameRevision: 2,
        outcome: transcript.truth,
        stake: second.credited,
      }),
    ).rejects.toMatchObject({ code: 'OPEN_REJECTED' });
  });
});
