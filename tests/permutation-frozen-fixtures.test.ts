import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { fromWireReceipt, RECEIPT_SCHEMA, type WireReceipt } from '../src/core/ledger.js';
import { snapshotHash } from '../src/core/snapshot.js';
import {
  deserializePermutationTranscript,
  makePermutationTranscript,
  PERMUTATION_ACTIONS,
  PermutationBook,
  verifyPermutationTranscript,
  type PermutationRoundBinding,
} from '../src/modules/permutation/index.js';
import {
  buildFrozenPermutationRound,
  FROZEN_PERMUTATION_ROUND_ID,
  FROZEN_PERMUTATION_SEED,
  frozenPermutationGame,
  type FrozenPermutationRound,
} from './support/frozen-permutation-round.js';

const readFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`tests/fixtures/${name}`, 'utf8')) as Record<string, unknown>;

/**
 * The round these fixtures belong to, rebuilt rather than read.
 *
 * `restore()` requires the round the caller published for any bound snapshot,
 * and lifting it out of the snapshot under test would make the argument
 * circular — a re-pointed snapshot would supply its own permission. So it is
 * re-derived from the frozen seed and the frozen round id, which is exactly the
 * out-of-band value an operator holds.
 */
const PUBLISHED_ROUND: PermutationRoundBinding = {
  roundId: FROZEN_PERMUTATION_ROUND_ID,
  commitment: makePermutationTranscript(
    FROZEN_PERMUTATION_SEED,
    frozenPermutationGame,
    FROZEN_PERMUTATION_ROUND_ID,
  ).commitment,
};

/**
 * `permutation-transcript-v1` and `permutation-book-v2` are frozen on disk, not
 * round-tripped at run time.
 *
 * A round trip generated during the test moves both sides of the comparison
 * together and would happily accept a changed encoding. These compare a rebuilt
 * round against bytes committed to the repository, so renaming a field,
 * reordering the reveals, or changing how a stake is written breaks the build
 * until somebody makes a version decision — which is the whole point of a
 * schema tag.
 */
describe('frozen permutation wire fixtures', () => {
  let round: FrozenPermutationRound;
  beforeAll(async () => {
    round = await buildFrozenPermutationRound();
  });

  it('rebuilds the frozen round deterministically', async () => {
    const again = await buildFrozenPermutationRound();
    expect(JSON.stringify(again.snapshot)).toBe(JSON.stringify(round.snapshot));
    expect(JSON.stringify(again.wire)).toBe(JSON.stringify(round.wire));
  });

  it('matches the committed transcript-v1 wire form field for field', () => {
    const fixture = readFixture('permutation-transcript-v1.json');
    expect(fixture.seed).toBe(FROZEN_PERMUTATION_SEED);
    expect(fixture.transcript).toEqual(JSON.parse(JSON.stringify(round.wire)));
    const wire = fixture.transcript as Record<string, unknown>;
    expect(wire.schema).toBe('reveal-engine/permutation-transcript-v1');
    expect(Object.keys(wire).sort()).toEqual([
      'commitment',
      'definition',
      'order',
      'reveals',
      'roundId',
      'schema',
    ]);
    // Four reveals for a five-item draw: the last position is forced.
    expect((wire.reveals as unknown[]).length).toBe((wire.order as unknown[]).length - 1);
  });

  it('verifies the committed transcript by re-derivation from the revealed seed', () => {
    const fixture = readFixture('permutation-transcript-v1.json');
    const decoded = deserializePermutationTranscript(fixture.transcript);
    expect(
      verifyPermutationTranscript(FROZEN_PERMUTATION_SEED, frozenPermutationGame, decoded),
    ).toMatchObject({ ok: true, proofVersion: 'reveal-engine/commit-v2' });
    // And a single flipped item in the committed proof stops verifying.
    const tampered = {
      ...(fixture.transcript as Record<string, unknown>),
      order: [...(decoded.order as readonly number[])].reverse(),
    };
    expect(
      verifyPermutationTranscript(FROZEN_PERMUTATION_SEED, frozenPermutationGame, tampered),
    ).toMatchObject({ ok: false, code: 'TRANSCRIPT_MISMATCH' });
  });

  it('matches the committed book-v2 snapshot field for field', () => {
    const fixture = readFixture('permutation-book-v2.json');
    expect(fixture.snapshot).toEqual(JSON.parse(JSON.stringify(round.snapshot)));
    const snapshot = fixture.snapshot as Record<string, unknown>;
    expect(snapshot.schema).toBe('reveal-engine/permutation-book-v2');
    expect(Object.keys(snapshot).sort()).toEqual([
      'binding',
      'capBasisStake',
      'claims',
      'definition',
      'ledgerRevision',
      'liquidBalance',
      'receipts',
      'schema',
      'settlement',
      'snapshotHash',
      'stepRevision',
      'terminal',
    ]);
    // The round this book was bound to before it took a bet. It is the field
    // `v1` did not have, and the reason `v1` has no migration.
    expect(snapshot.binding).toEqual({
      roundId: FROZEN_PERMUTATION_ROUND_ID,
      commitment: (round.wire as unknown as { commitment: string }).commitment,
    });
    // The frozen ticket is not a clean sweep: one of its three lines lost.
    expect((snapshot.claims as unknown[]).length).toBe(3);
    expect(fixture.credited).toBe('3360');
    expect(snapshot.liquidBalance).toBe('3360');
    // A settled snapshot carries the whole proof, seed included, so restore can
    // re-derive the order rather than take the snapshot's word for it.
    expect(Object.keys(snapshot.settlement as object).sort()).toEqual([
      'commitment',
      'idempotencyKey',
      'order',
      'revealedSeed',
      'roundId',
    ]);
    expect((snapshot.settlement as Record<string, unknown>).revealedSeed).toBe(
      FROZEN_PERMUTATION_SEED,
    );
  });

  it('decodes the committed receipts through the strict codec', () => {
    const snapshot = readFixture('permutation-book-v2.json').snapshot as Record<string, unknown>;
    const entries = snapshot.receipts as readonly { receipt: WireReceipt }[];
    const decoded = entries.map((entry) => fromWireReceipt(entry.receipt, PERMUTATION_ACTIONS));
    expect(decoded.map((receipt) => receipt.action)).toEqual(['place', 'place', 'place', 'settle']);
    expect(decoded.map((receipt) => receipt.ledgerRevision)).toEqual([1, 2, 3, 4]);
    for (const receipt of decoded) {
      expect(receipt.schema).toBe(RECEIPT_SCHEMA);
      expect(receipt.balanceDelta).toBe(receipt.credited - receipt.debited);
    }
    // One flipped digit in a committed receipt must not decode.
    expect(() =>
      fromWireReceipt({ ...entries[3]!.receipt, credited: '3361' }, PERMUTATION_ACTIONS),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  it('restores the committed snapshot and re-derives its settled credit', () => {
    const fixture = readFixture('permutation-book-v2.json');
    const restored = PermutationBook.restore(
      frozenPermutationGame,
      JSON.stringify(fixture.snapshot as Record<string, unknown>),
      PUBLISHED_ROUND,
    );
    expect(restored.terminal).toBe(true);
    expect(restored.liquidBalance).toBe(3_360n);
    expect(restored.capBasisStake).toBe(175n);
    expect(restored.ledgerRevision).toBe(4);
    // The cap chain held: the round paid at most maxWinMultiple x what was risked.
    expect(restored.liquidBalance).toBeLessThanOrEqual(175n * frozenPermutationGame.maxWinMultiple);
    // And the gross is a function of the restored ticket, not of the snapshot.
    expect(restored.grossFor(restored.settledOrder!)).toEqual({
      numerator: 3_360n,
      denominator: 1n,
    });
  });

  /**
   * Each mutation is **re-sealed** before it is restored, because the checksum
   * detects corruption and not tampering: anyone who can rewrite a field can
   * recompute a hash over it. What is under test is the semantic validation —
   * the receipt log the claims have to match, the credit the ticket has to
   * re-derive, and the cap chain the balances have to close under.
   */
  const reseal = (snapshot: Record<string, unknown>): string => {
    const { snapshotHash: _replaced, ...base } = snapshot;
    return JSON.stringify({ ...base, snapshotHash: snapshotHash(base) });
  };

  it('rejects a re-sealed mutation of the committed snapshot on its merits', () => {
    const snapshot = readFixture('permutation-book-v2.json').snapshot as Record<string, unknown>;
    expect(() =>
      PermutationBook.restore(frozenPermutationGame, reseal(snapshot), PUBLISHED_ROUND),
    ).not.toThrow();
    const claims = snapshot.claims as Record<string, unknown>[];
    for (const tampered of [
      { ...snapshot, liquidBalance: '999999' },
      { ...snapshot, capBasisStake: '999999' },
      { ...snapshot, terminal: false },
      { ...snapshot, ledgerRevision: 3 },
      // The losing line becomes a winner: the credit no longer re-derives.
      {
        ...snapshot,
        claims: claims.map((claim, index) => (index === 2 ? { ...claim, code: 'first' } : claim)),
      },
      // A bigger stake on the winning line: pinned by its own receipt.
      {
        ...snapshot,
        claims: claims.map((claim, index) => (index === 0 ? { ...claim, stake: '5000' } : claim)),
      },
      // A rewritten settled order no longer re-derives from the revealed seed,
      // and neither does a rewritten seed.
      {
        ...snapshot,
        settlement: {
          ...(snapshot.settlement as object),
          order: [...((snapshot.settlement as { order: number[] }).order as number[])].reverse(),
        },
      },
      {
        ...snapshot,
        settlement: { ...(snapshot.settlement as object), revealedSeed: '0'.repeat(64) },
      },
    ])
      expect(
        () => PermutationBook.restore(frozenPermutationGame, reseal(tampered), PUBLISHED_ROUND),
        JSON.stringify(tampered).slice(0, 80),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  it('also rejects an unsealed mutation, by the checksum', () => {
    const snapshot = readFixture('permutation-book-v2.json').snapshot as Record<string, unknown>;
    expect(() =>
      PermutationBook.restore(
        frozenPermutationGame,
        JSON.stringify({ ...snapshot, liquidBalance: '999999' }),
        PUBLISHED_ROUND,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  /**
   * The committed snapshot is bound, so it does not restore on its own say-so.
   *
   * A frozen artefact is the cleanest place to pin this: these exact bytes are
   * a valid, settled, internally consistent snapshot, and they are still refused
   * without the round the operator published. The refusal is about the caller's
   * evidence, not about anything wrong with the bytes.
   */
  it('refuses the committed bound snapshot when no published round is supplied', () => {
    const snapshot = readFixture('permutation-book-v2.json').snapshot as Record<string, unknown>;
    expect(() => PermutationBook.restore(frozenPermutationGame, reseal(snapshot))).toThrowError(
      expect.objectContaining({ code: 'CLAIM_REJECTED', path: '$.expected' }),
    );
    expect(() =>
      PermutationBook.restore(frozenPermutationGame, reseal(snapshot), {
        ...PUBLISHED_ROUND,
        roundId: `${FROZEN_PERMUTATION_ROUND_ID}-other`,
      }),
    ).toThrowError(expect.objectContaining({ code: 'COMMITMENT_MISMATCH', path: '$.binding' }));
  });

  /**
   * `permutation-book-v1.json` is kept on disk as a **negative** fixture.
   *
   * A retired schema deserves a frozen artefact as much as a live one. `v1`
   * carried no `binding`, so a book restored from one could settle against any
   * round an operator chose after seeing the ticket — which is precisely the
   * defect `v2` exists to close. It has no migration, because the field it lacks
   * is the published commitment and nothing in a `v1` snapshot says what that
   * was; reconstructing it from the settlement the snapshot already carries
   * would manufacture the very evidence the binding is supposed to supply.
   *
   * So the bytes stay, and the test is that they are refused — by version, with
   * a code that says so, rather than as a malformed object or (worse) silently
   * accepted by a future decoder that grew a tolerant default.
   */
  it('refuses the retired v1 snapshot by version, and offers it no migration', () => {
    const fixture = readFixture('permutation-book-v1.json');
    const snapshot = fixture.snapshot as Record<string, unknown>;
    expect(snapshot.schema).toBe('reveal-engine/permutation-book-v1');
    expect(snapshot).not.toHaveProperty('binding');
    // Re-sealed, so the refusal is on the schema and not on the checksum.
    expect(() => PermutationBook.restore(frozenPermutationGame, reseal(snapshot))).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_VERSION', path: '$.schema' }),
    );
    // And adding the missing field back does not make it a v2 snapshot: the
    // schema tag is the decision, not the field list.
    const dressed = { ...snapshot, binding: (round.snapshot as { binding: unknown }).binding };
    expect(() => PermutationBook.restore(frozenPermutationGame, reseal(dressed))).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }),
    );
  });
});
