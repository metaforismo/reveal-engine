import type { WireReceipt } from '../../src/core/ledger.js';
import {
  SurvivalBook,
  fiveRunnerReference,
  makeTranscript,
  roundRefId,
  transcriptToWire,
  type SurvivalTranscript,
} from '../../src/modules/staged-survival/index.js';

/**
 * One deterministic staged-survival round, replayed identically every time.
 *
 * The seed and the entropy are constants, and the policy is a pure function of
 * the state the round reaches, so the whole thing — transcript, receipts,
 * snapshot — is reproducible byte for byte. `scripts/fixtures.ts` writes it to
 * `tests/fixtures/`; `tests/staged-survival-fixtures.test.ts` compares a fresh
 * build against those committed bytes rather than against another round trip.
 */
export const FROZEN_SURVIVAL_SEED = '45'.repeat(32);
export const FROZEN_SURVIVAL_ROUND = 'frozen-survival-round';
export const FROZEN_SURVIVAL_ENTROPY = '9c'.repeat(32);
export const FROZEN_SURVIVAL_STAKES: readonly bigint[] = Object.freeze([
  100n,
  200n,
  300n,
  400n,
  500n,
]);

export const frozenSurvivalRoundId = roundRefId({
  roundId: FROZEN_SURVIVAL_ROUND,
  clientEntropy: FROZEN_SURVIVAL_ENTROPY,
});

export interface FrozenSurvivalRound {
  readonly transcript: SurvivalTranscript;
  readonly wire: object;
  readonly receipts: readonly WireReceipt[];
  readonly snapshot: object;
  readonly midSnapshot: object;
}

export async function buildFrozenSurvivalRound(): Promise<FrozenSurvivalRound> {
  const definition = fiveRunnerReference;
  const book = new SurvivalBook(definition);
  for (const [entity, stake] of FROZEN_SURVIVAL_STAKES.entries())
    await book.enter(`frozen-enter-${entity}`, entity, stake);

  let midSnapshot: object | undefined;
  for (let stage = 0; stage < definition.stages; stage += 1) {
    // Bank the lowest running entity at every boundary after the first stage:
    // a partial credit chain is the shape the fixture exists to freeze.
    if (stage > 0 && book.live.length > 1)
      await book.bank(`frozen-bank-${stage}`, [book.live[0] as number]);
    if (stage === 1) midSnapshot = book.snapshot();
    const menu = book.menu();
    if (menu.length === 0) break;
    await book.choose(`frozen-choose-${stage}`, menu[0] as string);
    const transcript = makeTranscript(
      FROZEN_SURVIVAL_SEED,
      definition,
      frozenSurvivalRoundId,
      book.choices,
    );
    await book.resolve(transcript.steps[stage] as SurvivalTranscript['steps'][number]);
  }

  const transcript = makeTranscript(
    FROZEN_SURVIVAL_SEED,
    definition,
    frozenSurvivalRoundId,
    book.choices,
  );
  await book.settle('frozen-settle', FROZEN_SURVIVAL_SEED, transcript);
  const snapshot = book.snapshot() as { receipts: readonly { receipt: WireReceipt }[] };
  return Object.freeze({
    transcript,
    wire: transcriptToWire(transcript),
    // The ledger's own order, which is the ledger-revision order the snapshot
    // carries; the fixture freezes that sequence, not a re-sorted view of it.
    receipts: Object.freeze(snapshot.receipts.map((entry) => entry.receipt)),
    snapshot,
    midSnapshot: midSnapshot ?? snapshot,
  });
}
