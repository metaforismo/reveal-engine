import { describe, expect, it } from 'vitest';
import { constellationReference, initialPosterior, updatePosterior } from '../src/index.js';
describe('property and mutation resistance', () => {
  it('keeps posterior finite/positive under deterministic fuzz', () => {
    let p = initialPosterior(constellationReference);
    for (let i = 0; i < 1000; i += 1) {
      p = updatePosterior(p, {
        index: i,
        target: i % 3,
        favour: BigInt((i % 17) + 1),
        other: BigInt((i % 7) + 1),
        label: 'fuzz',
      });
      expect(p.total).toBeGreaterThan(0n);
    }
  });
  it('rejects invalid likelihood mutation', () => {
    const p = initialPosterior(constellationReference);
    expect(() =>
      updatePosterior(p, { index: 0, target: 0, favour: 0n, other: 1n, label: 'tamper' }),
    ).toThrow();
    expect(() =>
      updatePosterior(p, { index: 0, target: 9, favour: 1n, other: 1n, label: 'tamper' }),
    ).toThrow();
  });
});
