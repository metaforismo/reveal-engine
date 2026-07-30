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
import {
  aetherOrderClassicReference,
  betFromParameters,
  derivePermutationOrder,
  derivePermutationSteps,
  deserializePermutationTranscript,
  makePermutationTranscript,
  permutation,
  permutationFingerprint,
  permutationTranscriptToWire,
  PermutationBook,
  price,
} from '../../src/modules/permutation/index.js';
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
    book.bindRound({
      roundId: 'hostile',
      commitment: makeTranscript(seed(1), binaryBeaconReference, 'hostile').commitment,
    });
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

/**
 * The same posture, for the second lifecycle module.
 *
 * A module is only as safe as its untrusted-input boundary, and this repository
 * has two of them now. Every entry point a hostile payload can reach —
 * `fromWire`, `verify`, `restore`, and both book commands — must answer with a
 * typed `RevealEngineError` and a path, never with a `TypeError` from three
 * frames down.
 */
describe('permutation module fails closed on hostile input', () => {
  const definition = aetherOrderClassicReference;
  const transcript = makePermutationTranscript(seed(1), definition, 'security');
  const wire = permutationTranscriptToWire(transcript) as unknown as Record<string, unknown>;
  const boundRound = Object.freeze({
    roundId: transcript.roundId,
    commitment: transcript.commitment,
  });

  it.each([null, undefined, 0, 'x', [], {}, { schema: 'permutation/v9' }, Object.create(null)])(
    'verifies hostile transcript %# to a typed failure rather than throwing',
    (input) => {
      const result = permutation.verify(seed(1), definition, input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['INVALID_TRANSCRIPT', 'UNSUPPORTED_VERSION']).toContain(result.code);
    },
  );

  it.each([
    ['unknown field', { ...wire, surprise: true }],
    ['prototype-polluting key', JSON.parse(`{"__proto__":{"polluted":true},"schema":"x"}`)],
    ['order that is not a permutation', { ...wire, order: [0, 0, 1, 2, 3] }],
    ['order of the wrong length', { ...wire, order: [0, 1, 2] }],
    ['reveals out of settle order', { ...wire, reveals: [{ position: 3, item: 0 }] }],
    ['non-integer item', { ...wire, order: [0, 1, 2, 3, 4.5] }],
    ['commitment that is not hex', { ...wire, commitment: 'z'.repeat(64) }],
  ])('rejects a malformed transcript body: %s', (_label, input) => {
    const error = captureError(() => deserializePermutationTranscript(input));
    expect(error).toBeInstanceOf(RevealEngineError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect({}.hasOwnProperty.call({}, 'polluted')).toBe(false);
  });

  it.each([null, undefined, 0, 'x', [], {}, '{"schema":1}'])(
    'restores hostile snapshot %# to a typed INVALID_SNAPSHOT',
    (input) => {
      const error = captureError(() => PermutationBook.restore(definition, input as never, null));
      expect(error).toBeInstanceOf(RevealEngineError);
      expect((error as RevealEngineError).code).toBe('INVALID_SNAPSHOT');
    },
  );

  it.each([null, undefined, 0, 'x', [], {}, { idempotencyKey: 'k' }, { bet: null, stake: 25n }])(
    'refuses hostile book command %# without dereferencing it',
    async (request) => {
      const book = new PermutationBook(definition);
      await expect(book.place(request as never)).rejects.toBeInstanceOf(RevealEngineError);
      await expect(book.settle(request as never)).rejects.toBeInstanceOf(RevealEngineError);
    },
  );

  it.each([null, undefined, 0, 'x', [], {}, { items: [] }])(
    'refuses hostile definition %# at every entry point',
    (candidate) => {
      for (const operation of [
        () => permutationFingerprint(candidate as never),
        () => new PermutationBook(candidate as never),
        () => derivePermutationOrder(seed(1), candidate as never, 'r'),
        () => price(candidate as never, [], { code: 'first', item: 0 }),
      ]) {
        const error = captureError(operation);
        expect(error).toBeInstanceOf(RevealEngineError);
        expect(error).not.toBeInstanceOf(TypeError);
      }
    },
  );

  /**
   * Sparse arrays, which `forEach`, `map` and `every` all silently skip.
   *
   * `new Array(n)` has the declared length and no own indices, so an element
   * validator written with `forEach` never runs once and passes everything. For
   * a step prefix that is worse than a crash: each skipped hole shifts the
   * remaining reveals down a position, so a malformed prefix would be re-read as
   * a different, well-formed one and priced confidently at the wrong number.
   * Every validator on these paths iterates by index for that reason.
   */
  it('rejects sparse arrays wherever an array crosses a boundary', () => {
    const sparse = <T>(length: number): T[] => new Array<T>(length);
    const holed = <T>(length: number, at: number, value: T): T[] => {
      const array = new Array<T>(length);
      array[at] = value;
      return array;
    };
    const cases: readonly (readonly [string, () => unknown])[] = [
      ['full-order bet', () => price(definition, [], { code: 'full', order: sparse(5) })],
      [
        'step prefix',
        () => price(definition, holed(2, 1, { position: 1, item: 1 }), { code: 'first', item: 1 }),
      ],
      ['bet parameters', () => betFromParameters(definition, 'full', sparse(5))],
      ['non-array bet parameters', () => betFromParameters(definition, 'first', null)],
      ['derived truth', () => derivePermutationSteps(definition, sparse(5))],
      ['encoded truth', () => permutation.truth.encode(sparse(5))],
      ['wire order', () => deserializePermutationTranscript({ ...wire, order: sparse(5) })],
      ['wire reveals', () => deserializePermutationTranscript({ ...wire, reveals: sparse(4) })],
    ];
    for (const [label, operation] of cases) {
      const error = captureError(operation);
      expect(error, label).toBeInstanceOf(RevealEngineError);
      expect(error, label).not.toBeInstanceOf(TypeError);
    }
  });

  it('refuses to score a ticket against something that is not an order', async () => {
    const book = new PermutationBook(definition, boundRound);
    await book.place({ idempotencyKey: 'a', bet: { code: 'first', item: 0 }, stake: 25n });
    for (const order of [null, undefined, 'abcde', [0, 1, 2], [0, 0, 1, 2, 3], new Array(5)]) {
      const error = captureError(() => book.grossFor(order as never));
      expect(error).toBeInstanceOf(RevealEngineError);
      expect((error as RevealEngineError).code).toBe('CLAIM_REJECTED');
    }
  });

  it('never lets a settlement run against an unverified proof', async () => {
    const book = new PermutationBook(definition, boundRound);
    await book.place({ idempotencyKey: 'a', bet: { code: 'first', item: 0 }, stake: 25n });
    const forgeries: readonly Record<string, unknown>[] = [
      { ...wire, commitment: '0'.repeat(64) },
      { ...wire, order: [...(wire.order as number[])].reverse() },
      { ...wire, roundId: 'another-round' },
    ];
    for (const [index, forged] of forgeries.entries())
      await expect(
        book.settle({ idempotencyKey: `s-${index}`, revealedSeed: seed(1), transcript: forged }),
      ).rejects.toBeInstanceOf(RevealEngineError);
    expect(book.terminal).toBe(false);
    expect(book.liquidBalance).toBe(0n);
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
