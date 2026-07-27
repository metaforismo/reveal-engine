import { describe, expect, it } from 'vitest';
import {
  constellationReference,
  initialPosterior,
  payable,
  rational,
  RoundBook,
} from '../src/index.js';

describe('round protocol adversarial guards', () => {
  it('serializes duplicate/re-entrant opens and rejects stale/terminal transitions', async () => {
    const book = new RoundBook(constellationReference, initialPosterior(constellationReference));
    const r = await Promise.all(
      Array.from({ length: 32 }, () =>
        book.open({ idempotencyKey: 'same', expectedRevision: 0, outcome: 0, stake: 100n }),
      ),
    );
    expect(new Set(r.map((x) => x.revision))).toEqual(new Set([1]));
    await expect(book.sell({ idempotencyKey: 'stale', expectedRevision: 0 })).rejects.toThrow(
      'STALE_FRAME',
    );
    await book.settle('finish', 0);
    await expect(
      book.open({ idempotencyKey: 'late', expectedRevision: 2, outcome: 0, stake: 1n }),
    ).rejects.toThrow('OPEN_REJECTED');
  });
  it('enforces the same cap primitive at liquidation and settlement credit boundaries', async () => {
    const game = { ...constellationReference, risk: { maxWinMultiple: 1n } };
    const book = new RoundBook(game, initialPosterior(game));
    await book.open({ idempotencyKey: 'open', expectedRevision: 0, outcome: 0, stake: 100n });
    const sold = await book.sell({ idempotencyKey: 'sell', expectedRevision: 1 });
    expect(sold.credited).toBeLessThanOrEqual(100n);
    const settlementBook = new RoundBook(game, initialPosterior(game));
    await settlementBook.open({
      idempotencyKey: 'open-2',
      expectedRevision: 0,
      outcome: 2,
      stake: 100n,
    });
    const settled = await settlementBook.settle('settle-2', 2);
    expect(settled.credited).toBe(100n);
    expect(settled.capped).toBe(true);
    expect(payable(rational(10000n), 100n, 1n)).toEqual({
      theoretical: rational(10000n),
      credited: 100n,
      capped: true,
    });
  });
});
