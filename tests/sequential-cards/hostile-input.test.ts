import { describe, expect, it } from 'vitest';
import { RevealEngineError } from '../../src/api/errors.js';
import { ENGINE_LIMITS } from '../../src/api/limits.js';
import { snapshotHash } from '../../src/core/snapshot.js';
import { cardsFingerprint } from '../../src/modules/sequential-cards/adapter.js';
import { cardsBelief, claimProbability } from '../../src/modules/sequential-cards/deck.js';
import { sequentialCards } from '../../src/modules/sequential-cards/module.js';
import {
  triadDormantReference,
  triadMiddleReference,
} from '../../src/modules/sequential-cards/references.js';
import { CardsBook } from '../../src/modules/sequential-cards/round-book.js';
import {
  buildCardsTranscript,
  cardsTranscriptToWire,
  deserializeCardsTranscript,
} from '../../src/modules/sequential-cards/transcript.js';
import { composeRoundSeed } from '../../src/modules/sequential-cards/truth.js';
import { assertCardsDefinition } from '../../src/modules/sequential-cards/validation.js';
import { seed } from '../helpers.js';

const definition = triadMiddleReference;
/** A fresh book of the one reference that declares a dormancy policy. */
const dormantBook = (): CardsBook => new CardsBook(triadDormantReference);
const choices = [{ index: 0, kind: 'back' as const, position: 0 }];
const wire = cardsTranscriptToWire(
  buildCardsTranscript(seed(41), definition, 'hostile-round', choices),
);

/**
 * The untrusted-input boundary.
 *
 * Everything a host can reach with attacker-shaped data has to come back as a
 * typed `RevealEngineError` or a typed verification failure — never a
 * `TypeError`, never a parser stack trace, and never a silently coerced value.
 */
describe('sequential-cards: hostile input', () => {
  const hostileValues: readonly unknown[] = [
    null,
    undefined,
    0,
    '',
    'transcript',
    [],
    [1, 2, 3],
    true,
    Symbol.iterator,
    () => undefined,
    new Date(),
    { __proto__: { polluted: true } },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ];

  it('fails closed on every hostile transcript payload', () => {
    for (const value of hostileValues) {
      expect(() => deserializeCardsTranscript(value)).toThrowError(RevealEngineError);
      const result = sequentialCards.verify(seed(41), definition, value);
      expect(result.ok).toBe(false);
      expect(['INVALID_TRANSCRIPT', 'UNSUPPORTED_VERSION']).toContain(
        (result as { code: string }).code,
      );
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ['an unknown field', { ...wire, extra: 1 }],
    [
      'a missing field',
      (() => {
        const { commitment: _dropped, ...rest } = wire;
        return rest;
      })(),
    ],
    ['a non-canonical commitment', { ...wire, commitment: 'ZZ'.repeat(32) }],
    ['an uppercase digest', { ...wire, seedCommitment: wire.seedCommitment.toUpperCase() }],
    ['a float rank', { ...wire, deal: { ...wire.deal, ranks: [1.5, 2, 3] } }],
    ['a string rank', { ...wire, deal: { ...wire.deal, ranks: ['1', 2, 3] } }],
    ['an oversized deal', { ...wire, deal: { ...wire.deal, ranks: new Array(200).fill(1) } }],
    [
      'a choice with an unknown kind',
      { ...wire, choices: [{ index: 0, kind: 'hedge', position: 0 }] },
    ],
    [
      'a step missing its sort',
      { ...wire, steps: wire.steps.map(({ sorted: _drop, ...rest }) => rest) },
    ],
    ['a nested array where an object belongs', { ...wire, deal: [1, 2, 3] }],
  ])('refuses a transcript with %s', (_label, payload) => {
    expect(() => deserializeCardsTranscript(payload)).toThrowError(
      expect.objectContaining({
        code: expect.stringMatching(/INVALID_TRANSCRIPT|UNSUPPORTED_VERSION/u),
      }),
    );
    expect(sequentialCards.verify(seed(41), definition, payload).ok).toBe(false);
  });

  it('bounds a transcript by bytes before it parses one', () => {
    const huge = `{"schema":"${'x'.repeat(ENGINE_LIMITS.maxTranscriptBytes)}"}`;
    expect(() => deserializeCardsTranscript(huge)).toThrowError(
      expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    );
    expect(() => deserializeCardsTranscript('{not json')).toThrowError(
      expect.objectContaining({ code: 'INVALID_TRANSCRIPT' }),
    );
  });

  it('refuses a transcript whose steps contradict its own choice log', () => {
    // A backed position is never eligible for a reveal, so a step that turns
    // one over is not a round this definition could have produced.
    const contradiction = {
      ...wire,
      steps: wire.steps.map((step) => ({ ...step, position: 0, sorted: [1, 2] })),
    };
    expect(sequentialCards.verify(seed(41), definition, contradiction)).toMatchObject({
      ok: false,
    });
    // And one whose sealed selector is outside the eligible set it indexes.
    expect(
      sequentialCards.verify(seed(41), definition, {
        ...wire,
        deal: { ...wire.deal, selectors: [9] },
      }),
    ).toMatchObject({ ok: false });
  });

  it('fails closed on every hostile snapshot payload', () => {
    for (const value of hostileValues)
      expect(() => CardsBook.restore(definition, value as object)).toThrowError(RevealEngineError);
    const book = new CardsBook(definition);
    const snapshot = book.snapshot() as unknown as Record<string, unknown>;
    for (const mutation of [
      { schema: 'reveal-engine/cards-book-v1' },
      { stepRevision: -1 },
      { ledgerRevision: 1.5 },
      { selections: 'none' },
      { receipts: [{ fingerprint: 'x', receipt: {} }] },
      { definition: { id: definition.id, version: definition.version, fingerprint: 'nope' } },
      { extra: true },
    ]) {
      const tampered = {
        ...snapshot,
        ...mutation,
        snapshotHash: snapshotHash({ ...snapshot, ...mutation, snapshotHash: undefined }),
      };
      expect(() => CardsBook.restore(definition, JSON.stringify(tampered))).toThrowError(
        RevealEngineError,
      );
    }
    // A snapshot for another definition never restores, however well sealed.
    expect(() =>
      CardsBook.restore({ ...definition, id: 'someone-else-v1' }, JSON.stringify(snapshot)),
    ).toThrowError(expect.objectContaining({ code: 'DEFINITION_MISMATCH' }));
    expect(cardsFingerprint(definition)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses a malformed definition rather than pricing one', () => {
    for (const value of hostileValues)
      expect(() => assertCardsDefinition(value)).toThrowError(RevealEngineError);
    expect(() =>
      assertCardsDefinition({ ...definition, moduleId: 'progressive-market' }),
    ).toThrowError(expect.objectContaining({ code: 'DEFINITION_MISMATCH' }));
    expect(() =>
      assertCardsDefinition({ ...definition, apiVersion: 'reveal-engine/api-v0' }),
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }));
  });

  it('refuses a claim it cannot price instead of pricing it as zero', () => {
    const belief = cardsBelief(definition, []);
    expect(belief.total).toBeGreaterThan(0n);
    for (const claim of [
      null,
      { kind: 'position', positions: [] },
      { kind: 'position', positions: [0, 0] },
      { kind: 'position', positions: [7] },
      { kind: 'position', positions: [-1] },
      { kind: 'market', marketId: 'NOPE' },
      { kind: 'jackpot' },
    ])
      expect(() => claimProbability(definition, [], claim as never)).toThrowError(
        RevealEngineError,
      );
  });

  it('refuses a round seed composed without the entropy the definition requires', () => {
    const base = {
      definition,
      roundId: 'seed-round',
      operatorSeed: seed(42),
      clientSeed: '00'.repeat(16),
      nonce: 0,
    };
    expect(composeRoundSeed(base)).toMatch(/^[0-9a-f]{64}$/u);
    for (const bad of [
      { ...base, clientSeed: '' },
      { ...base, clientSeed: '00'.repeat(4) },
      { ...base, clientSeed: 'zz'.repeat(16) },
      { ...base, clientSeed: '000' },
      { ...base, operatorSeed: 'short' },
      { ...base, nonce: -1 },
      { ...base, nonce: 1.5 },
      { ...base, roundId: '' },
    ])
      expect(() => composeRoundSeed(bad)).toThrowError(RevealEngineError);
    // The nonce is part of the composition, so a replayed round is a new seed.
    expect(composeRoundSeed({ ...base, nonce: 1 })).not.toBe(composeRoundSeed(base));
  });

  it('refuses a book command whose request is not a request', async () => {
    const book = new CardsBook(definition);
    for (const value of hostileValues) {
      await expect(book.open(value as never)).rejects.toThrowError(RevealEngineError);
      await expect(book.cash(value as never)).rejects.toThrowError(RevealEngineError);
      await expect(book.switchClaim(value as never)).rejects.toThrowError(RevealEngineError);
      await expect(book.settle(value as never)).rejects.toThrowError(RevealEngineError);
      await expect(book.advanceReveal(value as never)).rejects.toThrowError(RevealEngineError);
      await expect(dormantBook().settleDormant(value as never)).rejects.toThrowError(
        RevealEngineError,
      );
    }
    // The two fields the dormant path takes that nothing else does, each on its
    // own: a window that is not a number of seconds, and a reason that is not a
    // reason. Neither may reach the ledger.
    const dormant = dormantBook();
    // Each asserts the **named** reason, so a case cannot survive the deletion
    // of the guard it is about: a bare `toThrowError` would still pass on the
    // unparseable transcript further down the command.
    for (const elapsed of hostileValues.concat([-1, 1.5, Number.NaN, Number.MAX_VALUE, 2n]))
      await expect(
        dormant.settleDormant({
          idempotencyKey: 'k',
          expectedStepRevision: 0,
          revealedSeed: seed(41),
          transcript: {},
          elapsedSeconds: elapsed as never,
        }),
      ).rejects.toMatchObject({ details: { reason: 'ROUND_NOT_DORMANT' } });
    for (const reason of hostileValues.filter((value) => value !== undefined))
      await expect(
        dormant.settleDormant({
          idempotencyKey: 'k',
          expectedStepRevision: 0,
          revealedSeed: seed(41),
          transcript: {},
          elapsedSeconds: 999_999,
          reason: reason as never,
        }),
      ).rejects.toMatchObject({ details: { reason: 'INVALID_SETTLEMENT_REASON' } });
    await expect(
      book.open({
        idempotencyKey: 'x'.repeat(ENGINE_LIMITS.maxIdempotencyKeyBytes + 1),
        expectedStepRevision: 0,
        roundId: 'r',
        seedCommitment: '00'.repeat(32),
        clientSeed: '11'.repeat(32),
        selections: [{ id: 'M', kind: 'position', position: 0, stake: 25n }],
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});
