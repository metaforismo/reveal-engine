import { describe, expect, it } from 'vitest';
import { adapterFingerprint, defineGame } from '../src/core/adapter.js';
import { ENGINE_API_VERSION } from '../src/core/contracts.js';
import {
  initialPosterior,
  posteriorFor,
  probability,
  quote,
  updatePosterior,
} from '../src/core/posterior.js';
import { add, compare, divide, equal, multiply, rational } from '../src/core/rational.js';
import { binaryBeaconReference, constellationReference } from '../src/reference/index.js';

describe('rational and posterior invariants', () => {
  it('normalizes sign/gcd and compares mathematical equality', () => {
    expect(rational(-2n, -4n)).toEqual(rational(1n, 2n));
    expect(equal({ numerator: 2n, denominator: 4n }, rational(1n, 2n))).toBe(true);
    expect(add(rational(1n, 3n), rational(1n, 6n))).toEqual(rational(1n, 2n));
    expect(multiply(rational(7n, 9n), divide(rational(3n), rational(7n)))).toEqual(
      rational(1n, 3n),
    );
    expect(compare(rational(4n, 5n), rational(3n, 4n))).toBe(1);
  });

  it.each([
    [{ numerator: 1n, denominator: -1n }, 'INVALID_RATIONAL'],
    [{ numerator: 1n, denominator: 0n }, 'INVALID_RATIONAL'],
  ])('rejects malformed structural rationals %#', (value, code) => {
    expect(() => multiply(value, rational(1n))).toThrowError(expect.objectContaining({ code }));
  });

  it('normalizes probabilities exactly for every seeded reference posterior', () => {
    for (const game of [binaryBeaconReference, constellationReference]) {
      const posterior = initialPosterior(game);
      const sum = game.outcomes.reduce(
        (current, _, index) => add(current, probability(posterior, index)),
        rational(0n),
      );
      expect(sum).toEqual(rational(1n));
      expect(posterior.adapterFingerprint).toBe(adapterFingerprint(game));
    }
  });

  it('rejects forged totals and cross-adapter state', () => {
    const valid = initialPosterior(binaryBeaconReference);
    expect(() => probability({ ...valid, total: 999n }, 0)).toThrowError(
      expect.objectContaining({ code: 'INVALID_POSTERIOR' }),
    );
    expect(() => quote(constellationReference, valid, 0, true, 0)).toThrowError(
      expect.objectContaining({ code: 'ADAPTER_MISMATCH' }),
    );
  });

  it('is invariant to common likelihood scaling and batched versus streamed updates', () => {
    const initial = initialPosterior(constellationReference);
    const event = { index: 0, target: 1, favour: 5n, other: 2n, label: 'x' };
    const scaled = { ...event, favour: 35n, other: 14n };
    expect(updatePosterior(initial, event).weights).toEqual(
      updatePosterior(initial, scaled).weights,
    );
    const events = [event, { index: 1, target: 2, favour: 3n, other: 1n, label: 'y' }];
    expect(posteriorFor(constellationReference, events)).toEqual(
      updatePosterior(updatePosterior(initial, events[0]!), events[1]!),
    );
  });

  it('binds fingerprint to economics and evidence model identity', () => {
    const changed = defineGame({
      ...binaryBeaconReference,
      adapterVersion: '1.0.1',
      pricing: { ...binaryBeaconReference.pricing, firstEntryRtp: rational(98n, 100n) },
    });
    expect(adapterFingerprint(changed)).not.toBe(adapterFingerprint(binaryBeaconReference));
    expect(changed.apiVersion).toBe(ENGINE_API_VERSION);
  });
});
