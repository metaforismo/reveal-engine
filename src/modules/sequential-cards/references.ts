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

/**
 * The same three-card game, credited with the **settlement draw**.
 *
 * `triad/docs/ENGINE.md` §4.1 declares `rounding: 'stochastic'` and
 * `triad/docs/MATH.md` §13.3 is the argument for it: flooring is biased against
 * the player by `r/d` at every credit event, so the realised return in credits
 * is strictly below `entryRtp` at every finite stake, while the draw pays
 * `q + 1` with probability exactly `r/d` and is therefore unbiased at every
 * stake and under every policy.
 *
 * It ships as a reference rather than as a code path with no subject, because
 * `CARDS_ROUNDING_UNBIASED` and `CARDS_ROUNDING_BOUNDED` have nothing to bite on
 * under a deterministic rule: a check that only ever runs where it cannot fail
 * is not evidence. Every other field is `triad-middle-v1`'s, so the two
 * references differ in exactly the parameter under test — and, `rounding` being
 * inside the fingerprint, they are different adapters that cannot share a
 * commitment.
 *
 * Its cap headroom is the one figure the draw moves: the reachable maximum is
 * still `648/5` of stake, but the credited ceiling is `648/5 + 1/25` = `3241/25`
 * = 129.64×, because the draw can pay one whole credit above the claim's whole
 * part and the minimum stake is where that credit is proportionally largest.
 * Still strictly below the 200× rail, and `defineCardsGame` checks it there
 * rather than at a larger stake where it would look harmless.
 */
export const triadStochasticReference: SequentialCardsDefinition = defineCardsGame({
  ...triadMiddleReference,
  id: 'triad-stochastic-v1',
  pricing: { ...triadMiddleReference.pricing, rounding: 'stochastic' },
});

/**
 * `triad/docs/ENGINE.md` §4.1's worked definition, field for field.
 *
 * The consuming game declares a `dormancy` policy alongside the settlement draw,
 * and until this revision the module refused the field by name — so the spec's
 * own code block did not construct, and the compatibility claim in §12.1 rested
 * on deleting a line from it. This reference is that definition as written, so
 * the claim is now a thing the build runs rather than a thing the document says:
 * `tests/sequential-cards/dormancy.test.ts` constructs §4.1 verbatim and asserts
 * it fingerprints identically to this.
 *
 * It is also what gives `CARDS_EVERY_ROUND_SETTLES` and
 * `CARDS_DORMANT_ACTION_OFFERED` a subject. A check that only ever runs where it
 * cannot fail is not evidence, which is the same reason `triad-stochastic-v1`
 * ships beside `triad-middle-v1`.
 */
export const triadDormantReference: SequentialCardsDefinition = defineCardsGame({
  ...triadStochasticReference,
  id: 'triad-dormant-v1',
  dormancy: {
    windowSeconds: 86_400,
    onDormant: 'cash',
    earlySettlementReasons: ['account-state-changed'],
  },
});

export const SEQUENTIAL_CARDS_REFERENCES: readonly SequentialCardsDefinition[] = Object.freeze([
  triadMiddleReference,
  triadStochasticReference,
  triadDormantReference,
  duoMiddleReference,
  cascadeMiddleReference,
]);
