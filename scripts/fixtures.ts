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
  buildFrozenPermutationRound,
  FROZEN_PERMUTATION_ROUND_ID,
  FROZEN_PERMUTATION_SEED,
} from '../tests/support/frozen-permutation-round.js';

const round = await buildFrozenRound();
const permutationRound = await buildFrozenPermutationRound();

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
    'tests/fixtures/permutation-transcript-v1.json',
    {
      note: 'Frozen reveal-engine/permutation-transcript-v1 wire form. Regenerate with npm run fixtures:update.',
      seed: FROZEN_PERMUTATION_SEED,
      roundId: FROZEN_PERMUTATION_ROUND_ID,
      transcript: permutationRound.wire,
    },
  ],
  [
    // `permutation-book-v1.json` is deliberately NOT regenerated. It is the
    // frozen negative fixture for a retired schema: `v1` carried no round
    // binding, so restoring one would install a book that could settle against
    // any round an operator picked after seeing the ticket. It has no migration
    // — the field it lacks is the published commitment — and the frozen-fixture
    // suite asserts it is refused with `UNSUPPORTED_VERSION`.
    'tests/fixtures/permutation-book-v2.json',
    {
      note: 'Frozen reveal-engine/permutation-book-v2 snapshot for a settled three-line ticket on a bound round.',
      seed: FROZEN_PERMUTATION_SEED,
      roundId: FROZEN_PERMUTATION_ROUND_ID,
      credited: String(permutationRound.credited),
      snapshot: permutationRound.snapshot,
    },
  ],
];

for (const [path, value] of files) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${path}`);
}
