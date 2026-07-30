import { describe, expect, it } from 'vitest';
import { RevealEngineError } from '../../src/api/errors.js';
import { rational } from '../../src/core/rational.js';
import { initialPosterior } from '../../src/modules/progressive-market/posterior.js';
import { RoundBook } from '../../src/modules/progressive-market/round-book.js';
import { binaryBeaconReference } from '../../src/modules/progressive-market/references/index.js';
import { makePermutationTranscript } from '../../src/modules/permutation/derivation.js';
import { PermutationBook } from '../../src/modules/permutation/round-book.js';
import { aetherOrderClassicReference } from '../../src/modules/permutation/references/index.js';
import {
  aetherOrderClassic,
  derivePermutation,
  makePermutationTranscript as makeAetherTranscript,
  openTicket,
  permutationAdapterFingerprint,
  seedCommitment as aetherSeedCommitment,
  settlementDigestFor,
  settleTicket,
  type PermutationGameDefinition,
} from '../../src/modules/permutation/aether/index.js';
import { CardsBook } from '../../src/modules/sequential-cards/round-book.js';
import { triadMiddleReference } from '../../src/modules/sequential-cards/references.js';
import { deriveRevealSteps } from '../../src/modules/sequential-cards/steps.js';
import { buildCardsTranscript } from '../../src/modules/sequential-cards/transcript.js';
import { SurvivalBook } from '../../src/modules/staged-survival/book.js';
import {
  makeTranscript as makeSurvivalTranscript,
  roundRefId,
} from '../../src/modules/staged-survival/index.js';
import { fiveRunnerReference } from '../../src/modules/staged-survival/references/index.js';
import { seed } from '../helpers.js';
import { cardsAdmission } from '../support/cards-admission.js';
import { survivalAdmission } from '../support/survival-admission.js';

describe('round 2: request copy-once boundaries', () => {
  it('progressive open snapshots plain mutation, accessors, and a Proxy exactly once', async () => {
    const transcript = (
      await import('../../src/modules/progressive-market/fairness.js')
    ).makeTranscript(seed(811), binaryBeaconReference, 'copy-once-progressive');
    const binding = { roundId: transcript.context.roundId, commitment: transcript.commitment };
    const plain = {
      idempotencyKey: 'plain',
      expectedFrameRevision: 0,
      outcome: 0,
      stake: 100n,
    };
    const plainBook = new RoundBook(
      binaryBeaconReference,
      initialPosterior(binaryBeaconReference),
      binding,
    );
    const pending = plainBook.open(plain);
    plain.stake = 1n;
    plain.outcome = 1;
    const plainReceipt = await pending;
    expect(plainReceipt.debited).toBe(100n);
    expect(plainBook.position).toMatchObject({ stake: 100n, outcome: 0 });

    const reads = new Map<string, number>();
    const values = {
      idempotencyKey: 'accessor',
      expectedFrameRevision: 0,
      outcome: 0,
      stake: 100n,
    };
    const accessorRequest = {} as typeof values;
    for (const [name, value] of Object.entries(values))
      Object.defineProperty(accessorRequest, name, {
        enumerable: true,
        get: () => {
          reads.set(name, (reads.get(name) ?? 0) + 1);
          return value;
        },
      });
    const accessorBook = new RoundBook(
      binaryBeaconReference,
      initialPosterior(binaryBeaconReference),
      binding,
    );
    expect((await accessorBook.open(accessorRequest)).debited).toBe(100n);
    expect(Object.fromEntries(reads)).toEqual({
      idempotencyKey: 1,
      expectedFrameRevision: 1,
      outcome: 1,
      stake: 1,
    });

    const proxyReads = new Map<PropertyKey, number>();
    const proxied = new Proxy(
      { ...values, idempotencyKey: 'proxy' },
      {
        get(target, key, receiver) {
          proxyReads.set(key, (proxyReads.get(key) ?? 0) + 1);
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const proxyBook = new RoundBook(
      binaryBeaconReference,
      initialPosterior(binaryBeaconReference),
      binding,
    );
    expect((await proxyBook.open(proxied)).debited).toBe(100n);
    for (const key of Object.keys(values)) expect(proxyReads.get(key)).toBe(1);
  });

  it('permutation place detaches stake, key, discriminator, and full-order arrays', async () => {
    const transcript = makePermutationTranscript(
      seed(812),
      aetherOrderClassicReference,
      'copy-once',
    );
    const binding = { roundId: transcript.roundId, commitment: transcript.commitment };
    const losing = [...transcript.order];
    [losing[0], losing[1]] = [losing[1] as number, losing[0] as number];
    const request = {
      idempotencyKey: 'alpha',
      bet: { code: 'full' as const, order: losing },
      stake: 25n,
    };
    const book = new PermutationBook(aetherOrderClassicReference, binding);
    const pending = book.place(request);
    request.idempotencyKey = 'beta';
    request.stake = 2_500n;
    request.bet.order.splice(0, request.bet.order.length, ...transcript.order);
    const placed = await pending;

    expect(placed.idempotencyKey).toBe('alpha');
    expect(placed.debited).toBe(25n);
    expect(book.claims[0]).toMatchObject({ key: 'alpha', stake: 25n });
    expect(book.claims[0]?.bet).toEqual({
      code: 'full',
      order: losing.map((_value, index) =>
        index === 0
          ? (transcript.order[1] as number)
          : index === 1
            ? (transcript.order[0] as number)
            : (transcript.order[index] as number),
      ),
    });
    const storedOrder = (book.claims[0]?.bet as unknown as { order: number[] }).order;
    expect(Object.isFrozen(storedOrder)).toBe(true);
    expect(() => (storedOrder[0] = 99)).toThrow();

    // RE-EXTRA: the late mutation to beta must not make alpha's claim occupy
    // beta's map slot. A real beta command remains independent.
    await book.place({
      idempotencyKey: 'beta',
      bet: { code: 'first', item: transcript.order[0] as number },
      stake: 25n,
    });
    expect(book.claims.map((claim) => claim.key)).toEqual(['alpha', 'beta']);
    const settled = await book.settle({
      idempotencyKey: 'settle',
      revealedSeed: seed(812),
      transcript,
    });
    // Only the beta first-place line wins; the full-order line stayed detached
    // from the array the caller rewrote to the revealed truth.
    expect(settled.credited).toBe(120n);
  });

  it('permutation reads a hostile bet discriminator only once', async () => {
    const transcript = makePermutationTranscript(
      seed(813),
      aetherOrderClassicReference,
      'bet-accessor',
    );
    let codeReads = 0;
    const bet = {
      get code(): 'first' | 'full' {
        codeReads += 1;
        return codeReads === 1 ? 'first' : 'full';
      },
      item: transcript.order[0] as number,
    };
    const book = new PermutationBook(aetherOrderClassicReference, {
      roundId: transcript.roundId,
      commitment: transcript.commitment,
    });
    await book.place({ idempotencyKey: 'line', bet: bet as never, stake: 25n });
    expect(codeReads).toBe(1);
    expect(book.claims[0]?.bet).toEqual({ code: 'first', item: transcript.order[0] });
  });
});

describe('round 2: object snapshot preflight', () => {
  const books = [
    {
      name: 'progressive',
      make: () =>
        new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference)).snapshot(),
      restore: (snapshot: object) =>
        RoundBook.restore(binaryBeaconReference, snapshot as never, null),
      array: 'evidence',
    },
    {
      name: 'cards',
      make: () => new CardsBook(triadMiddleReference).snapshot(),
      restore: (snapshot: object) => CardsBook.restore(triadMiddleReference, snapshot, null),
      array: 'choices',
    },
    {
      name: 'survival',
      make: () => new SurvivalBook(fiveRunnerReference).snapshot(),
      restore: (snapshot: object) => SurvivalBook.restore(fiveRunnerReference, snapshot, null),
      array: 'choices',
    },
    {
      name: 'permutation',
      make: () => new PermutationBook(aetherOrderClassicReference).snapshot(),
      restore: (snapshot: object) =>
        PermutationBook.restore(aetherOrderClassicReference, snapshot, null),
      array: 'claims',
    },
  ] as const;

  it.each(books)(
    '$name rejects cycles, sparse bombs, and accessors with typed errors',
    (subject) => {
      const cyclic = structuredClone(subject.make()) as Record<string, unknown>;
      const cycle: unknown[] = [];
      cycle.push(cycle);
      cyclic[subject.array] = cycle;
      expect(() => subject.restore(cyclic)).toThrowError(RevealEngineError);

      const sparse = structuredClone(subject.make()) as Record<string, unknown>;
      sparse[subject.array] = new Array(200_000);
      expect(() => subject.restore(sparse)).toThrowError(
        expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
      );

      const accessor = structuredClone(subject.make()) as Record<string, unknown>;
      Object.defineProperty(accessor, 'terminal', {
        enumerable: true,
        get: () => false,
      });
      expect(() => subject.restore(accessor)).toThrowError(
        expect.objectContaining({ code: 'INVALID_SNAPSHOT' }),
      );
    },
  );
});

describe('round 2: published-round substitution resistance', () => {
  it('progressive refuses unbound play, rebinding, foreign settlement, and foreign restore', async () => {
    const honest = (
      await import('../../src/modules/progressive-market/fairness.js')
    ).makeTranscript(seed(820), binaryBeaconReference, 'progressive-honest');
    const foreign = (
      await import('../../src/modules/progressive-market/fairness.js')
    ).makeTranscript(seed(821), binaryBeaconReference, 'progressive-foreign');
    const binding = { roundId: honest.context.roundId, commitment: honest.commitment };
    await expect(
      new RoundBook(binaryBeaconReference, initialPosterior(binaryBeaconReference)).open({
        idempotencyKey: 'unbound',
        expectedFrameRevision: 0,
        outcome: 0,
        stake: 100n,
      }),
    ).rejects.toMatchObject({ code: 'COMMITMENT_MISMATCH' });
    const book = new RoundBook(
      binaryBeaconReference,
      initialPosterior(binaryBeaconReference),
      binding,
    );
    expect(() =>
      book.bindRound({ roundId: foreign.context.roundId, commitment: foreign.commitment }),
    ).toThrowError(expect.objectContaining({ code: 'COMMITMENT_MISMATCH' }));
    await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 0,
      outcome: 0,
      stake: 100n,
    });
    for (const event of foreign.evidence) await book.advanceFrame(event);
    await expect(
      book.settle({
        idempotencyKey: 'settle',
        expectedFrameRevision: foreign.evidence.length,
        revealedSeed: seed(821),
        transcript: foreign,
      }),
    ).rejects.toMatchObject({ code: 'COMMITMENT_MISMATCH' });
    expect(() =>
      RoundBook.restore(binaryBeaconReference, book.snapshot(), {
        roundId: foreign.context.roundId,
        commitment: foreign.commitment,
      }),
    ).toThrowError(expect.objectContaining({ code: 'COMMITMENT_MISMATCH' }));
  });

  it('cards rejects a self-consistent proof and restore for another published seed', async () => {
    const honestSeed = seed(822);
    const foreignSeed = seed(823);
    const honestRound = 'cards-honest';
    const foreignRound = 'cards-foreign';
    const admission = cardsAdmission(triadMiddleReference, honestSeed, honestRound);
    const book = new CardsBook(triadMiddleReference);
    await book.open({
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId: honestRound,
      ...admission,
      selections: [{ id: 'P', kind: 'position', position: 0, stake: 25n }],
    });
    const foreign = buildCardsTranscript(
      foreignSeed,
      triadMiddleReference,
      foreignRound,
      book.choices,
    );
    for (const step of deriveRevealSteps(triadMiddleReference, foreign.deal, book.choices))
      await book.advanceReveal({
        idempotencyKey: `reveal-${step.index}`,
        expectedStepRevision: step.index,
        step,
      });
    await expect(
      book.settle({
        idempotencyKey: 'settle',
        expectedStepRevision: triadMiddleReference.reveal.count,
        revealedSeed: foreignSeed,
        transcript: foreign,
      }),
    ).rejects.toMatchObject({ code: 'COMMITMENT_MISMATCH' });
    expect(() =>
      CardsBook.restore(triadMiddleReference, book.snapshot(), {
        roundId: foreignRound,
        seedCommitment: foreign.seedCommitment,
      }),
    ).toThrowError(expect.objectContaining({ code: 'COMMITMENT_MISMATCH' }));
  });

  it('survival rejects unbound play and a valid foreign committed outcome', async () => {
    const honestRound = roundRefId({
      roundId: 'survival-honest',
      clientEntropy: '31'.repeat(32),
    });
    const foreignRound = roundRefId({
      roundId: 'survival-foreign',
      clientEntropy: '32'.repeat(32),
    });
    const honestSeed = seed(824);
    const foreignSeed = seed(825);
    await expect(
      new SurvivalBook(fiveRunnerReference).enter('unbound', 0, 100n),
    ).rejects.toMatchObject({ code: 'COMMITMENT_MISMATCH' });
    const binding = survivalAdmission(fiveRunnerReference, honestSeed, honestRound);
    const book = new SurvivalBook(fiveRunnerReference, binding);
    for (let entity = 0; entity < fiveRunnerReference.entities; entity += 1)
      await book.enter(`enter-${entity}`, entity, 100n);
    for (let stage = 0; stage < fiveRunnerReference.stages && book.live.length > 0; stage += 1) {
      await book.choose(`choose-${stage}`, book.menu()[0] as string);
      const proof = makeSurvivalTranscript(
        foreignSeed,
        fiveRunnerReference,
        foreignRound,
        book.choices,
      );
      await book.resolve(proof.steps[stage] as (typeof proof.steps)[number]);
    }
    const foreign = makeSurvivalTranscript(
      foreignSeed,
      fiveRunnerReference,
      foreignRound,
      book.choices,
    );
    await expect(book.settle('settle', foreignSeed, foreign)).rejects.toMatchObject({
      code: 'COMMITMENT_MISMATCH',
    });
    expect(() =>
      SurvivalBook.restore(fiveRunnerReference, book.snapshot(), {
        roundId: 'survival-foreign',
        seedCommitment: foreign.seedCommitment,
      }),
    ).toThrowError(expect.objectContaining({ code: 'COMMITMENT_MISMATCH' }));
  });
});

describe('round 2: AETHER economics identity and settlement quantities', () => {
  const context = Object.freeze({
    gameId: aetherOrderClassic.id,
    variantId: aetherOrderClassic.variantId,
    roundId: 'aether-economics-binding',
    clientSeed: '44'.repeat(32),
    nonce: 7,
  });
  const altered = Object.freeze({
    ...aetherOrderClassic,
    pricing: Object.freeze({
      ...aetherOrderClassic.pricing,
      multipliers: Object.freeze({
        ...aetherOrderClassic.pricing.multipliers,
        first: rational(6n),
      }),
    }),
  }) as PermutationGameDefinition;

  it('binds fingerprint and module version before the ticket and through settlement', () => {
    const serverSeed = seed(826);
    const seedContext = {
      variantId: context.variantId,
      roundId: context.roundId,
      nonce: context.nonce,
    };
    expect(permutationAdapterFingerprint(altered)).not.toBe(
      permutationAdapterFingerprint(aetherOrderClassic),
    );
    expect(aetherSeedCommitment(serverSeed, altered, seedContext)).not.toBe(
      aetherSeedCommitment(serverSeed, aetherOrderClassic, seedContext),
    );
    expect(derivePermutation(serverSeed, altered, context)).not.toEqual(
      derivePermutation(serverSeed, aetherOrderClassic, context),
    );
    const ticket = openTicket(aetherOrderClassic, context, {
      lines: [{ code: 'first', params: { c: 0 }, stake: 25n }],
    });
    expect(ticket.adapterFingerprint).toBe(permutationAdapterFingerprint(aetherOrderClassic));
    const foreignTicket = openTicket(altered, context, {
      lines: [{ code: 'first', params: { c: 0 }, stake: 25n }],
    });
    expect(foreignTicket.ticketDigest).not.toBe(ticket.ticketDigest);
    const transcript = makeAetherTranscript(serverSeed, aetherOrderClassic, context);
    expect(() => settleTicket(altered, transcript, ticket)).toThrowError(
      expect.objectContaining({ code: 'ADAPTER_MISMATCH' }),
    );
  });

  it('refuses negative and inverted settlement records with a typed error', () => {
    expect(() =>
      settlementDigestFor('aether-order', 'classic', {
        lines: [],
        totalStake: 0n,
        gross: -1n,
        credited: -1n,
        capped: false,
        net: -1n,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TICKET' }));
    expect(() =>
      settlementDigestFor('aether-order', 'classic', {
        lines: [],
        totalStake: 0n,
        gross: 1n,
        credited: 2n,
        capped: false,
        net: 2n,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TICKET' }));
  });
});

describe('round 2: declared client entropy is enforced at admission', () => {
  it('cards refuses missing and short entropy before taking a stake', async () => {
    const seedHex = seed(827);
    const admission = cardsAdmission(triadMiddleReference, seedHex, 'entropy');
    const request = {
      idempotencyKey: 'open',
      expectedStepRevision: 0,
      roundId: 'entropy',
      seedCommitment: admission.seedCommitment,
      clientSeed: '',
      selections: [{ id: 'P', kind: 'position' as const, position: 0, stake: 25n }],
    };
    await expect(new CardsBook(triadMiddleReference).open(request)).rejects.toMatchObject({
      code: 'CLAIM_REJECTED',
      details: { reason: 'MISSING_CLIENT_ENTROPY' },
    });
    await expect(
      new CardsBook(triadMiddleReference).open({ ...request, clientSeed: 'aa' }),
    ).rejects.toMatchObject({ details: { reason: 'MISSING_CLIENT_ENTROPY' } });
    const accepted = new CardsBook(triadMiddleReference);
    await expect(
      accepted.open({ ...request, clientSeed: admission.clientSeed }),
    ).resolves.toMatchObject({ debited: 25n });
  });
});
