/**
 * The one sequential-cards round the frozen wire fixtures are cut from.
 *
 * `scripts/fixtures.ts` writes `tests/fixtures/cards-transcript-v1.json` and
 * `tests/fixtures/cards-book-v1.json` from this exact sequence, and
 * `tests/sequential-cards/frozen-fixtures.test.ts` rebuilds it and compares
 * field for field. Any change to how a reveal, a claim, a receipt, or a book
 * snapshot encodes moves the rebuilt side only, so the committed file stops
 * matching and the build breaks — which is the whole point of freezing them.
 *
 * The sequence deliberately covers the shapes that make this module different
 * from the progressive market: a two-row ticket, a reveal that reprices the
 * board, a **switch** that transforms a claim with no credit boundary, and a
 * settlement that pays the backed position and the side market on their own
 * outcomes.
 */
import { toWireReceipt, type WireReceipt } from '../../src/core/ledger.js';
import type { CardsTranscript } from '../../src/modules/sequential-cards/contracts.js';
import { triadMiddleReference } from '../../src/modules/sequential-cards/references.js';
import {
  CardsBook,
  type CardsBookSnapshot,
} from '../../src/modules/sequential-cards/round-book.js';
import { deriveRevealSteps } from '../../src/modules/sequential-cards/steps.js';
import {
  buildCardsTranscript,
  cardsTranscriptToWire,
  type WireCardsTranscript,
} from '../../src/modules/sequential-cards/transcript.js';
import { deriveDeal } from '../../src/modules/sequential-cards/truth.js';

export const FROZEN_CARDS_SEED = `${'00'.repeat(31)}2a`;
export const FROZEN_CARDS_ROUND_ID = 'frozen-cards-round-1';
export const frozenCardsDefinition = triadMiddleReference;

export interface FrozenCardsRound {
  readonly snapshot: CardsBookSnapshot;
  readonly receipts: readonly WireReceipt[];
  readonly transcript: WireCardsTranscript;
  readonly domainTranscript: CardsTranscript;
}

export async function buildFrozenCardsRound(): Promise<FrozenCardsRound> {
  const definition = frozenCardsDefinition;
  const book = new CardsBook(definition);
  const receipts: WireReceipt[] = [];

  receipts.push(
    toWireReceipt(
      await book.open({
        idempotencyKey: 'frozen-open',
        expectedStepRevision: 0,
        roundId: FROZEN_CARDS_ROUND_ID,
        selections: [
          { id: 'MIDDLE', kind: 'position', position: 0, stake: 100n },
          { id: 'BAND', kind: 'market', marketId: 'BAND:CORE', stake: 25n },
        ],
      }),
    ),
  );

  const deal = deriveDeal(FROZEN_CARDS_SEED, definition, FROZEN_CARDS_ROUND_ID);
  const steps = deriveRevealSteps(definition, deal, book.choices);
  receipts.push(
    toWireReceipt(
      await book.advanceReveal({
        idempotencyKey: 'frozen-reveal',
        expectedStepRevision: 0,
        step: steps[0] as (typeof steps)[number],
      }),
    ),
  );

  const other = book.belief().record.hidden.find((position) => position !== 0);
  if (other === undefined || !book.offers('MIDDLE').includes('switch'))
    throw new Error('The frozen seed must reach a fully live decision state');
  receipts.push(
    toWireReceipt(
      await book.switchClaim({
        idempotencyKey: 'frozen-switch',
        expectedStepRevision: 1,
        selectionId: 'MIDDLE',
        positions: [other],
      }),
    ),
  );

  const domainTranscript = buildCardsTranscript(
    FROZEN_CARDS_SEED,
    definition,
    FROZEN_CARDS_ROUND_ID,
    book.choices,
  );
  receipts.push(
    toWireReceipt(
      await book.settle({
        idempotencyKey: 'frozen-settle',
        expectedStepRevision: 1,
        revealedSeed: FROZEN_CARDS_SEED,
        transcript: domainTranscript,
      }),
    ),
  );

  return Object.freeze({
    snapshot: book.snapshot(),
    receipts: Object.freeze(receipts),
    transcript: cardsTranscriptToWire(domainTranscript),
    domainTranscript,
  });
}
