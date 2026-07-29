import type { WireReceipt } from '../../src/core/ledger.js';
import {
  aetherOrderClassicReference,
  makePermutationTranscript,
  PermutationBook,
  permutationTranscriptToWire,
  type PermutationBookSnapshot,
  type PermutationTranscript,
  type WirePermutationTranscript,
} from '../../src/modules/permutation/index.js';

/**
 * The one round the permutation wire fixtures are frozen from.
 *
 * It is deliberately not a clean sweep. The ticket carries three behaviourally
 * distinct claims — a winning `first`, the winning `full` order, and a `last`
 * that cannot win because the item it names has already settled into position 0
 * — so the frozen settlement records mixed `won` outcomes rather than only the
 * happy path, and the frozen receipts cover both actions the book mints.
 */
export const FROZEN_PERMUTATION_SEED = 'ae'.repeat(32);
export const FROZEN_PERMUTATION_ROUND_ID = 'frozen-permutation-round';
export const frozenPermutationGame = aetherOrderClassicReference;

export interface FrozenPermutationRound {
  readonly transcript: PermutationTranscript;
  readonly wire: WirePermutationTranscript;
  readonly snapshot: PermutationBookSnapshot;
  readonly receipts: readonly WireReceipt[];
  readonly credited: bigint;
}

export async function buildFrozenPermutationRound(): Promise<FrozenPermutationRound> {
  const definition = frozenPermutationGame;
  const transcript = makePermutationTranscript(
    FROZEN_PERMUTATION_SEED,
    definition,
    FROZEN_PERMUTATION_ROUND_ID,
  );
  const winner = transcript.order[0] as number;
  const book = new PermutationBook(definition);
  await book.place({
    idempotencyKey: 'place-first',
    bet: { code: 'first', item: winner },
    stake: 100n,
  });
  await book.place({
    idempotencyKey: 'place-full',
    bet: { code: 'full', order: transcript.order },
    stake: 25n,
  });
  // `winner` settles into position 0, so it cannot also settle last: a frozen
  // loser, guaranteed by the structure of the round rather than by the seed.
  await book.place({
    idempotencyKey: 'place-last',
    bet: { code: 'last', item: winner },
    stake: 50n,
  });
  const receipt = await book.settle({
    idempotencyKey: 'settle',
    revealedSeed: FROZEN_PERMUTATION_SEED,
    transcript,
  });
  const snapshot = book.snapshot();
  return {
    transcript,
    wire: permutationTranscriptToWire(transcript),
    snapshot,
    receipts: snapshot.receipts.map((entry) => entry.receipt),
    credited: receipt.credited,
  };
}
