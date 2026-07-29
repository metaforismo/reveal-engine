import { rational } from '../../../core/rational.js';
import { definePermutationGame } from '../definition.js';
import type { PermutationDefinition } from '../contracts.js';

/**
 * AETHER ORDER, the reference adapter this module ships against.
 *
 * `aether-order/docs/ENGINE.md` specifies a permutation lifecycle for a game
 * whose round is one settled column of coloured spheres, and
 * `aether-order/docs/MATH.md` publishes the exact paytable. Both variants are
 * reproduced here as conformance subjects, so the module's own CI proves the
 * economics the game's documentation claims, rather than the two agreeing by
 * assertion.
 *
 * Every figure below is transcribed from `aether-order/docs/paytable.json`,
 * which is generated from that repository's exhaustive enumerator. Nothing here
 * is a rounded or restated version of it:
 *
 * | code | `p` (n = 5) | multiplier | `p` (n = 7) | multiplier |
 * | ----- | ----------- | ---------- | ----------- | ---------- |
 * | `full` | `1/120` | `576/5` | `1/5040` | `24192/5` |
 * | `slot` | `1/5` | `24/5` | `1/7` | `168/25` |
 * | `first` | `1/5` | `24/5` | `1/7` | `168/25` |
 * | `last` | `1/5` | `24/5` | `1/7` | `168/25` |
 * | `stack` | `1/5` | `24/5` | `1/7` | `168/25` |
 *
 * `rho = 24/25` exactly, on every chip. That uniformity is a player-protection
 * property rather than a marketing one: the `115.20x` chip and the `4.80x` chip
 * carry the identical 4.000% edge, so chasing the big multiplier buys variance
 * and never a worse deal. `definePermutationGame` refuses to construct any of
 * these if a single multiplier drifts.
 *
 * **What this module ships is five of the game's eleven families.** AETHER ORDER
 * also prices `before`, `early`, `late`, `neighbours`, `opening` and `podium`.
 * Those are not expressible as a disjunction of *pairwise exclusive* position
 * pins the way these five are — `before {a, b}` alone covers `n!/2` orders — and
 * pricing them exactly needs a different counting argument. They are out of
 * scope for this version and their absence is stated here rather than implied by
 * silence; see `docs/modules/permutation.md`.
 */

const RTP = rational(24n, 25n);

/** 25 chips = 0.25 credits. Every published multiplier's denominator divides it. */
const STAKE_QUANTUM = 25n;

/**
 * An inert liability guard, not an advertised prize.
 *
 * The largest line multiplier is `576/5` at `n = 5` and `24192/5` at `n = 7`,
 * both strictly below `5000`, so the cap never reduces a payout and never
 * silently degrades the advertised RTP. `PRICING_IDENTITY_BROKEN` reports the
 * headroom, so a paytable edit that made the cap start biting would surface as
 * a conformance failure instead of an invisible RTP cut.
 */
const MAX_WIN_MULTIPLE = 5_000n;

const RISK = {
  maxWinMultiple: MAX_WIN_MULTIPLE,
  stakeQuantum: STAKE_QUANTUM,
  minLineStake: 25n,
  maxLineStake: 5_000n,
  maxTicketStake: 20_000n,
  maxOpenBets: 12,
} as const;

/** CLASSIC: five spheres, 120 orders. */
export const aetherOrderClassicReference: PermutationDefinition = definePermutationGame({
  id: 'aether-order-classic',
  version: '1.0.0',
  items: ['amber', 'coral', 'violet', 'aqua', 'ivory'],
  rtp: RTP,
  paytable: {
    full: rational(576n, 5n),
    slot: rational(24n, 5n),
    first: rational(24n, 5n),
    last: rational(24n, 5n),
    stack: rational(24n, 5n),
  },
  ...RISK,
});

/** SEVEN: seven spheres, 5,040 orders, and the largest prize the format can prove. */
export const aetherOrderSevenReference: PermutationDefinition = definePermutationGame({
  id: 'aether-order-seven',
  version: '1.0.0',
  items: ['amber', 'coral', 'violet', 'aqua', 'ivory', 'indigo', 'rose'],
  rtp: RTP,
  paytable: {
    full: rational(24192n, 5n),
    slot: rational(168n, 25n),
    first: rational(168n, 25n),
    last: rational(168n, 25n),
    stack: rational(168n, 25n),
  },
  ...RISK,
});
