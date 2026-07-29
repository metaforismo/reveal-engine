import { describe, expect, it } from 'vitest';
import { rational } from '../src/core/rational.js';
import {
  aetherOrderClassic,
  aetherOrderSeven,
  assertPermutationAdapterConforms,
  definePermutationGame,
  type BetFamily,
  type BetInstance,
  type OutcomeView,
  type PermutationGameDefinition,
} from '../src/modules/permutation/aether/index.js';

function withChanges(changes: Partial<PermutationGameDefinition>): PermutationGameDefinition {
  return definePermutationGame({
    ...aetherOrderClassic,
    ...changes,
  });
}

function check(game: PermutationGameDefinition, id: number) {
  return assertPermutationAdapterConforms(game).checks.find((entry) => entry.id === id);
}

describe('AETHER ORDER adapter conformance', () => {
  // No per-test timeout: this case ran under a local 15 s override, which was a
  // *raise* over vitest's 5 s default on a branch that shipped no config. The
  // repository config now sets `testTimeout: 60_000` for every suite, and the
  // override had become a ceiling below it — the `seven` variant walks a
  // 128-outcome stride sample and crosses 15 s of wall clock when the whole
  // merged suite runs in parallel on one machine. The assertions are unchanged.
  it.each([
    ['classic', aetherOrderClassic, 'exhaustive'],
    ['seven', aetherOrderSeven, 'deterministic 128-outcome stride sample'],
  ] as const)(
    'passes all twelve checks for %s with an honest determinism/purity label',
    (_variant, game, mode) => {
      const report = assertPermutationAdapterConforms(game);
      expect(report.ok).toBe(true);
      expect(report.checks).toHaveLength(12);
      expect(report.checks.every((entry) => entry.ok)).toBe(true);
      expect(report.checks[2]?.detail).toContain(mode);
      expect(report.checks[3]?.detail).toContain(mode);
    },
  );

  it('locates a wrong multiplier at pricing check 7', () => {
    const game = withChanges({
      pricing: {
        ...aetherOrderClassic.pricing,
        multipliers: {
          ...aetherOrderClassic.pricing.multipliers,
          first: rational(1n),
        },
      },
    });
    expect(check(game, 7)).toMatchObject({ id: 7, ok: false });
  });

  it('locates a non-homogeneous family at check 6', () => {
    const base = aetherOrderClassic.bets.find((family) => family.code === 'first')!;
    const broken: BetFamily = Object.freeze({
      ...base,
      resolve: (instance: BetInstance, view: OutcomeView) =>
        (instance.params as { c: number }).c === 0 ? false : base.resolve(instance, view),
    });
    const game = withChanges({
      bets: Object.freeze(
        aetherOrderClassic.bets.map((family) => (family.code === 'first' ? broken : family)),
      ),
    });
    expect(check(game, 6)).toMatchObject({ id: 6, ok: false });
  });

  it('locates duplicate family codes at catalogue check 2', () => {
    const game = withChanges({
      bets: Object.freeze([...aetherOrderClassic.bets, aetherOrderClassic.bets[0]!]),
    });
    expect(check(game, 2)).toMatchObject({ id: 2, ok: false });
  });

  it('locates a mutating resolver at purity check 4', () => {
    const base = aetherOrderClassic.bets[0]!;
    const mutating: BetFamily = Object.freeze({
      ...base,
      resolve: (instance: BetInstance, view: OutcomeView) => {
        (view.perm as number[])[0] = 99;
        return base.resolve(instance, view);
      },
    });
    const game = Object.freeze({
      ...aetherOrderClassic,
      bets: Object.freeze([mutating, ...aetherOrderClassic.bets.slice(1)]),
    });
    expect(check(game, 4)).toMatchObject({ id: 4, ok: false });
  });

  it('detects behavior changed after the shipped fingerprint was memoised', () => {
    let decoy = false;
    const base = aetherOrderClassic.bets.find((family) => family.code === 'before')!;
    const switchable: BetFamily = Object.freeze({
      ...base,
      resolve: (instance: BetInstance, view: OutcomeView) => base.resolve(instance, view) !== decoy,
    });
    const game = withChanges({
      bets: Object.freeze(
        aetherOrderClassic.bets.map((family) => (family.code === 'before' ? switchable : family)),
      ),
    });
    decoy = true;
    expect(check(game, 11)).toMatchObject({ id: 11, ok: false });
  });
});
