import { rational } from '../../../core/rational.js';
import {
  definePermutationGame,
  type PermutationGameDefinition,
  type PermutationPricingPolicy,
  type PermutationPlayPolicy,
  type PermutationRiskPolicy,
} from './definition.js';
import {
  factorial,
  orderKey,
  unrankPermutation,
  type BetFamily,
  type BetInstance,
  type OutcomeView,
} from './families.js';
import { ENGINE_API_VERSION, PERMUTATION_MODULE_VERSION } from './identity.js';

const instance = (code: string, params: object, label: string): BetInstance =>
  Object.freeze({ code, params: Object.freeze(params), label });

function orderedPairs(n: number): readonly (readonly [number, number])[] {
  const result: [number, number][] = [];
  for (let first = 0; first < n; first += 1)
    for (let second = 0; second < n; second += 1)
      if (first !== second) result.push([first, second]);
  return result;
}

function unorderedPairs(n: number): readonly (readonly [number, number])[] {
  const result: [number, number][] = [];
  for (let first = 0; first < n; first += 1)
    for (let second = first + 1; second < n; second += 1) result.push([first, second]);
  return result;
}

function orderedTriples(n: number): readonly (readonly [number, number, number])[] {
  const result: [number, number, number][] = [];
  for (let first = 0; first < n; first += 1)
    for (let second = 0; second < n; second += 1) {
      if (second === first) continue;
      for (let third = 0; third < n; third += 1)
        if (third !== first && third !== second) result.push([first, second, third]);
    }
  return result;
}

/**
 * AETHER ORDER's adapter-owned catalogue. Nothing in the lifecycle imports this
 * list; it is merely the reference adapter shipped beside the generic module.
 */
export const AETHER_ORDER_BET_FAMILIES: readonly BetFamily[] = Object.freeze([
  Object.freeze({
    code: 'before',
    name: 'BEFORE',
    tier: 'FLOW',
    picks: 'two colours, in order',
    rule: 'The first colour settles at any slot below the second colour.',
    enumerateInstances: (n: number) =>
      orderedPairs(n).map(([a, b]) => instance('before', { a, b }, `${a}<${b}`)),
    resolve: (bet: BetInstance, view: OutcomeView) =>
      (view.pos[(bet.params as { a: number }).a] as number) <
      (view.pos[(bet.params as { b: number }).b] as number),
  }),
  Object.freeze({
    code: 'early',
    name: 'EARLY',
    tier: 'FLOW',
    picks: 'one colour',
    rule: 'The colour is one of the first two spheres to settle.',
    enumerateInstances: (n: number) =>
      Array.from({ length: n }, (_, c) => instance('early', { c }, `e${c}`)),
    resolve: (bet: BetInstance, view: OutcomeView) =>
      (view.pos[(bet.params as { c: number }).c] as number) <= 1,
  }),
  Object.freeze({
    code: 'late',
    name: 'LATE',
    tier: 'FLOW',
    picks: 'one colour',
    rule: 'The colour is one of the last two spheres to settle.',
    enumerateInstances: (n: number) =>
      Array.from({ length: n }, (_, c) => instance('late', { c }, `l${c}`)),
    resolve: (bet: BetInstance, view: OutcomeView) =>
      (view.pos[(bet.params as { c: number }).c] as number) >= view.n - 2,
  }),
  Object.freeze({
    code: 'neighbours',
    name: 'NEIGHBOURS',
    tier: 'FLOW',
    picks: 'two colours',
    rule: 'The two colours settle in adjacent slots, in either order.',
    enumerateInstances: (n: number) =>
      unorderedPairs(n).map(([a, b]) => instance('neighbours', { a, b }, `${a}~${b}`)),
    resolve: (bet: BetInstance, view: OutcomeView) => {
      const { a, b } = bet.params as { a: number; b: number };
      return Math.abs((view.pos[a] as number) - (view.pos[b] as number)) === 1;
    },
  }),
  Object.freeze({
    code: 'first',
    name: 'FIRST',
    tier: 'FORM',
    picks: 'one colour',
    rule: 'The colour is the first sphere to settle.',
    enumerateInstances: (n: number) =>
      Array.from({ length: n }, (_, c) => instance('first', { c }, `f${c}`)),
    resolve: (bet: BetInstance, view: OutcomeView) =>
      (view.pos[(bet.params as { c: number }).c] as number) === 0,
  }),
  Object.freeze({
    code: 'last',
    name: 'LAST',
    tier: 'FORM',
    picks: 'one colour',
    rule: 'The colour is the last sphere to settle.',
    enumerateInstances: (n: number) =>
      Array.from({ length: n }, (_, c) => instance('last', { c }, `t${c}`)),
    resolve: (bet: BetInstance, view: OutcomeView) =>
      (view.pos[(bet.params as { c: number }).c] as number) === view.n - 1,
  }),
  Object.freeze({
    code: 'slot',
    name: 'SLOT',
    tier: 'FORM',
    picks: 'one colour and one slot',
    rule: 'The colour settles in exactly that slot.',
    enumerateInstances: (n: number) => {
      const result: BetInstance[] = [];
      for (let c = 0; c < n; c += 1)
        for (let k = 0; k < n; k += 1) result.push(instance('slot', { c, k }, `${c}@${k}`));
      return result;
    },
    resolve: (bet: BetInstance, view: OutcomeView) => {
      const { c, k } = bet.params as { c: number; k: number };
      return view.pos[c] === k;
    },
  }),
  Object.freeze({
    code: 'stack',
    name: 'STACK',
    tier: 'FORM',
    picks: 'two colours, in order',
    rule: 'The second colour settles immediately above the first.',
    enumerateInstances: (n: number) =>
      orderedPairs(n).map(([a, b]) => instance('stack', { a, b }, `${a}>${b}`)),
    resolve: (bet: BetInstance, view: OutcomeView) => {
      const { a, b } = bet.params as { a: number; b: number };
      return view.pos[b] === (view.pos[a] as number) + 1;
    },
  }),
  Object.freeze({
    code: 'opening',
    name: 'OPENING',
    tier: 'ORDER',
    picks: 'two colours, in order',
    rule: 'The two colours are the first two to settle, in order.',
    enumerateInstances: (n: number) =>
      orderedPairs(n).map(([a, b]) => instance('opening', { a, b }, `${a}${b}|open`)),
    resolve: (bet: BetInstance, view: OutcomeView) => {
      const { a, b } = bet.params as { a: number; b: number };
      return view.pos[a] === 0 && view.pos[b] === 1;
    },
  }),
  Object.freeze({
    code: 'podium',
    name: 'PODIUM',
    tier: 'ORDER',
    picks: 'three colours, in order',
    rule: 'The three colours are the first three to settle, in order.',
    enumerateInstances: (n: number) =>
      orderedTriples(n).map(([a, b, c]) => instance('podium', { a, b, c }, `${a}${b}${c}|pod`)),
    resolve: (bet: BetInstance, view: OutcomeView) => {
      const { a, b, c } = bet.params as { a: number; b: number; c: number };
      return view.pos[a] === 0 && view.pos[b] === 1 && view.pos[c] === 2;
    },
  }),
  Object.freeze({
    code: 'full',
    name: 'FULL ORDER',
    tier: 'ORDER',
    picks: 'the complete order of every colour',
    rule: 'Every sphere settles in exactly the chosen slot.',
    enumerateInstances: (n: number) =>
      Array.from({ length: factorial(n) }, (_, rank) => {
        const order = orderKey(unrankPermutation(n, rank));
        return instance('full', { order }, `full:${order}`);
      }),
    resolve: (bet: BetInstance, view: OutcomeView) =>
      view.order === (bet.params as { order: string }).order,
  }),
]);

export const AETHER_ORDER_ELEMENTS = Object.freeze([
  'amber',
  'coral',
  'violet',
  'aqua',
  'ivory',
  'indigo',
  'rose',
]);

export const AETHER_ORDER_TARGET_RTP = rational(24n, 25n);
export const AETHER_ORDER_STAKE_QUANTUM = 25n;

export const AETHER_ORDER_RISK_POLICY: PermutationRiskPolicy = Object.freeze({
  maxWinMultiple: 5000n,
  maxLinesPerTicket: 12,
  minLineStake: 25n,
  maxLineStake: 5000n,
  maxTicketStake: 20000n,
  requireDistinctLines: true,
});

export const AETHER_ORDER_PLAY_POLICY: PermutationPlayPolicy = Object.freeze({
  minRoundCycleMs: 2500,
  maxRoundsPerRollingHour: 900,
  realityCheckMinutes: Object.freeze([30, 60]),
  realityCheckRecurrenceMinutes: 60,
  playerRealityCheckIntervalOptions: Object.freeze([15, 30, 60]),
  realityCheckOverride: 'tighten-only',
  skipShortensPresentationOnly: true,
  autoplay: 'none',
});

const classicPricing: PermutationPricingPolicy = Object.freeze({
  targetRtp: AETHER_ORDER_TARGET_RTP,
  rounding: 'floor',
  stakeQuantum: AETHER_ORDER_STAKE_QUANTUM,
  multipliers: Object.freeze({
    before: rational(48n, 25n),
    early: rational(12n, 5n),
    late: rational(12n, 5n),
    neighbours: rational(12n, 5n),
    first: rational(24n, 5n),
    last: rational(24n, 5n),
    slot: rational(24n, 5n),
    stack: rational(24n, 5n),
    opening: rational(96n, 5n),
    podium: rational(288n, 5n),
    full: rational(576n, 5n),
  }),
});

const sevenPricing: PermutationPricingPolicy = Object.freeze({
  targetRtp: AETHER_ORDER_TARGET_RTP,
  rounding: 'floor',
  stakeQuantum: AETHER_ORDER_STAKE_QUANTUM,
  multipliers: Object.freeze({
    before: rational(48n, 25n),
    early: rational(84n, 25n),
    late: rational(84n, 25n),
    neighbours: rational(84n, 25n),
    first: rational(168n, 25n),
    last: rational(168n, 25n),
    slot: rational(168n, 25n),
    stack: rational(168n, 25n),
    opening: rational(1008n, 25n),
    podium: rational(1008n, 5n),
    full: rational(24192n, 5n),
  }),
});

function definition(
  variantId: 'classic' | 'seven',
  n: 5 | 7,
  pricing: PermutationPricingPolicy,
): PermutationGameDefinition {
  return definePermutationGame({
    apiVersion: ENGINE_API_VERSION,
    moduleVersion: PERMUTATION_MODULE_VERSION,
    adapterVersion: '1.3.0',
    id: 'aether-order',
    variantId,
    n,
    elements: Object.freeze(AETHER_ORDER_ELEMENTS.slice(0, n)),
    bets: AETHER_ORDER_BET_FAMILIES,
    pricing,
    risk: AETHER_ORDER_RISK_POLICY,
    play: AETHER_ORDER_PLAY_POLICY,
  });
}

export const aetherOrderClassic = definition('classic', 5, classicPricing);
export const aetherOrderSeven = definition('seven', 7, sevenPricing);
export const AETHER_ORDER_DEFINITIONS = Object.freeze({
  classic: aetherOrderClassic,
  seven: aetherOrderSeven,
});
