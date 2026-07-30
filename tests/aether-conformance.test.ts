import { describe, expect, it } from 'vitest';
import { rational } from '../src/core/rational.js';
import {
  aetherOrderClassic,
  aetherOrderSix,
  assertPermutationAdapterConforms,
  definePermutationGame,
  definePermutationGameAsync,
  permutationAdapterFingerprint,
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

describe('AETHER ORDER adapter conformance', () => {
  // No per-test timeout: this case ran under a local 15 s override, which was a
  // *raise* over vitest's 5 s default on a branch that shipped no config. The
  // repository config now sets `testTimeout: 60_000` for every suite, and the
  // override had become a ceiling below it — the `seven` variant walks a
  // 128-outcome stride sample and crosses 15 s of wall clock when the whole
  // merged suite runs in parallel on one machine. The assertions are unchanged.
  it.each([
    ['classic', aetherOrderClassic, 'exhaustive'],
    ['six', aetherOrderSix, 'exhaustive'],
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
    expect(() =>
      withChanges({
        pricing: {
          ...aetherOrderClassic.pricing,
          multipliers: {
            ...aetherOrderClassic.pricing.multipliers,
            first: rational(1n),
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER' }));
  });

  it('locates a non-homogeneous family at check 6', () => {
    const base = aetherOrderClassic.bets.find((family) => family.code === 'first')!;
    const broken: BetFamily = Object.freeze({
      ...base,
      resolve: (instance: BetInstance, view: OutcomeView) =>
        (instance.params as { c: number }).c === 0 ? false : base.resolve(instance, view),
    });
    expect(() =>
      withChanges({
        bets: Object.freeze(
          aetherOrderClassic.bets.map((family) => (family.code === 'first' ? broken : family)),
        ),
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER' }));
  });

  it('locates duplicate family codes at catalogue check 2', () => {
    expect(() =>
      withChanges({
        bets: Object.freeze([...aetherOrderClassic.bets, aetherOrderClassic.bets[0]!]),
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER' }));
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
    expect(
      assertPermutationAdapterConforms(game).checks.find((entry) => entry.id === 4),
    ).toMatchObject({ id: 4, ok: false });
  });

  it('detects behavior changed after the shipped fingerprint was memoised', () => {
    let decoy = false;
    const base = aetherOrderClassic.bets.find((family) => family.code === 'before')!;
    const switchable: BetFamily = Object.freeze({
      ...base,
      resolve: (instance: BetInstance, view: OutcomeView) => base.resolve(instance, view) !== decoy,
    });
    const game = {
      ...aetherOrderClassic,
      bets: Object.freeze(
        aetherOrderClassic.bets.map((family) => (family.code === 'before' ? switchable : family)),
      ),
    } as PermutationGameDefinition;
    permutationAdapterFingerprint(game);
    decoy = true;
    expect(assertPermutationAdapterConforms(game).checks[10]).toMatchObject({ id: 11, ok: false });
  });

  it('rejects negative economics and normalizes accepted rationals', () => {
    expect(() =>
      withChanges({
        pricing: {
          ...aetherOrderClassic.pricing,
          multipliers: {
            ...aetherOrderClassic.pricing.multipliers,
            first: { numerator: -24n, denominator: 5n },
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER' }));
    expect(() =>
      withChanges({
        pricing: {
          ...aetherOrderClassic.pricing,
          targetRtp: { numerator: 101n, denominator: 100n },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER' }));
    const normalized = withChanges({
      pricing: {
        ...aetherOrderClassic.pricing,
        targetRtp: { numerator: 48n, denominator: 50n },
      },
    });
    expect(normalized.pricing.targetRtp).toEqual(rational(24n, 25n));
  });

  it('rejects over-budget definitions before invoking a family callback', () => {
    let callbacks = 0;
    const family: BetFamily = Object.freeze({
      ...aetherOrderClassic.bets[0]!,
      enumerateInstances: (n: number) => {
        callbacks += 1;
        return aetherOrderClassic.bets[0]!.enumerateInstances(n);
      },
    });
    expect(() =>
      definePermutationGame({
        ...aetherOrderClassic,
        variantId: 'over-budget-eight',
        n: 8,
        elements: Object.freeze(Array.from({ length: 8 }, (_, index) => `e${index}`)),
        bets: Object.freeze([family]),
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER', path: '$.n' }));
    expect(callbacks).toBe(0);
  });

  it('offers a yielding exhaustive constructor for declarations rejected synchronously', async () => {
    const first = aetherOrderClassic.bets.find((family) => family.code === 'first')!;
    const declaration: PermutationGameDefinition = {
      ...aetherOrderClassic,
      variantId: 'yielding-seven',
      n: 7,
      elements: Object.freeze(Array.from({ length: 7 }, (_, index) => `e${index}`)),
      bets: Object.freeze([first]),
      pricing: {
        ...aetherOrderClassic.pricing,
        multipliers: Object.freeze({ first: rational(168n, 25n) }),
      },
    };
    expect(() => definePermutationGame(declaration)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ADAPTER', path: '$.n' }),
    );
    let timerRan = false;
    setImmediate(() => {
      timerRan = true;
    });
    const game = await definePermutationGameAsync(declaration, { yieldEvery: 1_000 });
    expect(game.n).toBe(7);
    expect(game.bets.map((family) => family.code)).toEqual(['first']);
    expect(timerRan).toBe(true);
    expect(permutationAdapterFingerprint(game)).toMatch(/^[0-9a-f]{64}$/u);
  });
});
