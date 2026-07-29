/**
 * The one round the frozen wire fixtures are cut from.
 *
 * `scripts/fixtures.ts` writes `tests/fixtures/round-book-v1.json` and
 * `tests/fixtures/receipt-v1.json` from this exact sequence, and
 * `tests/frozen-fixtures.test.ts` rebuilds it and compares field for field. Any
 * change to how a receipt or a round-book snapshot encodes moves the rebuilt
 * side only, so the committed file stops matching and the build breaks — which
 * is the whole point of freezing them.
 *
 * The sequence deliberately covers every receipt action and both cap-chain
 * states: an opening stake, a liquidation, a self-financed re-entry, and a
 * winning settlement.
 */
import { initialPosterior } from '../../src/modules/progressive-market/posterior.js';
import { makeTranscript } from '../../src/modules/progressive-market/fairness.js';
import {
  RoundBook,
  type RoundBookSnapshot,
} from '../../src/modules/progressive-market/round-book.js';
import { binaryBeaconReference } from '../../src/modules/progressive-market/references/index.js';
import { transcriptToWire } from '../../src/modules/progressive-market/transcript.js';
import { toWireReceipt, type WireReceipt } from '../../src/core/ledger.js';

export const FROZEN_SEED = `${'00'.repeat(31)}07`;
export const FROZEN_ROUND_ID = 'frozen-fixture-round-1';
export const frozenGame = binaryBeaconReference;

export interface FrozenRound {
  readonly snapshot: RoundBookSnapshot;
  readonly receipts: readonly WireReceipt[];
  readonly transcript: ReturnType<typeof transcriptToWire>;
}

export async function buildFrozenRound(): Promise<FrozenRound> {
  const transcript = makeTranscript(FROZEN_SEED, frozenGame, FROZEN_ROUND_ID);
  const book = new RoundBook(frozenGame, initialPosterior(frozenGame));
  const receipts: WireReceipt[] = [];

  receipts.push(
    toWireReceipt(
      await book.open({
        idempotencyKey: 'frozen-open',
        expectedFrameRevision: 0,
        outcome: transcript.truth,
        stake: 1000n,
      }),
    ),
  );
  await book.advanceFrame(transcript.evidence[0]!);
  const sold = await book.sell({ idempotencyKey: 'frozen-sell', expectedFrameRevision: 1 });
  receipts.push(toWireReceipt(sold));
  receipts.push(
    toWireReceipt(
      await book.open({
        idempotencyKey: 'frozen-reopen',
        expectedFrameRevision: 1,
        outcome: transcript.truth,
        stake: sold.credited,
      }),
    ),
  );
  for (const event of transcript.evidence.slice(1)) await book.advanceFrame(event);
  receipts.push(
    toWireReceipt(
      await book.settle({
        idempotencyKey: 'frozen-settle',
        expectedFrameRevision: transcript.evidence.length,
        revealedSeed: FROZEN_SEED,
        transcript,
      }),
    ),
  );

  return Object.freeze({
    snapshot: book.snapshot(),
    receipts: Object.freeze(receipts),
    transcript: transcriptToWire(transcript),
  });
}
