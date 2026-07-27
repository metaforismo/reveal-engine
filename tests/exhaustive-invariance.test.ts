import { describe, expect, it } from 'vitest';
import { rational } from '../src/core/rational.js';
/** Exhaustive two-event, three-outcome guard. Exact theory only: no rounding/caps/spread/continuation. */
describe('within-round theoretical invariance', () => {
  it('holds for hold, sell-after-first, and adaptive switch strategies', () => {
    const K = 3;
    const strength = { a: 2n, b: 1n };
    const rtp = rational(97n, 100n);
    const strategies = [0, 1, 2];
    for (const strategy of strategies) {
      let expected = rational(0n);
      for (let truth = 0; truth < K; truth += 1)
        for (let target = 0; target < K; target += 1) {
          const mass = rational(
            target === truth ? strength.a : strength.b,
            BigInt(K) * (strength.a + 2n * strength.b),
          );
          const posterior =
            target === 0 ? [2n, 1n, 1n] : target === 1 ? [1n, 2n, 1n] : [1n, 1n, 2n];
          const selected = strategy === 0 ? 0 : strategy === 1 ? target : (target + 1) % K;
          const payoff =
            truth === selected
              ? rational(rtp.numerator * 4n, rtp.denominator * (posterior[selected] ?? 1n))
              : rational(0n);
          expected = {
            numerator:
              expected.numerator * mass.denominator * payoff.denominator +
              mass.numerator * payoff.numerator * expected.denominator,
            denominator: expected.denominator * mass.denominator * payoff.denominator,
          };
          const g = (a: bigint, b: bigint): bigint => (b === 0n ? a : g(b, a % b));
          const d = g(expected.numerator, expected.denominator);
          expected = { numerator: expected.numerator / d, denominator: expected.denominator / d };
        }
      expect(expected).toEqual(rtp);
    }
  });
});
