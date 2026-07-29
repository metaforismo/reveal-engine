#!/usr/bin/env node
/**
 * Regenerates the frozen wire fixtures.
 *
 * Run deliberately (`npm run fixtures:update`) and never as part of the test
 * run: a fixture that regenerates itself proves nothing. Changing one of these
 * files is a wire-format decision and needs a version bump, a migration note,
 * and a changelog entry — see `docs/versioning.md`.
 */
import { writeFileSync } from 'node:fs';
import { buildFrozenRound, FROZEN_ROUND_ID, FROZEN_SEED } from '../tests/support/frozen-round.js';
import {
  buildFrozenCardsRound,
  buildFrozenStochasticCardsRound,
  FROZEN_CARDS_ROUND_ID,
  FROZEN_CARDS_SEED,
  FROZEN_STOCHASTIC_ROUND_ID,
} from '../tests/support/frozen-cards-round.js';

const round = await buildFrozenRound();
const cards = await buildFrozenCardsRound();
const drawn = await buildFrozenStochasticCardsRound();

const files: readonly [string, unknown][] = [
  [
    'tests/fixtures/round-book-v1.json',
    {
      note: 'Frozen reveal-engine/round-book-v1 snapshot. Regenerate with npm run fixtures:update.',
      seed: FROZEN_SEED,
      roundId: FROZEN_ROUND_ID,
      snapshot: round.snapshot,
    },
  ],
  [
    'tests/fixtures/receipt-v1.json',
    {
      note: 'Frozen reveal-engine/receipt-v1 wire records, one per action.',
      seed: FROZEN_SEED,
      roundId: FROZEN_ROUND_ID,
      receipts: round.receipts,
    },
  ],
  [
    'tests/fixtures/cards-transcript-v1.json',
    {
      note: 'Frozen reveal-engine/cards-transcript-v1 proof. Regenerate with npm run fixtures:update.',
      seed: FROZEN_CARDS_SEED,
      roundId: FROZEN_CARDS_ROUND_ID,
      transcript: cards.transcript,
    },
  ],
  [
    'tests/fixtures/cards-book-v1.json',
    {
      note: 'Frozen reveal-engine/cards-book-v1 snapshot and its receipt log, one entry per action.',
      seed: FROZEN_CARDS_SEED,
      roundId: FROZEN_CARDS_ROUND_ID,
      snapshot: cards.snapshot,
      receipts: cards.receipts,
    },
  ],
  [
    'tests/fixtures/cards-book-stochastic-v1.json',
    {
      note: "Frozen reveal-engine/cards-book-v1 snapshot under rounding: 'stochastic' — it carries the committed rounding tape and its credits come from the settlement draw.",
      seed: FROZEN_CARDS_SEED,
      roundId: FROZEN_STOCHASTIC_ROUND_ID,
      snapshot: drawn.snapshot,
      receipts: drawn.receipts,
    },
  ],
];

for (const [path, value] of files) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${path}`);
}
