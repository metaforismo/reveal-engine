import { describe, expect, it } from 'vitest';
import {
  blackSignalReference,
  constellationReference,
  commitment,
  initialPosterior,
  makeTranscript,
  posteriorFor,
  probability,
  quote,
  rational,
  uniform,
  updatePosterior,
  verifyTranscript,
} from '../src/index.js';

describe('exact core', () => {
  it('supports distinct reference games and non-uniform priors', () => {
    expect(blackSignalReference.outcomes).toHaveLength(4);
    expect(constellationReference.outcomes).toHaveLength(3);
    const p = initialPosterior(constellationReference);
    expect(probability(p, 0)).toEqual(rational(1n, 2n));
  });
  it('is deterministic, replayable and transcript-bound', () => {
    const seed = '11'.repeat(32);
    const tx = makeTranscript(seed, constellationReference, 'r-1', 1);
    expect(makeTranscript(seed, constellationReference, 'r-1', 1)).toEqual(tx);
    expect(verifyTranscript(seed, constellationReference, tx)).toBe(true);
    expect(verifyTranscript('22'.repeat(32), constellationReference, tx)).toBe(false);
    expect(commitment(seed, tx.context, 2, tx.evidence)).not.toEqual(tx.commitment);
  });
  it('has domain separation and bounded uniform draws', () => {
    const context = {
      gameId: 'x',
      roundId: 'r',
      contractVersion: 'reveal-engine/commit-v1' as const,
    };
    expect(uniform('33'.repeat(32), context, 'a', 0, 7)).toBe(
      uniform('33'.repeat(32), context, 'a', 0, 7),
    );
    expect(uniform('33'.repeat(32), context, 'a', 0, 7)).not.toBe(
      uniform('33'.repeat(32), context, 'b', 0, 7),
    );
  });
  it('updates exact ratios and prices first entry differently from re-entry', () => {
    const prior = initialPosterior(constellationReference);
    const next = updatePosterior(prior, { index: 0, target: 0, favour: 5n, other: 1n, label: 'x' });
    expect(next.weights).toEqual([25n, 3n, 2n]);
    expect(quote(constellationReference, next, 0, true, 1).multiplier).toEqual(
      rational(291n, 250n),
    );
    expect(quote(constellationReference, next, 0, false, 1).multiplier).toEqual(rational(6n, 5n));
    expect(posteriorFor(constellationReference, [])).toEqual(prior);
  });
});
