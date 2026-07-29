import { describe, expect, it } from 'vitest';
import { ENGINE_LIMITS } from '../../src/api/limits.js';
import { RevealEngineError } from '../../src/api/errors.js';
import { CommandLedger, fromWireReceipt } from '../../src/core/ledger.js';
import { uniformBigInt as coreUniformBigInt } from '../../src/core/random.js';
import { reduceWeights, weightGcd } from '../../src/core/weights.js';
import { checkModuleConformance } from '../../src/conformance/module-conformance.js';
import {
  COMMITMENT_VERSION,
  type RoundContext,
} from '../../src/modules/progressive-market/contracts.js';
import {
  makeTranscript,
  roundIdentityOf,
  scopeOf,
  uniform,
  uniformBigInt,
  verifyTranscriptDetailed,
} from '../../src/modules/progressive-market/fairness.js';
import { payable } from '../../src/core/payments.js';
import { initialPosterior } from '../../src/modules/progressive-market/posterior.js';
import { rational } from '../../src/core/rational.js';
import { RoundBook } from '../../src/modules/progressive-market/round-book.js';
import {
  binaryBeaconReference,
  constellationReference,
} from '../../src/modules/progressive-market/references/index.js';
import {
  deserializeTranscript,
  transcriptToWire,
} from '../../src/modules/progressive-market/transcript.js';
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

/**
 * Regression suite for the relocation.
 *
 * Extracting core out of the progressive market moved the sampler behind a
 * module wrapper. These are the exact call shapes that used to reach
 * `assertContext` before anything was dereferenced, and they must still fail
 * the same way: a typed `RevealEngineError`, never a raw `TypeError`.
 */
describe('public sampler entry points reject malformed contexts before dereferencing', () => {
  const cases: readonly [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['array', []],
    ['string', 'x'],
    ['number', 5],
    ['empty gameId', { gameId: '', roundId: 'r', proofVersion: COMMITMENT_VERSION }],
    ['missing roundId', { gameId: 'g', proofVersion: COMMITMENT_VERSION }],
    ['bad proof version', { gameId: 'g', roundId: 'r', proofVersion: 'reveal-engine/commit-v9' }],
  ];

  it.each(cases)('uniform rejects a %s context', (_label, context) => {
    const error = captureError(() => uniform(seed(1), context as RoundContext, 'label', 0, 10));
    expect(error).toBeInstanceOf(RevealEngineError);
    expect(error).not.toBeInstanceOf(TypeError);
  });

  it.each(cases)('uniformBigInt rejects a %s context', (_label, context) => {
    expect(
      captureError(() => uniformBigInt(seed(1), context as RoundContext, 'label', 0, 10n)),
    ).toBeInstanceOf(RevealEngineError);
  });

  it.each(cases)('scopeOf and roundIdentityOf reject a %s context', (_label, context) => {
    expect(captureError(() => scopeOf(context as RoundContext))).toBeInstanceOf(RevealEngineError);
    expect(captureError(() => roundIdentityOf(context as RoundContext))).toBeInstanceOf(
      RevealEngineError,
    );
  });

  it('reports a missing or non-record context as INVALID_CONTEXT, as it always did', () => {
    for (const context of [null, undefined, [], 'x', 5])
      expect(() => uniform(seed(1), context as unknown as RoundContext, 'l', 0, 10)).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONTEXT' }),
      );
    // Core's own sampler agrees: a malformed scope is a context failure.
    for (const scope of [null, {}, { domain: '', roundId: 'r', proofVersion: COMMITMENT_VERSION }])
      expect(() => coreUniformBigInt(seed(1), scope as never, 'l', 0, 10n)).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONTEXT' }),
      );
  });
});

describe('core wire helpers fail closed on attacker-shaped input', () => {
  it.each([null, undefined, 'x', 5, [], {}, { debited: '1' }])(
    'fromWireReceipt rejects %j without dereferencing it',
    (input) => {
      const error = captureError(() => fromWireReceipt(input as never, ['open']));
      expect(error).toBeInstanceOf(RevealEngineError);
      expect((error as RevealEngineError).code).toBe('INVALID_SNAPSHOT');
    },
  );

  it.each([null, undefined, 'x', 5, [], {}])('CommandLedger rejects options %j', (options) => {
    const error = captureError(() => new CommandLedger(options as never));
    expect(error).toBeInstanceOf(RevealEngineError);
    expect((error as RevealEngineError).code).toBe('INVALID_ADAPTER');
  });

  it.each([null, undefined, 'x', 5, [], {}])('conformance rejects module %j', (module) => {
    const report = captureError(() => checkModuleConformance(module as never, {}));
    expect(report).toBeInstanceOf(RevealEngineError);
    expect((report as RevealEngineError).code).toBe('INVALID_MODULE');
  });

  it.each([null, undefined, 'x', 5, [1, 'x'], [{}]])('weight helpers reject %j', (weights) => {
    expect(captureError(() => weightGcd(weights as never))).toBeInstanceOf(RevealEngineError);
    expect(captureError(() => reduceWeights(weights as never))).toBeInstanceOf(RevealEngineError);
  });
});

function captureError(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}
