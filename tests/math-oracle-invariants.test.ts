import { describe, expect, it } from 'vitest';
import { defineGame } from '../src/core/adapter.js';
import {
  ENGINE_API_VERSION,
  type EvidenceEvent,
  type GameDefinition,
} from '../src/core/contracts.js';
import { makeTranscript } from '../src/core/fairness.js';
import { payable, payableWithinCap } from '../src/core/payments.js';
import {
  fairValueClaim,
  initialPosterior,
  posteriorFor,
  probability,
  quote,
} from '../src/core/posterior.js';
import { add, compare, floor, multiply, rational, type Rational } from '../src/core/rational.js';
import {
  binaryBeaconReference,
  blackSignalReference,
  constellationReference,
} from '../src/reference/index.js';
import { seed } from './helpers.js';

class Fraction {
  constructor(
    readonly n: bigint,
    readonly d = 1n,
  ) {
    if (d === 0n) throw new Error('zero');
  }
  add(other: Fraction): Fraction {
    return new Fraction(this.n * other.d + other.n * this.d, this.d * other.d).reduce();
  }
  mul(other: Fraction): Fraction {
    return new Fraction(this.n * other.n, this.d * other.d).reduce();
  }
  reduce(): Fraction {
    const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));
    const g = gcd(this.n, this.d);
    const sign = this.d < 0n ? -1n : 1n;
    return new Fraction((sign * this.n) / g, (sign * this.d) / g);
  }
  static from(value: Rational): Fraction {
    return new Fraction(value.numerator, value.denominator).reduce();
  }
}

function oracleWeights(game: GameDefinition, events: readonly EvidenceEvent[]): bigint[] {
  return game.priorWeights.map((prior, outcome) =>
    events.reduce(
      (weight, event) => weight * (event.target === outcome ? event.favour : event.other),
      prior,
    ),
  );
}
function gcdAll(values: readonly bigint[]): bigint {
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
  return values.reduce((a, b) => gcd(a, b));
}

describe('independent Bayesian and pricing oracles', () => {
  it.each([blackSignalReference, constellationReference, binaryBeaconReference])(
    '$id matches raw-weight oracle across 16 seeds',
    (game) => {
      for (let index = 0; index < 16; index += 1) {
        const transcript = makeTranscript(seed(index), game, `oracle-${index}`);
        for (
          let length = 0;
          length <= transcript.evidence.length;
          length += Math.max(1, Math.floor(transcript.evidence.length / 4))
        ) {
          const events = transcript.evidence.slice(0, length);
          const engine = posteriorFor(game, events);
          const oracle = oracleWeights(game, events);
          for (let outcome = 0; outcome < game.outcomes.length; outcome += 1)
            expect(engine.weights[outcome]! * oracle[0]!).toBe(
              engine.weights[0]! * oracle[outcome]!,
            );
          expect(engine.total).toBe(engine.weights.reduce((sum, weight) => sum + weight, 0n));
          expect(gcdAll(engine.weights)).toBe(1n);
          const normalization = game.outcomes.reduce(
            (sum, _, outcome) => add(sum, probability(engine, outcome)),
            rational(0n),
          );
          expect(normalization).toEqual(rational(1n));
        }
      }
    },
  );

  it('proves first-entry and re-entry conditional values symbolically', () => {
    for (const game of [blackSignalReference, constellationReference, binaryBeaconReference]) {
      const transcript = makeTranscript(seed(31), game, 'quotes');
      const posterior = posteriorFor(
        game,
        transcript.evidence.slice(0, Math.floor(transcript.evidence.length / 2)),
      );
      for (let outcome = 0; outcome < game.outcomes.length; outcome += 1) {
        const p = probability(posterior, outcome);
        expect(multiply(p, quote(game, posterior, outcome, true, 0).multiplier)).toEqual(
          game.pricing.firstEntryRtp,
        );
        expect(multiply(p, quote(game, posterior, outcome, false, 0).multiplier)).toEqual(
          rational(1n),
        );
      }
    }
  });

  it('bounds entry quantization below one probability unit', () => {
    const game = binaryBeaconReference;
    const posterior = initialPosterior(game);
    for (const stake of [1n, 2n, 7n, 101n, 10_000n]) {
      for (let outcome = 0; outcome < game.outcomes.length; outcome += 1) {
        const p = probability(posterior, outcome);
        for (const first of [true, false]) {
          const target = first
            ? multiply(rational(stake), game.pricing.firstEntryRtp)
            : rational(stake);
          const payout = floor(
            multiply(rational(stake), quote(game, posterior, outcome, first, 0).multiplier),
          );
          const realised = multiply(p, rational(payout));
          expect(compare(target, realised)).not.toBe(-1);
          const loss = add(target, rational(-realised.numerator, realised.denominator));
          expect(compare(loss, p)).toBe(-1);
        }
      }
    }
  });

  it('keeps payable/cap monotone and bounded at integer edges', () => {
    let previous = 0n;
    for (let theoretical = 0n; theoretical <= 250n; theoretical += 1n) {
      const result = payable(rational(theoretical), 10n, 7n);
      expect(result.credited).toBeGreaterThanOrEqual(previous);
      expect(result.credited).toBeLessThanOrEqual(theoretical);
      expect(result.credited).toBeLessThanOrEqual(70n);
      previous = result.credited;
    }
    expect(payableWithinCap(rational(100n), 10n, 7n, 69n).credited).toBe(1n);
    expect(payableWithinCap(rational(100n), 10n, 7n, 70n).credited).toBe(0n);
  });
});

describe('exhaustive within-round strategy invariance under stated assumptions', () => {
  const game = defineGame({
    apiVersion: ENGINE_API_VERSION,
    adapterVersion: '1.0.0',
    id: 'exhaustive-binary-oracle',
    outcomes: ['zero', 'one'],
    priorWeights: [1n, 1n],
    evidence: { modelVersion: 'two-ticks/v1', eventCount: 2, derive: () => [] },
    pricing: {
      firstEntryRtp: rational(97n, 100n),
      liquidationSpread: rational(0n),
      rounding: 'floor',
    },
    risk: { maxWinMultiple: 1_000_000n },
  });
  const schedules = Array.from({ length: 4 }, (_, code) => [code & 1, (code >> 1) & 1]);

  function mass(truth: number, targets: readonly number[]): Fraction {
    return targets.reduce(
      (value, target) => value.mul(new Fraction(target === truth ? 2n : 1n, 3n)),
      new Fraction(1n, 2n),
    );
  }
  function events(targets: readonly number[]): EvidenceEvent[] {
    return targets.map((target, index) => ({
      index,
      target,
      favour: 2n,
      other: 1n,
      label: `tick-${index}`,
    }));
  }

  it.each(['hold', 'sell-after-first', 'chase-latest'] as const)(
    '%s returns exact theoretical RTP',
    (strategy) => {
      let expected = new Fraction(0n);
      for (let truth = 0; truth < 2; truth += 1)
        for (const targets of schedules) {
          const path = events(targets);
          let pick = 0;
          let claim = quote(game, initialPosterior(game), pick, true, 0).multiplier;
          let payoff: Rational;
          if (strategy === 'hold') payoff = truth === pick ? claim : rational(0n);
          else if (strategy === 'sell-after-first')
            payoff = fairValueClaim(
              claim,
              posteriorFor(game, path.slice(0, 1)),
              pick,
              rational(0n),
            );
          else {
            for (let frame = 1; frame <= path.length; frame += 1) {
              const posterior = posteriorFor(game, path.slice(0, frame));
              const nextPick = path[frame - 1]!.target;
              if (nextPick !== pick) {
                const cash = fairValueClaim(claim, posterior, pick, rational(0n));
                claim = multiply(cash, quote(game, posterior, nextPick, false, frame).multiplier);
                pick = nextPick;
              }
            }
            payoff = truth === pick ? claim : rational(0n);
          }
          expected = expected.add(mass(truth, targets).mul(Fraction.from(payoff)));
        }
      expect(expected.reduce()).toEqual(new Fraction(97n, 100n));
    },
  );
});
