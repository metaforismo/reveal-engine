import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RevealEngineError } from '../src/api/errors.js';
import { sha256Hex, uniformBigInt, type SamplerScope } from '../src/core/random.js';
import { compare, rational, type Rational } from '../src/core/rational.js';
import { COMMITMENT_VERSION } from '../src/core/versions.js';
import { encodeFields } from '../src/internal/canonical.js';

/**
 * The evidence for `uniformBigInt`'s unbiasedness.
 *
 * `docs/modules/permutation.md` §2 Lemma B ended "that is core's property and
 * core's test; this module does not restate it and does not reimplement it".
 * There was no such test. `tests/core-primitives.test.ts` covered that the
 * output is a genuine permutation, that it is deterministic, that label / round
 * / seed separate the draw, and that the size limit holds — nothing anywhere
 * asserted the acceptance boundary, residue equidistribution, or the absence of
 * modulo bias. The fairness argument bottomed out on a citation to a file.
 *
 * Compounding it: for every modulus this repository's modules actually use,
 * `2^256 mod M` is 0, 1, 2 or 4, so the rejection branch fires with probability
 * around `2^-254` and was executed by no test at all. Deleting the loop and
 * returning `value % modulus` would have been invisible to the whole suite while
 * reintroducing modulo bias for any future modulus that is not a near-divisor of
 * `2^256`.
 *
 * These tests close both halves: the boundary is checked arithmetically over a
 * wide modulus range, and the rejection loop is driven into its taken branch by
 * a modulus that rejects roughly half of all draws, with the accepted value
 * pinned against an independent reimplementation of the payload.
 */

const RANGE = 1n << 256n;

/** The scope every probe below shares; the sampler's own validation covers it. */
const SCOPE: SamplerScope = Object.freeze({
  domain: 'sampler-evidence',
  roundId: 'round-0',
  proofVersion: COMMITMENT_VERSION,
});

/**
 * The §7.3 payload, written out here rather than imported.
 *
 * The point of this file is to check the shipped sampler against the
 * specification, so the specification has to exist somewhere other than inside
 * the thing being checked.
 */
function drawValue(
  seedHex: string,
  scope: SamplerScope,
  label: string,
  counter: number,
  nonce: bigint,
  modulus: bigint,
): bigint {
  const payload = encodeFields([
    'sampler',
    COMMITMENT_VERSION,
    scope.domain,
    scope.roundId,
    label,
    counter,
    nonce,
    modulus,
  ]);
  return BigInt(
    `0x${createHmac('sha256', Buffer.from(seedHex, 'hex')).update(payload).digest('hex')}`,
  );
}

/** How many rejections the specification requires before this draw is accepted. */
function rejectionsBefore(
  seedHex: string,
  scope: SamplerScope,
  label: string,
  counter: number,
  modulus: bigint,
): { readonly rejections: bigint; readonly accepted: bigint } {
  const limit = RANGE - (RANGE % modulus);
  for (let nonce = 0n; ; nonce += 1n) {
    const value = drawValue(seedHex, scope, label, counter, nonce, modulus);
    if (value < limit) return { rejections: nonce, accepted: value % modulus };
  }
}

function probeSeed(index: number): string {
  return sha256Hex(`sampler-evidence/${index}`);
}

describe('the acceptance region is an exact multiple of the modulus', () => {
  /**
   * `L = 2^256 - (2^256 mod M)` is divisible by `M` for every `M`, so every
   * residue owns exactly `L / M` accepted values. That is the whole of Lemma B's
   * arithmetic, and it is checked rather than asserted.
   */
  it('divides evenly for every modulus in 1..512', () => {
    for (let modulus = 1n; modulus <= 512n; modulus += 1n) {
      const limit = RANGE - (RANGE % modulus);
      expect(limit % modulus).toBe(0n);
      expect(limit).toBeGreaterThan(0n);
    }
  });

  it('divides evenly at the boundaries of the supported range', () => {
    const moduli = [
      1n,
      2n,
      (1n << 64n) - 1n,
      1n << 64n,
      (1n << 128n) + 1n,
      (1n << 255n) + 1n,
      RANGE - 1n,
    ];
    for (const modulus of moduli) {
      const limit = RANGE - (RANGE % modulus);
      expect(limit % modulus).toBe(0n);
    }
  });

  /**
   * The moduli this repository's shuffles actually request, named so the near-zero
   * rejection rate is a recorded fact rather than a happy accident nobody checked.
   */
  it('leaves a rejection region of 0, 1, 2 or 4 for every shuffle modulus in 2..8', () => {
    const remainders = new Map<bigint, bigint>();
    for (let modulus = 2n; modulus <= 8n; modulus += 1n) remainders.set(modulus, RANGE % modulus);
    expect([...remainders.values()]).toStrictEqual([0n, 1n, 0n, 1n, 4n, 2n, 0n]);
  });
});

describe('the rejection loop is executed, and is correct when it is', () => {
  /**
   * `M = 2^255 + 1` divides into `2^256` exactly once, so the acceptance region
   * is `L = M` and the rejection region is `2^255 - 1` — very close to half the
   * output space. This is the only way to reach the branch on purpose: for the
   * moduli in real use it fires with probability around `2^-254`.
   */
  const HALF_REJECTING = (1n << 255n) + 1n;

  it('rejects roughly half of all draws at a modulus just above 2^255', () => {
    let taken = 0;
    for (let index = 0; index < 200; index += 1) {
      const { rejections } = rejectionsBefore(
        probeSeed(index),
        SCOPE,
        'reject',
        index,
        HALF_REJECTING,
      );
      if (rejections > 0n) taken += 1;
    }
    // Binomial(200, ~1/2): the deterministic seeds make this a constant, and any
    // value in this band proves the branch is reached many times over.
    expect(taken).toBeGreaterThan(60);
    expect(taken).toBeLessThan(140);
  });

  it('returns the first accepted draw, not the first draw', () => {
    let checkedAfterRejection = 0;
    for (let index = 0; index < 200; index += 1) {
      const seedHex = probeSeed(index);
      const { rejections, accepted } = rejectionsBefore(
        seedHex,
        SCOPE,
        'reject',
        index,
        HALF_REJECTING,
      );
      expect(uniformBigInt(seedHex, SCOPE, 'reject', index, HALF_REJECTING)).toBe(accepted);
      if (rejections > 0n) checkedAfterRejection += 1;
    }
    expect(checkedAfterRejection).toBeGreaterThan(60);
  });

  /**
   * The decoy, in the same spirit as `aether-order/docs/ENGINE.md` §8 check 11:
   * a sampler that dropped the loop and returned `value % M` would disagree with
   * the shipped one on these inputs. Without this, "the rejection loop is
   * present" would be an observation about the source rather than a property of
   * the output.
   */
  it('disagrees with an unrejected `value % M` sampler wherever a draw was rejected', () => {
    let divergences = 0;
    for (let index = 0; index < 200; index += 1) {
      const seedHex = probeSeed(index);
      const naive = drawValue(seedHex, SCOPE, 'reject', index, 0n, HALF_REJECTING) % HALF_REJECTING;
      if (uniformBigInt(seedHex, SCOPE, 'reject', index, HALF_REJECTING) !== naive)
        divergences += 1;
    }
    expect(divergences).toBeGreaterThan(60);
  });

  it('never returns a value at or above the modulus', () => {
    for (const modulus of [3n, 7n, 255n, HALF_REJECTING, RANGE - 1n])
      for (let index = 0; index < 32; index += 1) {
        const value = uniformBigInt(probeSeed(index), SCOPE, 'bounds', index, modulus);
        expect(value).toBeGreaterThanOrEqual(0n);
        expect(value).toBeLessThan(modulus);
      }
  });
});

/**
 * Goodness-of-fit on the residues themselves, as an exact rational compared
 * against an exact rational bound. Deterministic seeds, so the statistic is a
 * constant and the test cannot flake.
 */
function chiSquare(counts: readonly number[], samples: number): Rational {
  const expected = BigInt(samples / counts.length);
  let sum = 0n;
  for (const count of counts) {
    const delta = BigInt(count) - expected;
    sum += delta * delta;
  }
  return rational(sum, expected);
}

describe('residues are equidistributed', () => {
  const cases = [
    // modulus, samples, p = 0.001 critical value for df = modulus - 1
    { modulus: 2n, samples: 8_000, bound: rational(1083n, 100n) },
    { modulus: 3n, samples: 9_000, bound: rational(1382n, 100n) },
    { modulus: 5n, samples: 10_000, bound: rational(1847n, 100n) },
    { modulus: 6n, samples: 12_000, bound: rational(2052n, 100n) },
    { modulus: 7n, samples: 14_000, bound: rational(2246n, 100n) },
    { modulus: 8n, samples: 16_000, bound: rational(2432n, 100n) },
  ] as const;

  it.each(cases)('spreads evenly over $modulus residues', ({ modulus, samples, bound }) => {
    const counts = new Array<number>(Number(modulus)).fill(0);
    for (let index = 0; index < samples; index += 1) {
      const residue = Number(uniformBigInt(probeSeed(index), SCOPE, 'spread', index, modulus));
      counts[residue] = (counts[residue] as number) + 1;
    }
    expect(counts.every((count) => count > 0)).toBe(true);
    expect(compare(chiSquare(counts, samples), bound)).toBeLessThan(0);
  });

  /**
   * The bounds above have to reject something, or they are decoration.
   *
   * The alternative here is a sampler that narrows the digest to a power of two
   * before reducing — the shape every "just mask off the bits you need" shortcut
   * takes. `16 mod 7 = 2`, so residues 0 and 1 own three of sixteen draws and the
   * other five own two, and the same bound that passes the shipped sampler with a
   * factor of three to spare rejects this one by a factor of twenty.
   */
  it('rejects a sampler that narrows to a power of two before reducing', () => {
    const modulus = 7n;
    const samples = 14_000;
    const counts = new Array<number>(7).fill(0);
    for (let index = 0; index < samples; index += 1) {
      const value = drawValue(probeSeed(index), SCOPE, 'spread', index, 0n, modulus);
      const residue = Number((value & 0xfn) % modulus);
      counts[residue] = (counts[residue] as number) + 1;
    }
    expect(compare(chiSquare(counts, samples), rational(2246n, 100n))).toBeGreaterThan(0);
  });
});

describe('the sampler refuses a modulus it cannot serve exactly', () => {
  it.each([0n, -1n, RANGE, RANGE + 1n])('rejects modulus %s', (modulus) => {
    const error = (() => {
      try {
        uniformBigInt(probeSeed(0), SCOPE, 'bounds', 0, modulus);
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(RevealEngineError);
    expect((error as RevealEngineError).code).toBe('INVALID_CONTEXT');
    expect((error as RevealEngineError).path).toBe('$.modulus');
  });
});
