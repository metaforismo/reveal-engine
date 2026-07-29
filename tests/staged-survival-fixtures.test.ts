import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { RECEIPT_SCHEMA, fromWireReceipt, type WireReceipt } from '../src/core/ledger.js';
import { snapshotHash } from '../src/core/snapshot.js';
import {
  SURVIVAL_ACTIONS,
  SurvivalBook,
  fiveRunnerReference,
  stagedSurvival,
} from '../src/modules/staged-survival/index.js';
import {
  FROZEN_SURVIVAL_ENTROPY,
  FROZEN_SURVIVAL_ROUND,
  FROZEN_SURVIVAL_SEED,
  buildFrozenSurvivalRound,
  type FrozenSurvivalRound,
} from './support/staged-survival-frozen-round.js';

const readFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`tests/fixtures/${name}`, 'utf8')) as Record<string, unknown>;

/**
 * `staged-survival/transcript-v1` and `staged-survival/book-v1` are frozen on
 * disk, not round-tripped at run time.
 *
 * A round trip moves both sides of the comparison together and would accept a
 * changed encoding without noticing. These compare a freshly built round against
 * bytes committed to the repository, so renaming a field, reordering the choice
 * log, changing how a lane is written, or changing the commitment layout breaks
 * the build until someone makes a version decision.
 */
describe('frozen staged-survival wire fixtures', () => {
  let round: FrozenSurvivalRound;
  beforeAll(async () => {
    round = await buildFrozenSurvivalRound();
  });

  it('rebuilds the frozen round deterministically', async () => {
    const again = await buildFrozenSurvivalRound();
    expect(JSON.stringify(again.wire)).toBe(JSON.stringify(round.wire));
    expect(JSON.stringify(again.snapshot)).toBe(JSON.stringify(round.snapshot));
  });

  it('matches the committed transcript-v1 payload field for field', () => {
    const fixture = readFixture('staged-survival-transcript-v1.json');
    expect(fixture.seed).toBe(FROZEN_SURVIVAL_SEED);
    expect(fixture.roundId).toBe(FROZEN_SURVIVAL_ROUND);
    expect(fixture.clientEntropy).toBe(FROZEN_SURVIVAL_ENTROPY);
    expect(fixture.transcript).toEqual(JSON.parse(JSON.stringify(round.wire)));
    const transcript = fixture.transcript as Record<string, unknown>;
    expect(transcript.schema).toBe('staged-survival/transcript-v1');
    expect(Object.keys(transcript).sort()).toEqual([
      'choices',
      'clientEntropy',
      'commitment',
      'definitionFingerprint',
      'definitionId',
      'definitionVersion',
      'roundId',
      'schema',
      'seedCommitment',
      'steps',
      'tapeDigest',
    ]);
    // The frozen round is not a degenerate one: it rides three stages, changes
    // contract as the menu shrinks, and banks twice on the way.
    expect(
      (transcript.choices as { contractId: string }[]).map((choice) => choice.contractId),
    ).toEqual(['wide', 'wide', 'split']);
    expect((transcript.choices as { banked: number[] }[]).map((choice) => choice.banked)).toEqual([
      [],
      [0],
      [2],
    ]);
  });

  it('verifies the committed transcript by pure re-derivation from the seed', () => {
    const fixture = readFixture('staged-survival-transcript-v1.json');
    const verification = stagedSurvival.verify(
      FROZEN_SURVIVAL_SEED,
      fiveRunnerReference,
      fixture.transcript,
    );
    expect(verification).toMatchObject({ ok: true, proofVersion: 'reveal-engine/commit-v2' });
    // A single flipped digit anywhere in the proof must not verify.
    const tampered = {
      ...(fixture.transcript as Record<string, unknown>),
      tapeDigest: `${'0'.repeat(63)}1`,
    };
    expect(
      stagedSurvival.verify(FROZEN_SURVIVAL_SEED, fiveRunnerReference, tampered),
    ).toMatchObject({ ok: false, code: 'TRANSCRIPT_MISMATCH' });
    // ...and neither must the right proof under a different seed.
    expect(
      stagedSurvival.verify('11'.repeat(32), fiveRunnerReference, fixture.transcript),
    ).toMatchObject({ ok: false, code: 'COMMITMENT_MISMATCH' });
  });

  it('matches the committed book-v1 snapshots field for field', () => {
    const fixture = readFixture('staged-survival-book-v1.json');
    expect(fixture.snapshot).toEqual(JSON.parse(JSON.stringify(round.snapshot)));
    expect(fixture.midSnapshot).toEqual(JSON.parse(JSON.stringify(round.midSnapshot)));
    const snapshot = fixture.snapshot as Record<string, unknown>;
    expect(snapshot.schema).toBe('staged-survival/book-v1');
    expect(Object.keys(snapshot).sort()).toEqual([
      'banks',
      'capBasisStake',
      'choices',
      'definition',
      'entries',
      'ledgerRevision',
      'liquidBalance',
      'pendingBanked',
      'receipts',
      'schema',
      'settlementCommitment',
      'snapshotHash',
      'stageRevision',
      'steps',
      'terminal',
    ]);
    expect(snapshot.snapshotHash).toBe(snapshotHash({ ...snapshot, snapshotHash: undefined }));
  });

  it('restores both committed snapshots and rebuilds them byte for byte', () => {
    const fixture = readFixture('staged-survival-book-v1.json');
    for (const key of ['midSnapshot', 'snapshot'] as const) {
      const snapshot = fixture[key] as object;
      const restored = SurvivalBook.restore(fiveRunnerReference, snapshot);
      expect(JSON.parse(JSON.stringify(restored.snapshot()))).toEqual(snapshot);
    }
    const settled = SurvivalBook.restore(fiveRunnerReference, fixture.snapshot as object);
    expect(settled.terminal).toBe(true);
    expect(settled.claims.every((claim) => !claim.live)).toBe(true);
    const mid = SurvivalBook.restore(fiveRunnerReference, fixture.midSnapshot as object);
    expect(mid.terminal).toBe(false);
    expect(mid.stageRevision).toBe(1);
  });

  it('decodes every committed receipt through the strict codec', () => {
    const fixture = readFixture('staged-survival-book-v1.json');
    const entries = (fixture.snapshot as { receipts: { receipt: WireReceipt }[] }).receipts;
    const decoded = entries.map((entry) => fromWireReceipt(entry.receipt, SURVIVAL_ACTIONS));
    expect(decoded.map((receipt) => receipt.ledgerRevision)).toEqual(
      decoded.map((_receipt, index) => index + 1),
    );
    expect(decoded.map((receipt) => receipt.action)).toEqual([
      'enter',
      'enter',
      'enter',
      'enter',
      'enter',
      'choose',
      'bank',
      'choose',
      'bank',
      'choose',
      'settle',
    ]);
    for (const receipt of decoded) {
      expect(receipt.schema).toBe(RECEIPT_SCHEMA);
      expect(receipt.balanceDelta).toBe(receipt.credited - receipt.debited);
      // The reference definition declares its cap unreachable, and the frozen
      // round is evidence: no credit in it was clipped.
      expect(receipt.capped).toBe(false);
    }
    const tamperedReceipt = {
      ...(entries[6] as { receipt: WireReceipt }).receipt,
      credited: '999',
    };
    expect(() => fromWireReceipt(tamperedReceipt, SURVIVAL_ACTIONS)).toThrowError(
      expect.objectContaining({ code: 'INVALID_SNAPSHOT' }),
    );
  });
});
