import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { defineGame } from '../../src/modules/progressive-market/adapter.js';
import {
  COMMITMENT_VERSION,
  LEGACY_COMMITMENT_VERSION,
  type RoundContext,
} from '../../src/modules/progressive-market/contracts.js';
import {
  commitment,
  legacyCommitment,
  makeTranscript,
  uniform,
  verifyTranscriptDetailed,
} from '../../src/modules/progressive-market/fairness.js';
import { rational } from '../../src/core/rational.js';
import {
  deserializeTranscript,
  serializeTranscript,
  transcriptToWire,
} from '../../src/modules/progressive-market/transcript.js';
import { binaryBeaconReference } from '../../src/modules/progressive-market/references/index.js';
import { seed } from '../helpers.js';

describe('commit-reveal proof vectors and separation', () => {
  it('has a stable v2 known-answer vector', () => {
    const transcript = makeTranscript(seed(42), binaryBeaconReference, 'vector-round');
    expect(transcript.commitment).toBe(
      '6d498f19c48d51a76ccfeab5851d46ebb4226eaaaef45e25a172b4471c06aa81',
    );
    expect(verifyTranscriptDetailed(seed(42), binaryBeaconReference, transcript)).toEqual({
      ok: true,
      proofVersion: COMMITMENT_VERSION,
      commitment: transcript.commitment,
    });
  });

  it('normalizes seed case to the same bytes', () => {
    const lower = makeTranscript('ab'.repeat(32), binaryBeaconReference, 'case');
    const upper = makeTranscript('AB'.repeat(32), binaryBeaconReference, 'case');
    expect(upper).toEqual(lower);
    expect(verifyTranscriptDetailed('AB'.repeat(32), binaryBeaconReference, lower).ok).toBe(true);
  });

  it('separates delimiter-shaped context fields and adapter economics', () => {
    const seedHex = seed(4);
    const events = [{ index: 0, target: 0, favour: 2n, other: 1n, label: 'x,1:0:1:1:y' }];
    const contextA: RoundContext = {
      gameId: 'a|b',
      roundId: 'c',
      proofVersion: COMMITMENT_VERSION,
    };
    const contextB: RoundContext = {
      gameId: 'a',
      roundId: 'b|c',
      proofVersion: COMMITMENT_VERSION,
    };
    const gameA = defineGame({
      ...binaryBeaconReference,
      id: 'a|b',
      adapterVersion: '1',
      evidence: { ...binaryBeaconReference.evidence, eventCount: 1 },
    });
    const gameB = defineGame({
      ...binaryBeaconReference,
      id: 'a',
      adapterVersion: '1',
      evidence: { ...binaryBeaconReference.evidence, eventCount: 1 },
    });
    expect(commitment(seedHex, gameA, contextA, 0, events)).not.toBe(
      commitment(seedHex, gameB, contextB, 0, events),
    );
    const changedEconomics = defineGame({
      ...binaryBeaconReference,
      pricing: { ...binaryBeaconReference.pricing, firstEntryRtp: rational(98n, 100n) },
    });
    const originalContext: RoundContext = {
      gameId: binaryBeaconReference.id,
      roundId: 'c',
      proofVersion: COMMITMENT_VERSION,
    };
    expect(commitment(seedHex, binaryBeaconReference, originalContext, 0, events)).not.toBe(
      commitment(seedHex, changedEconomics, originalContext, 0, events),
    );
  });

  it('separates sampler purpose, round delimiters, and modulus', () => {
    const context: RoundContext = { gameId: 'a', roundId: 'r|x', proofVersion: COMMITMENT_VERSION };
    const alternate: RoundContext = { gameId: 'a', roundId: 'r', proofVersion: COMMITMENT_VERSION };
    const draws = [
      uniform(seed(7), context, 'y', 0, 97),
      uniform(seed(7), alternate, 'x|y', 0, 97),
      uniform(seed(7), context, 'z', 0, 97),
      uniform(seed(7), context, 'y', 0, 89),
    ];
    expect(new Set(draws).size).toBeGreaterThan(1);
    expect(draws[0]).not.toBe(draws[1]);
  });

  it('retains explicit legacy v1 verification semantics', () => {
    const context: RoundContext = {
      gameId: binaryBeaconReference.id,
      roundId: 'legacy-1',
      proofVersion: LEGACY_COMMITMENT_VERSION,
    };
    const truth = 1;
    const evidence = binaryBeaconReference.evidence.derive(seed(9), context, truth);
    const proof = legacyCommitment(seed(9), context, truth, evidence);
    const legacy = {
      schema: 'reveal-engine/transcript-v1',
      adapterVersion: '1.0.0',
      context: {
        gameId: context.gameId,
        roundId: context.roundId,
        contractVersion: LEGACY_COMMITMENT_VERSION,
      },
      truth,
      evidence: evidence.map((event) => ({
        ...event,
        favour: String(event.favour),
        other: String(event.other),
      })),
      commitment: proof,
    };
    expect(verifyTranscriptDetailed(seed(9), binaryBeaconReference, legacy).ok).toBe(true);
  });

  it.each([
    ['transcript-v1.json', seed(9)],
    ['transcript-v2.json', seed(9)],
  ])('verifies frozen compatibility fixture %s', (fixture, seedHex) => {
    const source = readFileSync(new URL(`../fixtures/${fixture}`, import.meta.url), 'utf8');
    expect(verifyTranscriptDetailed(seedHex, binaryBeaconReference, source).ok).toBe(true);
  });

  it('uses property-order-independent wire decoding', () => {
    const transcript = makeTranscript(seed(3), binaryBeaconReference, 'order');
    const wire = transcriptToWire(transcript);
    const reordered = {
      commitment: wire.commitment,
      evidence: wire.evidence.map((event) => ({
        label: event.label,
        other: event.other,
        favour: event.favour,
        target: event.target,
        index: event.index,
      })),
      truth: wire.truth,
      roundId: wire.roundId,
      adapter: { version: wire.adapter.version, id: wire.adapter.id },
      proofVersion: wire.proofVersion,
      schema: wire.schema,
    };
    expect(deserializeTranscript(JSON.stringify(reordered))).toEqual(transcript);
    expect(serializeTranscript(deserializeTranscript(JSON.stringify(reordered)))).toBe(
      serializeTranscript(transcript),
    );
  });
});
