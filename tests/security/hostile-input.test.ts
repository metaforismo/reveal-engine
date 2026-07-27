import { describe, expect, it } from 'vitest';
import { ENGINE_LIMITS } from '../../src/api/limits.js';
import type { RevealEngineError } from '../../src/api/errors.js';
import { COMMITMENT_VERSION, type RoundContext } from '../../src/core/contracts.js';
import { makeTranscript, uniform, verifyTranscriptDetailed } from '../../src/core/fairness.js';
import { payable } from '../../src/core/payments.js';
import { initialPosterior } from '../../src/core/posterior.js';
import { rational } from '../../src/core/rational.js';
import { RoundBook } from '../../src/protocol/round-book.js';
import { binaryBeaconReference, constellationReference } from '../../src/reference/index.js';
import { deserializeTranscript, transcriptToWire } from '../../src/serialization/transcript.js';
import { seed } from '../helpers.js';

describe('hostile input and failure taxonomy', () => {
  it.each(['zz', '', '00', 'g0'.repeat(32), '00'.repeat(33)])(
    'rejects malformed seed %j',
    (invalid) => {
      const context: RoundContext = { gameId: 'x', roundId: 'r', proofVersion: COMMITMENT_VERSION };
      expect(() => uniform(invalid, context, 'x', 0, 7)).toThrowError(
        expect.objectContaining({ code: 'INVALID_SEED' }),
      );
    },
  );

  it.each([null, 4, [], {}, { schema: 'future' }])(
    'returns typed invalid/unsupported result for hostile transcript %#',
    (input) => {
      const result = verifyTranscriptDetailed(seed(1), binaryBeaconReference, input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['INVALID_TRANSCRIPT', 'UNSUPPORTED_VERSION']).toContain(result.code);
    },
  );

  it('distinguishes evidence, commitment, and adapter tampering', () => {
    const transcript = makeTranscript(seed(2), binaryBeaconReference, 'tamper');
    const wire = transcriptToWire(transcript);
    const badEvidence = {
      ...wire,
      evidence: wire.evidence.map((event, index) =>
        index === 0 ? { ...event, target: 1 - event.target } : event,
      ),
    };
    expect(verifyTranscriptDetailed(seed(2), binaryBeaconReference, badEvidence)).toMatchObject({
      ok: false,
      code: 'TRANSCRIPT_MISMATCH',
    });
    expect(
      verifyTranscriptDetailed(seed(2), binaryBeaconReference, {
        ...wire,
        commitment: '00'.repeat(32),
      }),
    ).toMatchObject({ ok: false, code: 'COMMITMENT_MISMATCH' });
    expect(verifyTranscriptDetailed(seed(2), constellationReference, wire)).toMatchObject({
      ok: false,
      code: 'ADAPTER_MISMATCH',
    });
  });

  it('rejects unknown fields and oversized transcript before derivation', () => {
    const wire = transcriptToWire(makeTranscript(seed(2), binaryBeaconReference, 'strict'));
    expect(() => deserializeTranscript(JSON.stringify({ ...wire, surprise: true }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_TRANSCRIPT' }),
    );
    expect(() =>
      deserializeTranscript(' '.repeat(ENGINE_LIMITS.maxTranscriptBytes + 1)),
    ).toThrowError(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }));
    const domain = makeTranscript(seed(2), binaryBeaconReference, 'strict-domain');
    expect(() =>
      deserializeTranscript({ ...domain, context: { ...domain.context, extra: true } }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TRANSCRIPT' }));
  });

  it('rejects non-canonical or excessive BigInt wire values', () => {
    const wire = transcriptToWire(makeTranscript(seed(5), binaryBeaconReference, 'bigint'));
    const mutate = (favour: string) => ({
      ...wire,
      evidence: [{ ...wire.evidence[0]!, favour }, ...wire.evidence.slice(1)],
    });
    for (const value of ['-1', '+1', '01', '9'.repeat(1235)])
      expect(() => deserializeTranscript(JSON.stringify(mutate(value)))).toThrow();
  });

  it('never allows negative payable credits from malformed structural rationals', () => {
    expect(() => payable({ numerator: 1n, denominator: -1n }, 10n, 2n)).toThrowError(
      expect.objectContaining<Partial<RevealEngineError>>({ code: 'INVALID_RATIONAL' }),
    );
    expect(payable(rational(100n), 10n, 2n).credited).toBe(20n);
  });

  it('maps malformed action requests to typed errors instead of native exceptions', async () => {
    const book = new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference));
    await expect(book.open(null as never)).rejects.toMatchObject({ code: 'OPEN_REJECTED' });
    await expect(
      book.settle({
        idempotencyKey: 'bad-seed',
        expectedFrameRevision: 0,
        revealedSeed: null as never,
        transcript: {},
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SEED' });
  });
});
