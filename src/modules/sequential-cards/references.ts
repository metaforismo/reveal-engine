import { rational } from '../../core/rational.js';
import { ENGINE_API_VERSION } from '../../core/versions.js';
import { defineCardsGame } from './adapter.js';
import { SEQUENTIAL_CARDS_MODULE_ID, type SequentialCardsDefinition } from './contracts.js';

/**
 * The definitions this module ships as its own conformance subjects.
 *
 * `src/cli/conformance.ts` iterates the registry and runs every module's
 * declared references, so these are what put `sequential-cards` in
 * `reveal-conformance` and therefore in CI. Between them they cover the three
 * shapes the module claims to carry: one backed position with a full side-market
 * paytable, **two** simultaneously backed positions with independent
 * liquidations, and a multi-reveal cascade whose second reveal has to read the
 * order the first one published.
 *
 * Every number below is checked by exhaustion at `defineCardsGame()` — the cap
 * against the reachable maximum, the minimum stake against the non-zero-credit
 * threshold, and value-neutrality in every decision state.
 */

/**
 * The 3-card middle-pick shape: the reference adapter.
 *
 * Thirteen ranks, three cards, back the one that will be the **middle** value.
 * One non-backed card is cut; the two that stay down are published in rank
 * order; then hold, switch, split across both, or cash out. `EXACT:1` and
 * `EXACT:13` are absent because nothing sits below a 1 or above a 13, so those
 * markets could never pay and the definition would be refused for offering
 * them.
 *
 * Its exhaustive figures, all reproduced by `defineCardsGame()`: an opening
 * claim of `72/25` on the backed card, a largest reachable payout of `648/5`
 * (a switch in the `3:LOW` state), a smallest reachable payout of `12/275`
 * (a cash-out in `3:HIGH`), a non-zero-credit threshold of 23 credits, and a
 * best- and worst-policy return of exactly `24/25`.
 */
export const triadMiddleReference: SequentialCardsDefinition = defineCardsGame({
  apiVersion: ENGINE_API_VERSION,
  moduleId: SEQUENTIAL_CARDS_MODULE_ID,
  id: 'triad-middle-v1',
  version: '1.0.0',
  ladder: { size: 13, dealt: 3, objective: 'middle' },
  reveal: { modelVersion: 'triad-cut/v1', count: 1, eligibility: 'unbacked', sortRemaining: true },
  backing: { maxOpenBeforeReveal: 1, rebackMode: 'move' },
  sideMarkets: [
    { id: 'BAND:LOW', winningRanks: [2, 3, 4, 5] },
    { id: 'BAND:CORE', winningRanks: [6, 7, 8] },
    { id: 'BAND:HIGH', winningRanks: [9, 10, 11, 12] },
    ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((rank) => ({
      id: `EXACT:${rank}`,
      winningRanks: [rank],
    })),
  ],
  ticket: { requiresBackedMarket: true, stakeScope: 'per-selection' },
  pricing: {
    entryRtp: rational(24n, 25n),
    liquidationSpread: rational(0n),
    rounding: 'floor',
    minStakeCredits: 25n,
    stakeStepCredits: 25n,
    actions: ['switch', 'split', 'cash'],
    splitMode: 'even',
  },
  risk: { maxWinMultiple: 200n, capMustNotBind: true },
  seed: { operatorSeedScope: 'per-round', clientEntropy: 'required', clientSeedBytes: 16 },
});

/**
 * Two backed positions in one round: the multi-position shape.
 *
 * Nine ranks, five cards, back **two** of them for the middle. The eligible set
 * at the single reveal is `5 − 0 − 2 = 3`, which is what makes a second backing
 * legal here and illegal in the three-card game. Each backed selection carries
 * its own stake, its own claim, and its own liquidation, and the round's ceiling
 * is a multiple of the whole ticket rather than of whichever row came first.
 *
 * `rebackMode: 'reject'` and an action list without `split` are deliberate: they
 * are the branches the three-card reference never exercises.
 */
export const duoMiddleReference: SequentialCardsDefinition = defineCardsGame({
  apiVersion: ENGINE_API_VERSION,
  moduleId: SEQUENTIAL_CARDS_MODULE_ID,
  id: 'duo-middle-v1',
  version: '1.0.0',
  ladder: { size: 9, dealt: 5, objective: 'middle' },
  reveal: { modelVersion: 'duo-cut/v1', count: 1, eligibility: 'unbacked', sortRemaining: true },
  backing: { maxOpenBeforeReveal: 2, rebackMode: 'reject' },
  sideMarkets: [
    { id: 'BAND:LOW', winningRanks: [3, 4] },
    { id: 'BAND:HIGH', winningRanks: [6, 7] },
    { id: 'EXACT:5', winningRanks: [5] },
  ],
  ticket: { requiresBackedMarket: true, stakeScope: 'per-selection' },
  pricing: {
    entryRtp: rational(97n, 100n),
    liquidationSpread: rational(0n),
    rounding: 'floor',
    minStakeCredits: 10n,
    stakeStepCredits: 10n,
    actions: ['switch', 'cash'],
    splitMode: 'even',
  },
  risk: { maxWinMultiple: 50n, capMustNotBind: true },
  seed: { operatorSeedScope: 'per-round', clientEntropy: 'required', clientSeedBytes: 16 },
});

/**
 * Two reveals, and the reason the posterior has to be cumulative.
 *
 * Nine ranks, five cards, back the **middle**. Two cards are cut in sequence,
 * and the order published after the first cut is not discarded by the second:
 * when the second cut turns over a card the first sort had already placed, its
 * value splits that order and every survivor inherits a bound. A posterior that
 * read only the most recent sort would price this definition wrong while still
 * looking self-consistent inside each state — `deck.ts` carries the splits, and
 * this reference is what holds it to them.
 */
export const cascadeMiddleReference: SequentialCardsDefinition = defineCardsGame({
  apiVersion: ENGINE_API_VERSION,
  moduleId: SEQUENTIAL_CARDS_MODULE_ID,
  id: 'cascade-middle-v1',
  version: '1.0.0',
  ladder: { size: 9, dealt: 5, objective: 'middle' },
  reveal: {
    modelVersion: 'cascade-cut/v1',
    count: 2,
    eligibility: 'unbacked',
    sortRemaining: true,
  },
  backing: { maxOpenBeforeReveal: 1, rebackMode: 'move' },
  sideMarkets: [
    { id: 'BAND:LOW', winningRanks: [3, 4] },
    { id: 'BAND:MID', winningRanks: [5] },
    { id: 'BAND:HIGH', winningRanks: [6, 7] },
  ],
  ticket: { requiresBackedMarket: true, stakeScope: 'per-selection' },
  pricing: {
    entryRtp: rational(19n, 20n),
    liquidationSpread: rational(0n),
    rounding: 'floor',
    minStakeCredits: 10n,
    stakeStepCredits: 5n,
    actions: ['switch', 'split', 'cash'],
    splitMode: 'even',
  },
  risk: { maxWinMultiple: 150n, capMustNotBind: true },
  seed: { operatorSeedScope: 'per-round', clientEntropy: 'required', clientSeedBytes: 16 },
});

export const SEQUENTIAL_CARDS_REFERENCES: readonly SequentialCardsDefinition[] = Object.freeze([
  triadMiddleReference,
  duoMiddleReference,
  cascadeMiddleReference,
]);
