import { describe, expect, it } from 'vitest';
import { defineGame } from '../src/modules/progressive-market/adapter.js';
import {
  ENGINE_API_VERSION,
  type EvidenceEvent,
} from '../src/modules/progressive-market/contracts.js';
import { deriveTruth, makeTranscript } from '../src/modules/progressive-market/fairness.js';
import {
  initialPosterior,
  posteriorFor,
  updatePosterior,
} from '../src/modules/progressive-market/posterior.js';
import { rational } from '../src/core/rational.js';
import { binaryBeaconReference } from '../src/modules/progressive-market/references/index.js';
import { seed } from './helpers.js';

function generator(state: number): () => number {
  let value = state >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return value >>> 0;
  };
}

describe('deterministic property and metamorphic seeds', () => {
  it.each(Array.from({ length: 32 }, (_, index) => index + 1))(
    'seed %i preserves independent posterior ratios',
    (propertySeed) => {
      const next = generator(propertySeed);
      const outcomes = 2 + (next() % 7);
      const priors = Array.from({ length: outcomes }, () => BigInt(1 + (next() % 1000)));
      const game = defineGame({
        apiVersion: ENGINE_API_VERSION,
        adapterVersion: `property-${propertySeed}`,
        id: `property-game-${propertySeed}`,
        outcomes: Array.from({ length: outcomes }, (_, index) => `o-${index}`),
        priorWeights: priors,
        evidence: { modelVersion: 'property/v1', eventCount: 0, derive: () => [] },
        pricing: {
          firstEntryRtp: rational(97n, 100n),
          liquidationSpread: rational(0n),
          rounding: 'floor',
        },
        risk: { maxWinMultiple: 1000n },
      });
      const count = 1 + (next() % 40);
      const events: EvidenceEvent[] = Array.from({ length: count }, (_, index) => ({
        index,
        target: next() % outcomes,
        favour: BigInt(1 + (next() % 127)),
        other: BigInt(1 + (next() % 127)),
        label: `p-${index}`,
      }));
      let streamed = initialPosterior(game);
      for (const event of events) streamed = updatePosterior(streamed, event);
      const widened = defineGame({ ...game, evidence: { ...game.evidence, eventCount: count } });
      const batched = posteriorFor(widened, events);
      expect(streamed.weights).toEqual(batched.weights);
      expect(streamed.total).toBe(batched.total);
      expect(streamed.total).toBe(streamed.weights.reduce((sum, weight) => sum + weight, 0n));
    },
  );

  it('is deterministic across 256 transcript replays and isolated by adapter', () => {
    const alternate = defineGame({
      ...binaryBeaconReference,
      id: 'binary-beacon-isolated',
      adapterVersion: '1.0.0',
    });
    let differentTruths = 0;
    for (let index = 0; index < 256; index += 1) {
      const seedHex = seed(index);
      const first = makeTranscript(seedHex, binaryBeaconReference, `round-${index}`);
      expect(makeTranscript(seedHex, binaryBeaconReference, `round-${index}`)).toEqual(first);
      expect(first).not.toEqual(makeTranscript(seedHex, alternate, `round-${index}`));
      if (
        deriveTruth(seedHex, binaryBeaconReference, `round-${index}`) !==
        deriveTruth(seedHex, alternate, `round-${index}`)
      )
        differentTruths += 1;
    }
    expect(differentTruths).toBeGreaterThan(0);
  });

  it('handles boundary BigInts without precision loss and rejects beyond the limit', () => {
    const near = 1n << 254n;
    const game = defineGame({
      ...binaryBeaconReference,
      id: 'bigint-boundary',
      adapterVersion: '1',
      priorWeights: [near, near - 1n],
    });
    const posterior = initialPosterior(game);
    expect(posterior.weights).toEqual([near, near - 1n]);
    expect(() =>
      defineGame({ ...game, id: 'too-large', priorWeights: [1n << 256n, 1n] }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER' }));
  });
});
