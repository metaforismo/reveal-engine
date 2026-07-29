#!/usr/bin/env node
/**
 * Regenerates the frozen wire fixtures.
 *
 * Run deliberately (`npm run fixtures:update`) and never as part of the test
 * run: a fixture that regenerates itself proves nothing. Changing one of these
 * files is a wire-format decision and needs a version bump, a migration note,
 * and a changelog entry — see `docs/versioning.md`.
 *
 * The output goes through **prettier**, with the repo's own configuration,
 * rather than through `JSON.stringify(..., 2)`. The two disagree — prettier
 * folds a short array onto one line where `JSON.stringify` explodes it — so the
 * raw form left every regenerated fixture dirty with a pure-whitespace diff and
 * `npm run verify` then failed at `format:check`. The documented regeneration
 * path has to leave the tree in the state the gate accepts, or it is not a path.
 */
import { writeFileSync } from 'node:fs';
import { format, resolveConfig } from 'prettier';
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
  const options = await resolveConfig(path);
  // Indented input, then formatted: prettier keeps an object expanded when the
  // source had a newline after its brace, so feeding it the indented form is
  // what makes the committed one-record-per-line layout the fixed point. A
  // single-line input would be equally prettier-clean and would rewrite every
  // fixture into a denser shape nobody asked for.
  writeFileSync(path, await format(JSON.stringify(value, null, 2), { ...options, filepath: path }));
  console.log(`wrote ${path}`);
}
