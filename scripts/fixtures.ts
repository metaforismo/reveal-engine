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
  buildFrozenSurvivalRound,
  FROZEN_SURVIVAL_ENTROPY,
  FROZEN_SURVIVAL_ROUND,
  FROZEN_SURVIVAL_SEED,
} from '../tests/support/staged-survival-frozen-round.js';

const round = await buildFrozenRound();
const survival = await buildFrozenSurvivalRound();

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
    'tests/fixtures/staged-survival-transcript-v1.json',
    {
      note: 'Frozen staged-survival/transcript-v1 proof. Regenerate with npm run fixtures:update.',
      seed: FROZEN_SURVIVAL_SEED,
      roundId: FROZEN_SURVIVAL_ROUND,
      clientEntropy: FROZEN_SURVIVAL_ENTROPY,
      transcript: survival.wire,
    },
  ],
  [
    'tests/fixtures/staged-survival-book-v1.json',
    {
      note: 'Frozen staged-survival/book-v1 snapshots: one mid-round, one settled.',
      seed: FROZEN_SURVIVAL_SEED,
      roundId: FROZEN_SURVIVAL_ROUND,
      clientEntropy: FROZEN_SURVIVAL_ENTROPY,
      midSnapshot: survival.midSnapshot,
      snapshot: survival.snapshot,
    },
  ],
];

for (const [path, value] of files) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${path}`);
}
