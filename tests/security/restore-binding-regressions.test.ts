import { describe, expect, it } from 'vitest';
import { commandFingerprint } from '../../src/core/ledger.js';
import { snapshotHash } from '../../src/core/snapshot.js';
import { makePermutationTranscript } from '../../src/modules/permutation/derivation.js';
import { PermutationBook } from '../../src/modules/permutation/round-book.js';
import { aetherOrderClassicReference } from '../../src/modules/permutation/references/index.js';
import { makeTranscript as makeProgressiveTranscript } from '../../src/modules/progressive-market/fairness.js';
import { initialPosterior } from '../../src/modules/progressive-market/posterior.js';
import { RoundBook } from '../../src/modules/progressive-market/round-book.js';
import { binaryBeaconReference } from '../../src/modules/progressive-market/references/index.js';
import { triadMiddleReference } from '../../src/modules/sequential-cards/references.js';
import { CardsBook, openFingerprint } from '../../src/modules/sequential-cards/round-book.js';
import { SurvivalBook } from '../../src/modules/staged-survival/book.js';
import { fiveRunnerReference } from '../../src/modules/staged-survival/references/index.js';
import { roundRefId } from '../../src/modules/staged-survival/validation.js';
import { seed } from '../helpers.js';
import { cardsAdmission } from '../support/cards-admission.js';
import { survivalAdmission } from '../support/survival-admission.js';

type Json = Record<string, unknown>;

function reseal(snapshot: Json): Json {
  const { snapshotHash: _replaced, ...base } = snapshot;
  return { ...base, snapshotHash: snapshotHash(base) };
}

function repointFirstReceipt(snapshot: Json, fingerprint: string): Json {
  const forged = structuredClone(snapshot);
  const entry = (forged.receipts as { fingerprint: string; receipt: Json }[])[0]!;
  entry.fingerprint = fingerprint;
  entry.receipt.commandFingerprint = fingerprint;
  return forged;
}

/**
 * Deliberately exercises the JavaScript call shape that omitted the external
 * binding. The static restore signatures require a third argument; Reflect
 * keeps this hostile wire/API regression honest without weakening that type.
 */
function restoreWithoutBinding<T>(
  restore: (...args: never[]) => T,
  definition: object,
  snapshot: Json,
): T {
  return Reflect.apply(restore, undefined, [definition, snapshot]) as T;
}

describe('published-round binding is mandatory at restore', () => {
  it('progressive-market accepts an honest binding and rejects a re-pointed open round', async () => {
    const honest = makeProgressiveTranscript(
      seed(0x901),
      binaryBeaconReference,
      'restore-binding-progressive-honest',
    );
    const foreign = makeProgressiveTranscript(
      seed(0x902),
      binaryBeaconReference,
      'restore-binding-progressive-foreign',
    );
    const binding = { roundId: honest.context.roundId, commitment: honest.commitment };
    const book = new RoundBook(
      binaryBeaconReference,
      initialPosterior(binaryBeaconReference),
      binding,
    );
    await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 0,
      outcome: 0,
      stake: 100n,
    });
    expect(
      RoundBook.restore(binaryBeaconReference, book.snapshot(), binding).publishedRound,
    ).toEqual(binding);
    expect(() =>
      restoreWithoutBinding(
        RoundBook.restore,
        binaryBeaconReference,
        book.snapshot() as unknown as Json,
      ),
    ).toThrowError(expect.objectContaining({ code: 'COMMITMENT_MISMATCH' }));

    const forged = repointFirstReceipt(
      book.snapshot() as unknown as Json,
      commandFingerprint('open', [foreign.context.roundId, foreign.commitment, 0, 0, 100n]),
    );
    forged.publishedRound = {
      roundId: foreign.context.roundId,
      commitment: foreign.commitment,
    };

    expect(() =>
      restoreWithoutBinding(RoundBook.restore, binaryBeaconReference, reseal(forged)),
    ).toThrowError(expect.objectContaining({ code: 'COMMITMENT_MISMATCH' }));
  });

  it('sequential-cards accepts an honest binding and rejects a re-pointed ticket', async () => {
    const honestRound = 'restore-binding-cards-honest';
    const foreignRound = 'restore-binding-cards-foreign';
    const honestAdmission = cardsAdmission(triadMiddleReference, seed(0x903), honestRound);
    const foreignAdmission = cardsAdmission(triadMiddleReference, seed(0x904), foreignRound);
    const rows = [{ id: 'P', kind: 'position' as const, position: 0, stake: 25n }];
    const book = new CardsBook(triadMiddleReference);
    await book.open({
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId: honestRound,
      ...honestAdmission,
      selections: rows,
    });
    const binding = {
      roundId: honestRound,
      seedCommitment: honestAdmission.seedCommitment,
    };
    expect(CardsBook.restore(triadMiddleReference, book.snapshot(), binding).serialize()).toBe(
      book.serialize(),
    );
    expect(() =>
      restoreWithoutBinding(
        CardsBook.restore,
        triadMiddleReference,
        book.snapshot() as unknown as Json,
      ),
    ).toThrowError(expect.objectContaining({ code: 'COMMITMENT_MISMATCH' }));

    const forged = repointFirstReceipt(
      book.snapshot() as unknown as Json,
      openFingerprint(
        foreignRound,
        rows,
        undefined,
        foreignAdmission.seedCommitment,
        foreignAdmission.clientSeed,
      ),
    );
    forged.roundId = foreignRound;
    forged.seedCommitment = foreignAdmission.seedCommitment;

    expect(() =>
      restoreWithoutBinding(CardsBook.restore, triadMiddleReference, reseal(forged)),
    ).toThrowError(expect.objectContaining({ code: 'COMMITMENT_MISMATCH' }));
  });

  it('staged-survival accepts an honest binding and rejects a re-pointed entry', async () => {
    const honestRound = roundRefId({
      roundId: 'restore-binding-survival-honest',
      clientEntropy: '51'.repeat(32),
    });
    const foreignRound = roundRefId({
      roundId: 'restore-binding-survival-foreign',
      clientEntropy: '52'.repeat(32),
    });
    const binding = survivalAdmission(fiveRunnerReference, seed(0x905), honestRound);
    const foreign = survivalAdmission(fiveRunnerReference, seed(0x906), foreignRound);
    const book = new SurvivalBook(fiveRunnerReference, binding);
    await book.enter('enter', 0, 100n);
    expect(
      SurvivalBook.restore(fiveRunnerReference, book.snapshot(), binding).publishedRound,
    ).toEqual(binding);
    expect(() =>
      restoreWithoutBinding(SurvivalBook.restore, fiveRunnerReference, book.snapshot() as Json),
    ).toThrowError(expect.objectContaining({ code: 'COMMITMENT_MISMATCH' }));

    const forged = repointFirstReceipt(
      book.snapshot() as unknown as Json,
      commandFingerprint('enter', [foreign.roundId, foreign.seedCommitment, 0, 100n]),
    );
    forged.publishedRound = foreign;

    expect(() =>
      restoreWithoutBinding(SurvivalBook.restore, fiveRunnerReference, reseal(forged)),
    ).toThrowError(expect.objectContaining({ code: 'COMMITMENT_MISMATCH' }));
  });

  it('permutation accepts an honest binding and rejects a re-pointed ticket', async () => {
    const honest = makePermutationTranscript(
      seed(0x907),
      aetherOrderClassicReference,
      'restore-binding-permutation-honest',
    );
    const foreign = makePermutationTranscript(
      seed(0x908),
      aetherOrderClassicReference,
      'restore-binding-permutation-foreign',
    );
    const binding = { roundId: honest.roundId, commitment: honest.commitment };
    const foreignBinding = { roundId: foreign.roundId, commitment: foreign.commitment };
    const item = honest.order[0] as number;
    const book = new PermutationBook(aetherOrderClassicReference, binding);
    await book.place({
      idempotencyKey: 'place',
      bet: { code: 'first', item },
      stake: 25n,
    });
    expect(
      PermutationBook.restore(aetherOrderClassicReference, book.snapshot(), binding).binding,
    ).toEqual(binding);
    expect(() =>
      restoreWithoutBinding(
        PermutationBook.restore,
        aetherOrderClassicReference,
        book.snapshot() as unknown as Json,
      ),
    ).toThrowError(expect.objectContaining({ code: 'COMMITMENT_MISMATCH' }));

    const forged = repointFirstReceipt(
      book.snapshot() as unknown as Json,
      commandFingerprint('place', [
        foreignBinding.roundId,
        foreignBinding.commitment,
        'first',
        item,
        25n,
      ]),
    );
    forged.binding = foreignBinding;

    expect(() =>
      restoreWithoutBinding(PermutationBook.restore, aetherOrderClassicReference, reseal(forged)),
    ).toThrowError(expect.objectContaining({ code: 'COMMITMENT_MISMATCH' }));
  });
});
