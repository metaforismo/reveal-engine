import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { fromWireReceipt, RECEIPT_SCHEMA, type WireReceipt } from '../src/core/ledger.js';
import { RoundBook, ROUND_ACTIONS } from '../src/modules/progressive-market/round-book.js';
import { verifyTranscriptDetailed } from '../src/modules/progressive-market/fairness.js';
import {
  buildFrozenRound,
  frozenGame,
  FROZEN_SEED,
  type FrozenRound,
} from './support/frozen-round.js';

const readFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`tests/fixtures/${name}`, 'utf8')) as Record<string, unknown>;

/**
 * `receipt-v1` and `round-book-v1` are frozen on disk, not merely round-tripped.
 *
 * A round trip generated at runtime moves both sides of the comparison together
 * and would happily accept a changed encoding. These tests compare a rebuilt
 * round against bytes committed to the repository, so renaming a field,
 * reordering the receipt log, or changing how a BigInt is written breaks the
 * build until someone makes a version decision.
 */
describe('frozen wire fixtures', () => {
  // Built once for the whole file: assigning it inside the first `it` made every
  // other case depend on that case having run, so `-t`, sharding, or a shuffled
  // sequence would turn this file's guarantee into a TypeError instead of a
  // failed comparison.
  let round: FrozenRound;
  beforeAll(async () => {
    round = await buildFrozenRound();
  });

  it('rebuilds the frozen round deterministically', async () => {
    const again = await buildFrozenRound();
    expect(JSON.stringify(again.snapshot)).toBe(JSON.stringify(round.snapshot));
  });

  it('matches the committed receipt-v1 records field for field', () => {
    const fixture = readFixture('receipt-v1.json');
    expect(fixture.seed).toBe(FROZEN_SEED);
    const frozen = fixture.receipts as readonly WireReceipt[];
    expect(frozen).toHaveLength(round.receipts.length);
    expect(frozen).toEqual(round.receipts);
    expect(frozen.map((receipt) => receipt.action)).toEqual(['open', 'sell', 'open', 'settle']);
    for (const receipt of frozen) expect(receipt.schema).toBe(RECEIPT_SCHEMA);
  });

  it('decodes the committed receipts through the strict codec', () => {
    const frozen = readFixture('receipt-v1.json').receipts as readonly WireReceipt[];
    const decoded = frozen.map((receipt) => fromWireReceipt(receipt, ROUND_ACTIONS));
    expect(decoded.map((receipt) => receipt.ledgerRevision)).toEqual([1, 2, 3, 4]);
    expect(decoded.map((receipt) => receipt.balanceDelta)).toEqual(
      decoded.map((receipt) => receipt.credited - receipt.debited),
    );
    // A single flipped digit in a committed receipt must not decode.
    const tampered = { ...(frozen[1] as WireReceipt), credited: '1156' };
    expect(() => fromWireReceipt(tampered, ROUND_ACTIONS)).toThrowError(
      expect.objectContaining({ code: 'INVALID_SNAPSHOT' }),
    );
  });

  it('matches the committed round-book-v1 snapshot field for field', () => {
    const fixture = readFixture('round-book-v1.json');
    expect(fixture.snapshot).toEqual(JSON.parse(JSON.stringify(round.snapshot)));
    const snapshot = fixture.snapshot as Record<string, unknown>;
    expect(snapshot.schema).toBe('reveal-engine/round-book-v1');
    expect(Object.keys(snapshot).sort()).toEqual([
      'adapter',
      'capBasisStake',
      'entryCount',
      'evidence',
      'frameRevision',
      'ledgerRevision',
      'liquidBalance',
      'position',
      'posterior',
      'receipts',
      'schema',
      'snapshotHash',
      'terminal',
    ]);
  });

  it('restores a book from the committed snapshot and re-verifies its proof', () => {
    const fixture = readFixture('round-book-v1.json');
    const restored = RoundBook.restore(
      frozenGame,
      JSON.stringify(fixture.snapshot as Record<string, unknown>),
    );
    expect(restored.terminal).toBe(true);
    expect(restored.liquidBalance).toBe(1320n);
    expect(restored.capBasisStake).toBe(1000n);
    expect(restored.ledgerRevision).toBe(4);
    // The cap chain held: the whole round paid at most maxWinMultiple x the stake.
    expect(restored.liquidBalance).toBeLessThanOrEqual(1000n * frozenGame.risk.maxWinMultiple);
    expect(verifyTranscriptDetailed(FROZEN_SEED, frozenGame, round.transcript).ok).toBe(true);
  });

  it('rejects a tampered copy of the committed snapshot', () => {
    const snapshot = readFixture('round-book-v1.json').snapshot as Record<string, unknown>;
    for (const tampered of [
      { ...snapshot, liquidBalance: '999999' },
      { ...snapshot, capBasisStake: '999999' },
      { ...snapshot, terminal: false },
      { ...snapshot, ledgerRevision: 3 },
    ])
      expect(() => RoundBook.restore(frozenGame, JSON.stringify(tampered))).toThrowError(
        expect.objectContaining({ code: 'INVALID_SNAPSHOT' }),
      );
  });
});
