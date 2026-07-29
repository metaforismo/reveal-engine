import { rational } from '../../../core/rational.js';
import { definePermutationGame } from '../definition.js';
import type { PermutationDefinition } from '../contracts.js';

/**
 * The smallest draw the module admits: three items, six orders.
 *
 * It exists to keep the floor of the supported range under the same conformance
 * sweep as the reference game, because `n = 3` is where the edge cases live. It
 * is the only size at which `stack` has just two adjacent position pairs, at
 * which a `full` bet is one of six rather than one of thousands, and at which
 * the round emits only two reveals — so the "the last position is forced"
 * argument is doing its most visible work.
 *
 * `rho = 24/25`, the same as the reference game, so the paytable is
 * `24/25 x 6 = 144/25` for `full` and `24/25 x 3 = 72/25` for the other four.
 * Both denominators divide the 25-chip quantum, so payouts stay exact integers.
 */
export const triadReference: PermutationDefinition = definePermutationGame({
  id: 'triad',
  version: '1.0.0',
  items: ['one', 'two', 'three'],
  rtp: rational(24n, 25n),
  paytable: {
    full: rational(144n, 25n),
    slot: rational(72n, 25n),
    first: rational(72n, 25n),
    last: rational(72n, 25n),
    stack: rational(72n, 25n),
  },
  maxWinMultiple: 1_000n,
  stakeQuantum: 25n,
  minLineStake: 25n,
  maxLineStake: 2_500n,
  maxTicketStake: 10_000n,
  maxOpenBets: 6,
});
