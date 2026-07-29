import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { RECEIPT_SCHEMA, fromWireReceipt, type WireReceipt } from '../../src/core/ledger.js';
import { snapshotHash } from '../../src/core/snapshot.js';
import { CARDS_ACTIONS } from '../../src/modules/sequential-cards/contracts.js';
import { CardsBook } from '../../src/modules/sequential-cards/round-book.js';
import {
  deserializeCardsTranscript,
  verifyCardsTranscript,
} from '../../src/modules/sequential-cards/transcript.js';
import {
  FROZEN_CARDS_ROUND_ID,
  FROZEN_CARDS_SEED,
  buildFrozenCardsRound,
  frozenCardsDefinition,
  type FrozenCardsRound,
} from '../support/frozen-cards-round.js';

const readFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`tests/fixtures/${name}`, 'utf8')) as Record<string, unknown>;

/**
 * `cards-transcript-v1` and `cards-book-v1` are frozen on disk, not round-tripped.
 *
 * A round trip generated at run time moves both sides of the comparison
 * together and would happily accept a changed encoding. These compare a rebuilt
 * round against bytes committed to the repository, so renaming a field,
 * reordering the receipt log, or changing how a claim is written breaks the
 * build until somebody makes a version decision.
 */
describe('sequential-cards: frozen wire fixtures', () => {
  let round: FrozenCardsRound;
  beforeAll(async () => {
    round = await buildFrozenCardsRound();
  });

  it('rebuilds the frozen round deterministically', async () => {
    const again = await buildFrozenCardsRound();
    expect(JSON.stringify(again.snapshot)).toBe(JSON.stringify(round.snapshot));
    expect(JSON.stringify(again.transcript)).toBe(JSON.stringify(round.transcript));
  });

  it('matches the committed cards-transcript-v1 field for field', () => {
    const fixture = readFixture('cards-transcript-v1.json');
    expect(fixture.seed).toBe(FROZEN_CARDS_SEED);
    expect(fixture.roundId).toBe(FROZEN_CARDS_ROUND_ID);
    expect(fixture.transcript).toEqual(JSON.parse(JSON.stringify(round.transcript)));
    const transcript = fixture.transcript as Record<string, unknown>;
    expect(transcript.schema).toBe('reveal-engine/cards-transcript-v1');
    expect(Object.keys(transcript).sort()).toEqual([
      'choices',
      'commitment',
      'deal',
      'definitionFingerprint',
      'definitionId',
      'definitionVersion',
      'roundId',
      'schema',
      'seedCommitment',
      'steps',
    ]);
  });

  it('verifies the committed transcript by re-derivation from the revealed seed', () => {
    const fixture = readFixture('cards-transcript-v1.json');
    const decoded = deserializeCardsTranscript(fixture.transcript);
    expect(verifyCardsTranscript(FROZEN_CARDS_SEED, frozenCardsDefinition, decoded)).toMatchObject({
      ok: true,
    });
    // One flipped rank and the proof stops verifying.
    expect(
      verifyCardsTranscript(FROZEN_CARDS_SEED, frozenCardsDefinition, {
        ...(fixture.transcript as Record<string, unknown>),
        deal: {
          ...(decoded.deal as unknown as Record<string, unknown>),
          ranks: [...decoded.deal.ranks].reverse(),
        },
      }),
    ).toMatchObject({ ok: false });
  });

  it('matches the committed receipt log, one entry per action taken', () => {
    const fixture = readFixture('cards-book-v1.json');
    const frozen = fixture.receipts as readonly WireReceipt[];
    expect(frozen).toEqual(round.receipts);
    expect(frozen.map((receipt) => receipt.action)).toEqual(['open', 'reveal', 'switch', 'settle']);
    for (const receipt of frozen) expect(receipt.schema).toBe(RECEIPT_SCHEMA);
    const decoded = frozen.map((receipt) => fromWireReceipt(receipt, CARDS_ACTIONS));
    expect(decoded.map((receipt) => receipt.ledgerRevision)).toEqual([1, 2, 3, 4]);
    // A switch is a claim transformation, so it crosses no credit boundary.
    expect(decoded[2]).toMatchObject({ action: 'switch', debited: 0n, credited: 0n });
    expect(decoded.map((receipt) => receipt.balanceDelta)).toEqual(
      decoded.map((receipt) => receipt.credited - receipt.debited),
    );
    const tampered = { ...(frozen[3] as WireReceipt), credited: '999999' };
    expect(() => fromWireReceipt(tampered, CARDS_ACTIONS)).toThrowError(
      expect.objectContaining({ code: 'INVALID_SNAPSHOT' }),
    );
  });

  it('matches the committed cards-book-v1 snapshot field for field', () => {
    const fixture = readFixture('cards-book-v1.json');
    expect(fixture.snapshot).toEqual(JSON.parse(JSON.stringify(round.snapshot)));
    const snapshot = fixture.snapshot as Record<string, unknown>;
    expect(snapshot.schema).toBe('reveal-engine/cards-book-v1');
    expect(Object.keys(snapshot).sort()).toEqual([
      'capBasisStake',
      'choices',
      'decisions',
      'definition',
      'ledgerRevision',
      'liquidBalance',
      'receipts',
      'roundId',
      'schema',
      'selections',
      'settlement',
      'snapshotHash',
      'stepRevision',
      'steps',
      'terminal',
    ]);
  });

  it('restores the committed snapshot and re-derives every money-bearing field', () => {
    const fixture = readFixture('cards-book-v1.json');
    const restored = CardsBook.restore(
      frozenCardsDefinition,
      JSON.stringify(fixture.snapshot as Record<string, unknown>),
    );
    expect(restored.terminal).toBe(true);
    expect(restored.ledgerRevision).toBe(4);
    expect(restored.capBasisStake).toBe(125n);
    expect(restored.roundId).toBe(FROZEN_CARDS_ROUND_ID);
    // The cap chain held: the round paid at most maxWinMultiple x what was risked.
    expect(restored.liquidBalance).toBeLessThanOrEqual(
      125n * frozenCardsDefinition.risk.maxWinMultiple,
    );
    expect(restored.snapshot()).toEqual(fixture.snapshot);
  });

  /**
   * Each mutation is **re-sealed** before it is restored.
   *
   * The checksum detects corruption, not tampering: anyone who can rewrite a
   * field can recompute the hash over it, so a case that keeps the original
   * `snapshotHash` only proves the hash noticed. Recomputing it puts the
   * semantic validation under test — the replayed claims, the recomputed
   * credits, and the fingerprints every command was minted with.
   */
  const reseal = (snapshot: Record<string, unknown>): string => {
    const { snapshotHash: _replaced, ...base } = snapshot;
    return JSON.stringify({ ...base, snapshotHash: snapshotHash(base) });
  };

  it('rejects a re-sealed mutation of the committed snapshot on its merits', () => {
    const snapshot = readFixture('cards-book-v1.json').snapshot as Record<string, unknown>;
    expect(() => CardsBook.restore(frozenCardsDefinition, reseal(snapshot))).not.toThrow();
    const selections = snapshot.selections as Record<string, unknown>[];
    for (const tampered of [
      { ...snapshot, liquidBalance: '999999' },
      { ...snapshot, capBasisStake: '999999' },
      { ...snapshot, terminal: false },
      { ...snapshot, ledgerRevision: 3 },
      { ...snapshot, roundId: 'a-different-round' },
      { ...snapshot, decisions: [] },
      {
        ...snapshot,
        selections: selections.map((selection, index) =>
          index === 0 ? { ...selection, stake: '999999' } : selection,
        ),
      },
      {
        ...snapshot,
        selections: selections.map((selection, index) =>
          index === 0 ? { ...selection, status: 'live' } : selection,
        ),
      },
      {
        ...snapshot,
        steps: (snapshot.steps as Record<string, unknown>[]).map((step) => ({
          ...step,
          rank: ((step.rank as number) % 13) + 1,
        })),
      },
    ])
      expect(
        () => CardsBook.restore(frozenCardsDefinition, reseal(tampered)),
        JSON.stringify(tampered).slice(0, 120),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  it('also rejects an unsealed mutation, by the checksum', () => {
    const snapshot = readFixture('cards-book-v1.json').snapshot as Record<string, unknown>;
    expect(() =>
      CardsBook.restore(
        frozenCardsDefinition,
        JSON.stringify({ ...snapshot, liquidBalance: '999999' }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });
});
