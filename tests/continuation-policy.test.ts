import { describe, expect, it } from 'vitest';
import { deriveMaxContinuations } from '../src/core/continuation.js';
import { rational } from '../src/core/rational.js';
import { blackSignalReference } from '../src/modules/progressive-market/references/index.js';

describe('continuation policy derivation', () => {
  it.each([
    [9700n, 4],
    [9650n, 3],
    [9550n, 2],
    [9450n, 1],
  ])('matches the title RTP ladder at %s/10000', (rtp, expected) => {
    expect(deriveMaxContinuations(rational(rtp, 10_000n), rational(8_500n, 10_000n))).toBe(
      expected,
    );
  });

  it('pins the compatibility reference to two host-managed rides', () => {
    expect(blackSignalReference.adapterVersion).toBe('1.1.0');
    expect(blackSignalReference.risk.continuation?.maxRides).toBe(2);
  });

  it('rejects invalid probabilities and unbounded searches', () => {
    expect(() => deriveMaxContinuations(rational(11n, 10n), rational(1n, 2n))).toThrowError(
      expect.objectContaining({ code: 'INVALID_RATIONAL' }),
    );
    expect(() => deriveMaxContinuations(rational(1n), rational(1n), 65)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONTEXT' }),
    );
  });
});
