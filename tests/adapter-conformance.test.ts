import { describe, expect, it } from 'vitest';
import {
  assertAdapterConforms,
  checkAdapterConformance,
} from '../src/modules/progressive-market/conformance.js';
import { defineGame } from '../src/modules/progressive-market/adapter.js';
import {
  ENGINE_API_VERSION,
  type GameDefinition,
} from '../src/modules/progressive-market/contracts.js';
import { rational } from '../src/core/rational.js';
import {
  binaryBeaconReference,
  blackSignalReference,
  constellationReference,
} from '../src/modules/progressive-market/references/index.js';

describe('adapter conformance', () => {
  it.each([blackSignalReference, constellationReference, binaryBeaconReference])(
    '$id conforms across deterministic seeds',
    (game) => {
      const report = checkAdapterConformance(game, 12);
      expect(report.ok, JSON.stringify(report.failures)).toBe(true);
      expect(report.schema).toBe('reveal-engine/adapter-conformance-v1');
      expect(report.transcripts).toBe(12);
      expect(report.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
      expect(assertAdapterConforms(game, 2).ok).toBe(true);
    },
  );

  it('throws with the failing check codes when an adapter does not conform', () => {
    expect(() => assertAdapterConforms({} as GameDefinition, 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ADAPTER' }),
    );
  });

  it('deep-freezes built-in adapters', () => {
    expect(() => (blackSignalReference.outcomes as string[]).push('E')).toThrow();
    expect(
      () => ((blackSignalReference.pricing as { rounding: string }).rounding = 'ceil'),
    ).toThrow();
    expect(blackSignalReference.outcomes).toHaveLength(4);
  });

  it.each([
    ['one outcome', { outcomes: ['only'], priorWeights: [1n] }],
    ['duplicate outcome', { outcomes: ['x', 'x'], priorWeights: [1n, 1n] }],
    ['zero prior', { outcomes: ['x', 'y'], priorWeights: [1n, 0n] }],
    ['invalid RTP', { pricing: { ...binaryBeaconReference.pricing, firstEntryRtp: rational(2n) } }],
    [
      'invalid continuation',
      { risk: { maxWinMultiple: 1n, continuation: { maxRides: -1, rtpFloor: rational(1n) } } },
    ],
  ])('rejects malformed adapter: %s', (_, mutation) => {
    expect(() => defineGame({ ...binaryBeaconReference, ...mutation } as GameDefinition)).toThrow();
  });

  it('reports truth-dependent likelihood schedules', () => {
    const malicious = defineGame({
      apiVersion: ENGINE_API_VERSION,
      adapterVersion: '1.0.0',
      id: 'truth-leaking-adapter',
      outcomes: ['a', 'b'],
      priorWeights: [1n, 1n],
      evidence: {
        modelVersion: 'truth-leak/v1',
        eventCount: 1,
        derive: (_seed, _context, truth) => [
          { index: 0, target: truth, favour: BigInt(truth + 2), other: 1n, label: 'leak' },
        ],
      },
      pricing: { firstEntryRtp: rational(1n), liquidationSpread: rational(0n), rounding: 'floor' },
      risk: { maxWinMultiple: 10n },
    });
    const report = checkAdapterConformance(malicious, 1);
    expect(report.ok).toBe(false);
    expect(report.failures.some((failure) => failure.code === 'TRUTH_DEPENDENT_MODEL')).toBe(true);
  });

  it('reports mutable evidence arrays before they cross the adapter boundary', () => {
    const mutable = defineGame({
      ...binaryBeaconReference,
      id: 'mutable-derivation',
      evidence: { modelVersion: 'mutable/v1', eventCount: 0, derive: () => [] },
    });
    const report = checkAdapterConformance(mutable, 1);
    expect(report.ok).toBe(false);
    expect(report.failures.some((failure) => failure.code === 'MUTABLE_DERIVATION')).toBe(true);
  });
});
