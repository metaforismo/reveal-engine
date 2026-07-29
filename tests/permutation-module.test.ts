import { describe, expect, it } from 'vitest';
import { ENGINE_LIMITS } from '../src/api/limits.js';
import { RevealEngineError } from '../src/api/errors.js';
import { sealCommitment } from '../src/core/commitment.js';
import {
  assertModuleConformance,
  checkModuleConformance,
} from '../src/conformance/module-conformance.js';
import { defineLifecycleModule } from '../src/core/module.js';
import { equal, rational } from '../src/core/rational.js';
import { snapshotHash } from '../src/core/snapshot.js';
import { COMMITMENT_VERSION, MODULE_API_VERSION } from '../src/core/versions.js';
import { encodeFields, type CanonicalField } from '../src/internal/canonical.js';
import { findModule, listModules, requireModule } from '../src/modules/index.js';
import {
  aetherOrderClassicReference,
  aetherOrderSevenReference,
  assertBet,
  betFromParameters,
  betParameters,
  betWins,
  claimSignature,
  definePermutationGame,
  derivePermutationOrder,
  derivePermutationSteps,
  deserializePermutationTranscript,
  enumerateInstances,
  enumerateOrders,
  itemBelief,
  linePayout,
  makePermutationTranscript,
  permutation,
  permutationFingerprint,
  permutationTranscriptToWire,
  PermutationBook,
  price,
  serializePermutationTranscript,
  stakedSnapshotFor,
  triadReference,
  verifyPermutationTranscript,
  type PermutationBet,
  type PermutationDefinition,
} from '../src/modules/permutation/index.js';
import { seed } from './helpers.js';

const CLASSIC = aetherOrderClassicReference;
const SEVEN = aetherOrderSevenReference;

function captureError(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('permutation module: contract surface', () => {
  it('registers alongside the progressive market without displacing it', () => {
    expect(listModules().map((module) => module.id)).toEqual(['progressive-market', 'permutation']);
    expect(findModule('permutation')).toBe(permutation);
    expect(requireModule('permutation').moduleApiVersion).toBe(MODULE_API_VERSION);
    expect(Object.isFrozen(permutation)).toBe(true);
  });

  it('declares the shape the lifecycle contract predicted for it', () => {
    expect(permutation.truth.kind).toBe('permutation');
    expect(permutation.steps.choiceTiming).toBe('none');
    expect(permutation.steps.beliefSpace).toBe('marginal');
    expect(permutation.book.positions).toBe('multi');
    expect(permutation.book.settlement).toBe('paytable');
    expect(permutation.book.actions).toEqual(['place', 'settle']);
    expect(permutation.transcript.schema).toBe('reveal-engine/permutation-transcript-v1');
    expect(permutation.book.snapshotSchema).toBe('reveal-engine/permutation-book-v1');
    // A marginal module must price exactly; a seed pre-commitment is only for a
    // choice-timed one and this module logs no decisions at all.
    expect(typeof permutation.steps.price).toBe('function');
    expect(permutation.transcript.seedCommitment).toBeUndefined();
    expect(permutation.transcript.choicesOf).toBeUndefined();
  });

  it('routes every declared hook to the implementation', () => {
    const roundId = 'contract-round';
    const identity = permutation.definitions.identity(CLASSIC);
    expect(identity).toMatchObject({
      moduleId: 'permutation',
      moduleVersion: '1.0.0',
      definitionId: CLASSIC.id,
      definitionVersion: CLASSIC.version,
    });
    expect(identity.fingerprint).toBe(permutation.definitions.fingerprint(CLASSIC));

    const round = { ...identity, roundId, proofVersion: COMMITMENT_VERSION };
    const truth = permutation.truth.derive(seed(7), CLASSIC, roundId);
    const steps = permutation.steps.derive(seed(7), CLASSIC, round, truth, []);
    expect(steps).toHaveLength(permutation.steps.count(CLASSIC));
    expect(permutation.steps.count(CLASSIC)).toBe(CLASSIC.items.length - 1);

    const transcript = permutation.transcript.build(seed(7), CLASSIC, roundId);
    expect(permutation.truth.equal(transcript.order, truth)).toBe(true);
    expect(permutation.steps.equal(transcript.reveals, steps)).toBe(true);
    expect(transcript.commitment).toBe(
      sealCommitment(
        seed(7),
        permutation.transcript.commitmentBody(CLASSIC, round, truth, steps, []),
      ),
    );
    expect(permutation.verify(seed(7), CLASSIC, transcript).ok).toBe(true);
    expect(permutation.transcript.fromWire(permutation.transcript.toWire(transcript))).toEqual(
      transcript,
    );
    expect(permutation.truth.enumerate?.(triadReference)).toHaveLength(6);
    expect(permutation.definitions.define(CLASSIC)).toEqual(CLASSIC);
  });

  /**
   * `encode()` is the module's statement of what binds the truth and the steps
   * into the commitment, and core cannot check it: it seals whatever bytes the
   * body returns and has no idea where a truth section starts. So the guarantee
   * has to be that the body is *composed* from the declarations — and this is
   * what says it is. The body is rebuilt from nothing but public declarations,
   * and the two negative cases show the rebuild would notice a drift.
   */
  it('composes the commitment body out of the encoders it declares', () => {
    const roundId = 'encode-round';
    const round = {
      ...permutation.definitions.identity(CLASSIC),
      roundId,
      proofVersion: COMMITMENT_VERSION,
    };
    const truth = permutation.truth.derive(seed(19), CLASSIC, roundId);
    const steps = permutation.steps.derive(seed(19), CLASSIC, round, truth, []);
    const sealed = permutation.transcript.commitmentBody(CLASSIC, round, truth, steps, []);
    const bodyFrom = (
      encodeTruth: (value: typeof truth) => readonly CanonicalField[],
      encodeStep: (value: (typeof steps)[number]) => readonly CanonicalField[],
    ): Buffer =>
      Buffer.from(
        encodeFields([
          'Axiom Games Reveal Engine permutation commitment',
          COMMITMENT_VERSION,
          'permutation',
          ...canonicalDefinitionFields(CLASSIC),
          permutationFingerprint(CLASSIC),
          roundId,
          COMMITMENT_VERSION,
          ...encodeTruth(truth),
          steps.length,
          ...steps.flatMap((step) => [...encodeStep(step)]),
        ]),
      );

    expect(
      Buffer.compare(sealed, bodyFrom(permutation.truth.encode, permutation.steps.encode)),
    ).toBe(0);
    expect(
      Buffer.compare(
        sealed,
        bodyFrom(() => [], permutation.steps.encode),
      ),
    ).not.toBe(0);
    expect(
      Buffer.compare(
        sealed,
        bodyFrom(permutation.truth.encode, (step) => [step.position]),
      ),
    ).not.toBe(0);
  });

  it('refuses a choice log it does not model', () => {
    const round = {
      ...permutation.definitions.identity(CLASSIC),
      roundId: 'no-choices',
      proofVersion: COMMITMENT_VERSION,
    };
    const truth = permutation.truth.derive(seed(3), CLASSIC, 'no-choices');
    const steps = permutation.steps.derive(seed(3), CLASSIC, round, truth, []);
    expect(() =>
      permutation.transcript.commitmentBody(CLASSIC, round, truth, steps, ['x' as never]),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CHOICE' }));
    expect(() =>
      permutation.steps.derive(seed(3), CLASSIC, round, truth, ['x' as never]),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CHOICE' }));
  });

  /**
   * `steps.derive` and `commitmentBody` take a truth from their caller, and both
   * are public. A short or repeating array must be a typed `DERIVATION_FAILED`
   * and not a `TypeError` raised from inside `encodeFields` — the commitment
   * layer is the one place a raw throw hurts most, because a verifier has to
   * classify whatever comes back.
   */
  it.each([
    ['too short', [0, 1, 2]],
    ['too long', [0, 1, 2, 3, 4, 0]],
    ['repeating an item', [0, 0, 2, 3, 4]],
    ['item out of range', [0, 1, 2, 3, 9]],
    ['not an array', 'abcde'],
    ['holes', [0, 1, undefined, 3, 4]],
  ])('refuses a truth that is not a permutation: %s', (_label, truth) => {
    const round = {
      ...permutation.definitions.identity(CLASSIC),
      roundId: 'bad-truth',
      proofVersion: COMMITMENT_VERSION,
    };
    const honest = permutation.truth.derive(seed(3), CLASSIC, 'bad-truth');
    const steps = permutation.steps.derive(seed(3), CLASSIC, round, honest, []);
    for (const operation of [
      () => permutation.steps.derive(seed(3), CLASSIC, round, truth as never, []),
      () => permutation.transcript.commitmentBody(CLASSIC, round, truth as never, steps, []),
    ]) {
      const error = captureError(operation);
      expect(error).toBeInstanceOf(RevealEngineError);
      expect(error).not.toBeInstanceOf(TypeError);
      expect((error as RevealEngineError).code).toBe('DERIVATION_FAILED');
    }
  });

  it('refuses a reveal list that is not the round it seals', () => {
    const round = {
      ...permutation.definitions.identity(CLASSIC),
      roundId: 'bad-steps',
      proofVersion: COMMITMENT_VERSION,
    };
    const truth = permutation.truth.derive(seed(3), CLASSIC, 'bad-steps');
    const steps = permutation.steps.derive(seed(3), CLASSIC, round, truth, []);
    for (const broken of [
      [],
      steps.slice(0, 2),
      [...steps, { position: 4, item: 0 }],
      steps.map((step, index) => (index === 0 ? { position: 3, item: step.item } : step)),
      steps.map((step, index) => (index === 0 ? { position: 0, item: 99 } : step)),
    ]) {
      const error = captureError(() =>
        permutation.transcript.commitmentBody(CLASSIC, round, truth, broken as never, []),
      );
      expect(error).toBeInstanceOf(RevealEngineError);
      expect((error as RevealEngineError).code).toBe('DERIVATION_FAILED');
    }
  });

  it('holds derivation to the step budget it declared', () => {
    const cramped = defineLifecycleModule({
      ...permutation,
      steps: { ...permutation.steps, maxSteps: 1 },
    } as never) as typeof permutation;
    const round = {
      ...permutation.definitions.identity(CLASSIC),
      roundId: 'budget',
      proofVersion: COMMITMENT_VERSION,
    };
    const truth = permutation.truth.derive(seed(29), CLASSIC, 'budget');
    expect(() => cramped.steps.derive(seed(29), CLASSIC, round, truth, [])).toThrowError(
      expect.objectContaining({ code: 'DERIVATION_FAILED', path: '$.steps.maxSteps' }),
    );
  });
});

/** Mirrors `definitionFields`, so the composition test above stays a real rebuild. */
function canonicalDefinitionFields(definition: PermutationDefinition): readonly CanonicalField[] {
  return [
    'permutation',
    '1.0.0',
    definition.id,
    definition.version,
    definition.items.length,
    ...definition.items,
    definition.rtp.numerator,
    definition.rtp.denominator,
    5,
    ...(['full', 'slot', 'first', 'last', 'stack'] as const).flatMap((code) => [
      code,
      definition.paytable[code].numerator,
      definition.paytable[code].denominator,
    ]),
    definition.maxWinMultiple,
    definition.stakeQuantum,
    definition.minLineStake,
    definition.maxLineStake,
    definition.maxTicketStake,
    definition.maxOpenBets,
  ];
}

describe('permutation module: truth, steps, and belief', () => {
  it('draws a permutation that moves with the seed and with the round', () => {
    const a = derivePermutationOrder(seed(1), CLASSIC, 'r1');
    const b = derivePermutationOrder(seed(2), CLASSIC, 'r1');
    const c = derivePermutationOrder(seed(1), CLASSIC, 'r2');
    for (const order of [a, b, c]) {
      expect([...order].sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4]);
      expect(Object.isFrozen(order)).toBe(true);
    }
    expect(a.join()).not.toBe(b.join());
    expect(a.join()).not.toBe(c.join());
    // The definition is part of the sampler domain, so two games never share a draw.
    const other = derivePermutationOrder(seed(1), { ...CLASSIC, id: 'other-game' }, 'r1');
    expect(a.join()).not.toBe(other.join());
  });

  it('reveals one position short of the draw, in settle order', () => {
    const order = derivePermutationOrder(seed(5), SEVEN, 'reveals');
    const steps = derivePermutationSteps(SEVEN, order);
    expect(steps).toHaveLength(SEVEN.items.length - 1);
    steps.forEach((step, index) => {
      expect(step.position).toBe(index);
      expect(step.item).toBe(order[index]);
    });
    // The forced final position is not a step, and does not need to be: it is
    // the one item the reveals did not name.
    const revealed = new Set(steps.map((step) => step.item));
    const remaining = order.filter((item) => !revealed.has(item));
    expect(remaining).toEqual([order[order.length - 1]]);
  });

  it('eliminates a settled item to exactly zero and never to an epsilon', () => {
    const transcript = makePermutationTranscript(seed(9), CLASSIC, 'belief');
    for (let prefix = 0; prefix <= transcript.reveals.length; prefix += 1) {
      const belief = itemBelief(CLASSIC, transcript.reveals.slice(0, prefix));
      expect(belief.total).toBe(BigInt(CLASSIC.items.length - prefix));
      expect(belief.weights.filter((weight) => weight === 0n)).toHaveLength(prefix);
      for (const step of transcript.reveals.slice(0, prefix))
        expect(belief.weights[step.item]).toBe(0n);
    }
    // The final prefix leaves exactly one live item, which is why the round
    // stops one reveal short: a full reveal would be an all-zero vector.
    const last = itemBelief(CLASSIC, transcript.reveals);
    expect(last.total).toBe(1n);
    expect(last.weights[transcript.order[4] as number]).toBe(1n);
  });

  it('refuses a step list that is not a settle prefix', () => {
    const transcript = makePermutationTranscript(seed(9), CLASSIC, 'bad-prefix');
    const reveals = transcript.reveals;
    for (const broken of [
      [{ position: 1, item: 0 }],
      [reveals[0]!, { position: 1, item: reveals[0]!.item }],
      [...reveals, { position: 4, item: transcript.order[4] as number }],
      [null as never],
      [{ position: 0, item: 99 }],
    ])
      expect(() => price(CLASSIC, broken, { code: 'first', item: 0 })).toThrowError(
        expect.objectContaining({ code: 'INVALID_TRANSCRIPT' }),
      );
  });
});

describe('permutation module: bets, pricing, and claim identity', () => {
  it.each([
    ['unknown code', { code: 'trifecta', items: [0, 1] }],
    ['non-object', 42],
    ['null', null],
    ['array', [0, 1]],
    ['item out of range', { code: 'first', item: 5 }],
    ['negative item', { code: 'first', item: -1 }],
    ['fractional item', { code: 'first', item: 1.5 }],
    ['position out of range', { code: 'slot', item: 0, position: 5 }],
    ['stack on one item', { code: 'stack', before: 2, after: 2 }],
    ['short full order', { code: 'full', order: [0, 1, 2] }],
    ['repeating full order', { code: 'full', order: [0, 0, 1, 2, 3] }],
    ['full order not an array', { code: 'full', order: 'abcde' }],
  ])('rejects a hostile bet: %s', (_label, bet) => {
    const error = captureError(() => assertBet(bet, CLASSIC));
    expect(error).toBeInstanceOf(RevealEngineError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as RevealEngineError).code).toBe('CLAIM_REJECTED');
  });

  it('treats two spellings of one claim as one claim', () => {
    const n = CLASSIC.items.length;
    for (let item = 0; item < n; item += 1) {
      expect(claimSignature(CLASSIC, { code: 'first', item })).toBe(
        claimSignature(CLASSIC, { code: 'slot', item, position: 0 }),
      );
      expect(claimSignature(CLASSIC, { code: 'last', item })).toBe(
        claimSignature(CLASSIC, { code: 'slot', item, position: n - 1 }),
      );
      expect(claimSignature(CLASSIC, { code: 'first', item })).not.toBe(
        claimSignature(CLASSIC, { code: 'last', item }),
      );
    }
    // Distinct draws never share a claim identity, because the size is bound in.
    expect(claimSignature(CLASSIC, { code: 'first', item: 0 })).not.toBe(
      claimSignature(SEVEN, { code: 'first', item: 0 }),
    );
  });

  it('round-trips a bet through its canonical parameter vector', () => {
    const bets: readonly PermutationBet[] = [
      { code: 'full', order: [3, 1, 0, 4, 2] },
      { code: 'slot', item: 2, position: 3 },
      { code: 'first', item: 4 },
      { code: 'last', item: 1 },
      { code: 'stack', before: 0, after: 2 },
    ];
    for (const bet of bets)
      expect(betFromParameters(CLASSIC, bet.code, betParameters(bet))).toEqual(bet);
    for (const [code, parameters] of [
      ['first', [0, 1]],
      ['slot', [0]],
      ['full', [0, 1, 2]],
      ['stack', [0, 1, 2]],
      ['nope', [0]],
      ['first', [1.5]],
    ] as const)
      expect(() => betFromParameters(CLASSIC, code, parameters)).toThrowError(
        expect.objectContaining({ code: 'CLAIM_REJECTED' }),
      );
  });

  /**
   * Metamorphic: relabelling the items permutes the outcome but must not change
   * any price. The catalogue is symmetric under relabelling, so a pricing rule
   * that quietly favoured a particular index would show up here and nowhere in
   * the closed forms.
   */
  it('prices are invariant under relabelling of the items', () => {
    const relabel = (item: number): number => (item + 2) % CLASSIC.items.length;
    const transcript = makePermutationTranscript(seed(15), CLASSIC, 'relabel');
    for (let prefix = 0; prefix <= transcript.reveals.length; prefix += 1) {
      const steps = transcript.reveals.slice(0, prefix);
      const mapped = steps.map((step) => ({ position: step.position, item: relabel(step.item) }));
      for (const bet of [
        { code: 'first', item: 1 },
        { code: 'last', item: 3 },
        { code: 'slot', item: 2, position: 2 },
        { code: 'stack', before: 0, after: 4 },
        { code: 'full', order: [...transcript.order] },
      ] satisfies PermutationBet[]) {
        const image: PermutationBet =
          bet.code === 'full'
            ? { code: 'full', order: bet.order.map(relabel) }
            : bet.code === 'slot'
              ? { code: 'slot', item: relabel(bet.item), position: bet.position }
              : bet.code === 'stack'
                ? { code: 'stack', before: relabel(bet.before), after: relabel(bet.after) }
                : { code: bet.code, item: relabel(bet.item) };
        expect(equal(price(CLASSIC, steps, bet), price(CLASSIC, mapped, image))).toBe(true);
      }
    }
  });

  /**
   * Metamorphic: revealing one more position can only sharpen a price, never
   * blur it. A claim already contradicted stays at exactly zero, and a claim
   * already certain stays at exactly one — a conditional counter that dropped a
   * constraint would show up as a price rising back off zero.
   */
  it('a revealed position never resurrects a dead claim or kills a certain one', () => {
    const transcript = makePermutationTranscript(seed(17), SEVEN, 'monotone');
    const instances = (['slot', 'first', 'last', 'stack'] as const).flatMap((code) => [
      ...enumerateInstances(SEVEN, code),
    ]);
    for (const bet of instances) {
      let dead = false;
      let certain = false;
      for (let prefix = 0; prefix <= transcript.reveals.length; prefix += 1) {
        const quoted = price(SEVEN, transcript.reveals.slice(0, prefix), bet);
        if (dead) expect(quoted.numerator).toBe(0n);
        if (certain) expect(equal(quoted, rational(1n))).toBe(true);
        dead ||= quoted.numerator === 0n;
        certain ||= equal(quoted, rational(1n));
      }
      // And the fully-revealed price agrees with settlement, both ways.
      const settled = betWins(SEVEN, bet, transcript.order);
      expect(equal(price(SEVEN, transcript.reveals, bet), rational(settled ? 1n : 0n))).toBe(true);
    }
  });

  it('enumerates the whole truth space exactly once', () => {
    for (const [size, expected] of [
      [3, 6],
      [4, 24],
      [5, 120],
    ] as const) {
      const orders = enumerateOrders(size);
      expect(orders).toHaveLength(expected);
      expect(new Set(orders.map((order) => order.join(','))).size).toBe(orders.length);
    }
  });
});

describe('permutation module: definitions', () => {
  it.each([
    ['two items', { items: ['a', 'b'] }],
    ['nine items', { items: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }],
    ['duplicate items', { items: ['a', 'a', 'c', 'd', 'e'] }],
    ['rtp above one', { rtp: rational(26n, 25n) }],
    ['zero rtp', { rtp: rational(0n, 25n) }],
    ['stake below the quantum', { minLineStake: 10n }],
    ['line above the ticket', { maxLineStake: 40_000n }],
    ['min above max', { minLineStake: 10_000n, maxLineStake: 25n }],
    ['no open bets', { maxOpenBets: 0 }],
    ['too many open bets', { maxOpenBets: 999 }],
    ['negative cap', { maxWinMultiple: -1n }],
  ])('refuses a malformed definition: %s', (_label, patch) => {
    expect(() =>
      definePermutationGame({ ...CLASSIC, ...patch } as PermutationDefinition),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER' }));
  });

  it('refuses a paytable that cannot pay in whole units at the declared quantum', () => {
    expect(() =>
      definePermutationGame({
        ...CLASSIC,
        id: 'coarse-quantum',
        stakeQuantum: 2n,
        minLineStake: 2n,
        maxLineStake: 10n,
        maxTicketStake: 100n,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER' }));
  });

  it('moves the fingerprint for every replay-visible field', () => {
    const base = permutationFingerprint(CLASSIC);
    const variants: readonly Partial<PermutationDefinition>[] = [
      { id: 'other' },
      { version: '1.0.1' },
      { items: ['amber', 'coral', 'violet', 'aqua', 'onyx'] },
      { maxWinMultiple: 4_999n },
      { stakeQuantum: 50n, minLineStake: 50n, maxLineStake: 5_000n, maxTicketStake: 20_000n },
      { minLineStake: 50n },
      { maxLineStake: 2_500n },
      { maxTicketStake: 10_000n },
      { maxOpenBets: 11 },
    ];
    const seen = new Set([base]);
    for (const patch of variants) {
      const moved = permutationFingerprint({ ...CLASSIC, ...patch } as PermutationDefinition);
      expect(moved, JSON.stringify(Object.keys(patch))).not.toBe(base);
      seen.add(moved);
    }
    expect(seen.size).toBe(variants.length + 1);
    // The RTP and the paytable move it too, but they cannot move independently:
    // `definePermutationGame` refuses a paytable that misprices the RTP.
    const cheaper = definePermutationGame({
      ...CLASSIC,
      id: 'cheaper',
      rtp: rational(19n, 20n),
      paytable: {
        full: rational(114n, 1n),
        slot: rational(19n, 4n),
        first: rational(19n, 4n),
        last: rational(19n, 4n),
        stack: rational(19n, 4n),
      },
      stakeQuantum: 100n,
      minLineStake: 100n,
      maxLineStake: 5_000n,
      maxTicketStake: 20_000n,
    });
    expect(permutationFingerprint(cheaper)).not.toBe(base);
  });
});

describe('permutation module: transcript codec and verifier', () => {
  const transcript = makePermutationTranscript(seed(11), CLASSIC, 'codec');

  it('round-trips through the wire form and its JSON encoding', () => {
    const wire = permutationTranscriptToWire(transcript);
    expect(deserializePermutationTranscript(wire)).toEqual(transcript);
    expect(deserializePermutationTranscript(serializePermutationTranscript(transcript))).toEqual(
      transcript,
    );
  });

  it.each([
    ['unknown field', (wire: Record<string, unknown>) => ({ ...wire, surprise: true })],
    ['missing field', ({ commitment: _drop, ...rest }: Record<string, unknown>) => rest],
    [
      'unknown definition field',
      (wire: Record<string, unknown>) => ({
        ...wire,
        definition: { ...(wire.definition as object), extra: 1 },
      }),
    ],
    ['order with a hole', (wire: Record<string, unknown>) => ({ ...wire, order: [0, 1, 2, 3, 9] })],
    [
      'order with a repeat',
      (wire: Record<string, unknown>) => ({ ...wire, order: [0, 0, 2, 3, 4] }),
    ],
    ['order too short', (wire: Record<string, unknown>) => ({ ...wire, order: [0, 1] })],
    [
      'reveal out of order',
      (wire: Record<string, unknown>) => ({
        ...wire,
        reveals: [{ position: 1, item: 0 }, ...(wire.reveals as object[]).slice(1)],
      }),
    ],
    [
      'reveal repeating an item',
      (wire: Record<string, unknown>) => ({
        ...wire,
        reveals: (wire.reveals as { position: number; item: number }[]).map((step, index) =>
          index === 1 ? { ...step, item: (wire.reveals as { item: number }[])[0]!.item } : step,
        ),
      }),
    ],
    [
      'reveals too long',
      (wire: Record<string, unknown>) => ({
        ...wire,
        reveals: [...(wire.reveals as object[]), { position: 4, item: 2 }],
      }),
    ],
    ['short commitment', (wire: Record<string, unknown>) => ({ ...wire, commitment: 'abc' })],
    [
      'uppercase commitment',
      (wire: Record<string, unknown>) => ({
        ...wire,
        commitment: (wire.commitment as string).toUpperCase(),
      }),
    ],
    ['empty round id', (wire: Record<string, unknown>) => ({ ...wire, roundId: '' })],
  ])('fails closed on a malformed transcript: %s', (_label, mutate) => {
    const wire = mutate({ ...permutationTranscriptToWire(transcript) } as Record<string, unknown>);
    const error = captureError(() => deserializePermutationTranscript(wire));
    expect(error).toBeInstanceOf(RevealEngineError);
    expect((error as RevealEngineError).code).toBe('INVALID_TRANSCRIPT');
  });

  it.each([null, undefined, 4, 'x', [], {}, { schema: 'reveal-engine/permutation-transcript-v2' }])(
    'returns a typed verification failure for hostile input %#',
    (input) => {
      const result = verifyPermutationTranscript(seed(11), CLASSIC, input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['INVALID_TRANSCRIPT', 'UNSUPPORTED_VERSION']).toContain(result.code);
    },
  );

  it('rejects an oversized payload before parsing it', () => {
    expect(() =>
      deserializePermutationTranscript(' '.repeat(ENGINE_LIMITS.maxTranscriptBytes + 1)),
    ).toThrowError(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }));
  });

  it('distinguishes order, reveal, commitment, and definition tampering', () => {
    const wire = permutationTranscriptToWire(transcript);
    expect(verifyPermutationTranscript(seed(11), CLASSIC, wire).ok).toBe(true);
    expect(
      verifyPermutationTranscript(seed(11), CLASSIC, {
        ...wire,
        order: [...wire.order.slice(1), wire.order[0]],
      }),
    ).toMatchObject({ ok: false, code: 'TRANSCRIPT_MISMATCH' });
    expect(
      verifyPermutationTranscript(seed(11), CLASSIC, {
        ...wire,
        reveals: wire.reveals.map((step, index) =>
          index < 2 ? { ...step, item: wire.reveals[1 - index]!.item } : step,
        ),
      }),
    ).toMatchObject({ ok: false, code: 'TRANSCRIPT_MISMATCH' });
    expect(
      verifyPermutationTranscript(seed(11), CLASSIC, { ...wire, commitment: '0'.repeat(64) }),
    ).toMatchObject({ ok: false, code: 'COMMITMENT_MISMATCH' });
    expect(verifyPermutationTranscript(seed(11), SEVEN, wire)).toMatchObject({
      ok: false,
      code: 'DEFINITION_MISMATCH',
    });
    expect(
      verifyPermutationTranscript(seed(11), { ...CLASSIC, version: '9.9.9' }, wire),
    ).toMatchObject({ ok: false, code: 'DEFINITION_MISMATCH' });
    expect(verifyPermutationTranscript(seed(12), CLASSIC, wire)).toMatchObject({ ok: false });
  });

  it('rejects a malformed seed as a seed problem, not a transcript problem', () => {
    for (const invalid of ['', 'zz', '00', '00'.repeat(33)])
      expect(verifyPermutationTranscript(invalid, CLASSIC, transcript)).toMatchObject({
        ok: false,
        code: 'INVALID_TRANSCRIPT',
      });
  });
});

describe('permutation module: multi-bet round book', () => {
  const roundId = 'book-round';

  async function stakedRound(definition = CLASSIC, seedHex = seed(21), id = roundId) {
    const transcript = makePermutationTranscript(seedHex, definition, id);
    const book = new PermutationBook(definition);
    return { transcript, book, seedHex };
  }

  it('settles several independent bets against one paytable', async () => {
    const { transcript, book, seedHex } = await stakedRound();
    const winner = transcript.order[0] as number;
    const loser = transcript.order[1] as number;
    await book.place({ idempotencyKey: 'a', bet: { code: 'first', item: winner }, stake: 100n });
    await book.place({ idempotencyKey: 'b', bet: { code: 'first', item: loser }, stake: 50n });
    await book.place({
      idempotencyKey: 'c',
      bet: { code: 'full', order: transcript.order },
      stake: 25n,
    });
    expect(book.claims).toHaveLength(3);
    // Every bet is separately funded, so every bet raises the ceiling.
    expect(book.capBasisStake).toBe(175n);
    expect(book.stakedTotal).toBe(175n);

    const receipt = await book.settle({ idempotencyKey: 's', revealedSeed: seedHex, transcript });
    // 100 x 24/5 = 480 on the winning FIRST, 25 x 576/5 = 2880 on FULL ORDER.
    expect(receipt.credited).toBe(3_360n);
    expect(receipt.capped).toBe(false);
    expect(book.terminal).toBe(true);
    expect(book.liquidBalance).toBe(3_360n);
  });

  it('refuses a second spelling of a claim already on the ticket', async () => {
    const { book } = await stakedRound();
    await book.place({ idempotencyKey: 'a', bet: { code: 'first', item: 2 }, stake: 100n });
    await expect(
      book.place({
        idempotencyKey: 'b',
        bet: { code: 'slot', item: 2, position: 0 },
        stake: 100n,
      }),
    ).rejects.toMatchObject({ code: 'CLAIM_REJECTED', path: '$.bet' });
    // A different item, or the same item at a different position, is a real claim.
    await book.place({
      idempotencyKey: 'c',
      bet: { code: 'slot', item: 2, position: 1 },
      stake: 25n,
    });
    expect(book.claims).toHaveLength(2);
  });

  it.each([
    ['off the quantum', 30n],
    ['below the minimum', 0n],
    ['above the line ceiling', 5_025n],
    ['negative', -25n],
  ])('refuses a stake %s', async (_label, stake) => {
    const { book } = await stakedRound();
    await expect(
      book.place({ idempotencyKey: 'a', bet: { code: 'first', item: 0 }, stake }),
    ).rejects.toBeInstanceOf(RevealEngineError);
  });

  it('refuses a ticket that breaches the round stake ceiling', async () => {
    const { book } = await stakedRound();
    for (let index = 0; index < 4; index += 1)
      await book.place({
        idempotencyKey: `line-${index}`,
        bet: { code: 'slot', item: 0, position: index },
        stake: 5_000n,
      });
    expect(book.stakedTotal).toBe(20_000n);
    await expect(
      book.place({ idempotencyKey: 'over', bet: { code: 'first', item: 1 }, stake: 25n }),
    ).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
  });

  it('holds the ticket to its declared open-bet budget', async () => {
    const tight = definePermutationGame({ ...CLASSIC, id: 'tight-book', maxOpenBets: 2 });
    const book = new PermutationBook(tight);
    await book.place({ idempotencyKey: 'a', bet: { code: 'first', item: 0 }, stake: 25n });
    await book.place({ idempotencyKey: 'b', bet: { code: 'first', item: 1 }, stake: 25n });
    await expect(
      book.place({ idempotencyKey: 'c', bet: { code: 'first', item: 2 }, stake: 25n }),
    ).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
  });

  it('replays an exact retry and refuses a reused key with a different payload', async () => {
    const { book } = await stakedRound();
    const request = {
      idempotencyKey: 'a',
      bet: { code: 'first', item: 0 } as const,
      stake: 5_000n,
    };
    const first = await book.place(request);
    const retry = await book.place(request);
    expect(retry).toEqual(first);
    // A replay must not be charged against the ticket ceiling twice.
    expect(book.stakedTotal).toBe(5_000n);
    expect(book.claims).toHaveLength(1);
    await expect(book.place({ ...request, stake: 25n })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('will not settle against a proof it cannot verify', async () => {
    const { transcript, book, seedHex } = await stakedRound();
    await book.place({ idempotencyKey: 'a', bet: { code: 'first', item: 0 }, stake: 100n });
    await expect(
      book.settle({ idempotencyKey: 's', revealedSeed: seed(99), transcript }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSCRIPT' });
    await expect(
      book.settle({
        idempotencyKey: 's2',
        revealedSeed: seedHex,
        transcript: { ...permutationTranscriptToWire(transcript), commitment: '0'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSCRIPT' });
    expect(book.terminal).toBe(false);
    // The honest proof still settles afterwards: a rejected command left the
    // round untouched rather than half-applied.
    await book.settle({ idempotencyKey: 's3', revealedSeed: seedHex, transcript });
    expect(book.terminal).toBe(true);
  });

  it('closes the round to further commands once it is terminal', async () => {
    const { transcript, book, seedHex } = await stakedRound();
    await book.place({ idempotencyKey: 'a', bet: { code: 'first', item: 0 }, stake: 100n });
    await book.settle({ idempotencyKey: 's', revealedSeed: seedHex, transcript });
    await expect(
      book.place({ idempotencyKey: 'b', bet: { code: 'first', item: 1 }, stake: 25n }),
    ).rejects.toMatchObject({ code: 'ROUND_TERMINAL' });
    await expect(
      book.settle({ idempotencyKey: 's2', revealedSeed: seedHex, transcript }),
    ).rejects.toMatchObject({ code: 'ROUND_TERMINAL' });
  });

  it('settles an empty ticket at zero rather than failing', async () => {
    const { transcript, book, seedHex } = await stakedRound();
    const receipt = await book.settle({ idempotencyKey: 's', revealedSeed: seedHex, transcript });
    expect(receipt.credited).toBe(0n);
    expect(receipt.capped).toBe(false);
    expect(book.capBasisStake).toBeUndefined();
  });

  /**
   * The regression a single-basis cap would cause: staking 1 quantum on a loser
   * and the maximum on a winner must not pin the ceiling to the first stake.
   */
  it('pays a multi-bet claim a single-basis cap would have crushed', async () => {
    const capped = definePermutationGame({ ...CLASSIC, id: 'tight-cap', maxWinMultiple: 10n });
    const transcript = makePermutationTranscript(seed(23), capped, 'cap-round');
    const book = new PermutationBook(capped);
    const winner = transcript.order[0] as number;
    const loser = transcript.order[1] as number;
    await book.place({ idempotencyKey: 'tiny', bet: { code: 'first', item: loser }, stake: 25n });
    await book.place({
      idempotencyKey: 'real',
      bet: { code: 'first', item: winner },
      stake: 5_000n,
    });
    expect(book.capBasisStake).toBe(5_025n);
    const receipt = await book.settle({
      idempotencyKey: 's',
      revealedSeed: seed(23),
      transcript,
    });
    // 5,000 x 24/5 = 24,000, comfortably inside 5,025 x 10 = 50,250.
    expect(receipt.credited).toBe(24_000n);
    expect(receipt.capped).toBe(false);
    expect(receipt.credited).toBeLessThanOrEqual(5_025n * 10n);
  });

  it('caps a claim that exceeds the ceiling and says so on the receipt', async () => {
    // A cap this tight is a deliberately non-conforming definition: the module's
    // own `PRICING_IDENTITY_BROKEN` check reports it, precisely because a cap a
    // single line can reach means the advertised RTP is not the RTP.
    const tight = definePermutationGame({ ...CLASSIC, id: 'binding-cap', maxWinMultiple: 2n });
    expect(checkModuleConformance(permutation, tight, 1).ok).toBe(false);
    const transcript = makePermutationTranscript(seed(24), tight, 'capped-round');
    const book = new PermutationBook(tight);
    await book.place({
      idempotencyKey: 'a',
      bet: { code: 'first', item: transcript.order[0] as number },
      stake: 100n,
    });
    const receipt = await book.settle({ idempotencyKey: 's', revealedSeed: seed(24), transcript });
    expect(receipt.credited).toBe(200n);
    expect(receipt.capped).toBe(true);
    expect(book.liquidBalance).toBeLessThanOrEqual(100n * 2n);
  });

  it.each([null, 'x', 5, [], { idempotencyKey: '' }])(
    'maps a malformed place request to a typed error: %j',
    async (request) => {
      const book = new PermutationBook(CLASSIC);
      await expect(book.place(request as never)).rejects.toBeInstanceOf(RevealEngineError);
    },
  );

  it.each([null, 'x', 5, [], { idempotencyKey: 's' }])(
    'maps a malformed settle request to a typed error: %j',
    async (request) => {
      const book = new PermutationBook(CLASSIC);
      await expect(book.settle(request as never)).rejects.toBeInstanceOf(RevealEngineError);
    },
  );

  it('prices a line payout exactly or refuses it', () => {
    expect(linePayout(CLASSIC, 'full', 25n)).toEqual(rational(2_880n));
    expect(linePayout(CLASSIC, 'first', 100n)).toEqual(rational(480n));
    // Off the quantum, so the product is not an integer: refused, never floored.
    expect(() => linePayout(CLASSIC, 'first', 1n)).toThrowError(
      expect.objectContaining({ code: 'CLAIM_REJECTED', path: '$.stake' }),
    );
  });
});

describe('permutation module: snapshot and restore', () => {
  async function settledBook(definition = CLASSIC, seedHex = seed(31), roundId = 'snap-round') {
    const transcript = makePermutationTranscript(seedHex, definition, roundId);
    const book = new PermutationBook(definition);
    await book.place({
      idempotencyKey: 'a',
      bet: { code: 'first', item: transcript.order[0] as number },
      stake: 100n,
    });
    await book.place({
      idempotencyKey: 'b',
      bet: {
        code: 'stack',
        before: transcript.order[0] as number,
        after: transcript.order[1] as number,
      },
      stake: 25n,
    });
    await book.place({
      idempotencyKey: 'c',
      bet: { code: 'last', item: transcript.order[0] as number },
      stake: 50n,
    });
    return { transcript, book, seedHex };
  }

  it('round-trips a staked, non-terminal book', async () => {
    const { book } = await settledBook();
    const snapshot = book.snapshot();
    expect(snapshot.settlement).toBeNull();
    expect(snapshot.stepRevision).toBe(0);
    const restored = PermutationBook.restore(CLASSIC, JSON.stringify(snapshot));
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.claims).toHaveLength(3);
    expect(restored.capBasisStake).toBe(175n);
    // The payout is recomputed on restore, never read: it is not in the wire form.
    expect(Object.keys(snapshot.claims[0] as object).sort()).toEqual([
      'code',
      'key',
      'parameters',
      'stake',
    ]);
    expect(restored.claims[0]?.payout).toEqual(rational(480n));
  });

  it('round-trips a settled book and re-derives its credit', async () => {
    const { transcript, book, seedHex } = await settledBook();
    await book.settle({ idempotencyKey: 's', revealedSeed: seedHex, transcript });
    const snapshot = book.snapshot();
    expect(snapshot.settlement?.order).toEqual([...transcript.order]);
    expect(snapshot.stepRevision).toBe(CLASSIC.items.length - 1);
    const restored = PermutationBook.restore(CLASSIC, JSON.stringify(snapshot));
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.terminal).toBe(true);
    expect(restored.liquidBalance).toBe(book.liquidBalance);
  });

  it('rejects a re-sealed mutation on its merits, not by the checksum', async () => {
    const { transcript, book, seedHex } = await settledBook();
    await book.settle({ idempotencyKey: 's', revealedSeed: seedHex, transcript });
    const snapshot = book.snapshot() as unknown as Record<string, unknown>;
    const claims = snapshot.claims as Record<string, unknown>[];
    const reseal = (value: Record<string, unknown>): string =>
      JSON.stringify({
        ...value,
        snapshotHash: snapshotHash({ ...value, snapshotHash: undefined }),
      });
    expect(() => PermutationBook.restore(CLASSIC, reseal(snapshot))).not.toThrow();

    const mutations: readonly Record<string, unknown>[] = [
      { liquidBalance: '999999' },
      { liquidBalance: '0' },
      { capBasisStake: '999999' },
      { terminal: false },
      { ledgerRevision: 3 },
      { stepRevision: 0 },
      { claims: [] },
      { receipts: [] },
      // Rewriting the settled order changes who won, and the credit no longer
      // re-derives from the ticket.
      { settlement: { ...(snapshot.settlement as object), order: [4, 3, 2, 1, 0] } },
      { settlement: null },
      // Rewriting a money-bearing claim field cannot survive its own receipt.
      { claims: claims.map((claim, index) => (index === 0 ? { ...claim, stake: '5000' } : claim)) },
      { claims: claims.map((claim, index) => (index === 0 ? { ...claim, code: 'last' } : claim)) },
      {
        claims: claims.map((claim, index) =>
          index === 0
            ? { ...claim, parameters: [(claim.parameters as number[])[0]! === 0 ? 1 : 0] }
            : claim,
        ),
      },
      { definition: { ...(snapshot.definition as object), fingerprint: '0'.repeat(64) } },
      { definition: { ...(snapshot.definition as object), version: '9.9.9' } },
    ];
    for (const mutation of mutations)
      expect(
        () => PermutationBook.restore(CLASSIC, reseal({ ...snapshot, ...mutation })),
        JSON.stringify(mutation).slice(0, 90),
      ).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/SNAPSHOT|MISMATCH/u) }),
      );

    // Unsealed corruption is still caught, by the checksum this time.
    expect(() =>
      PermutationBook.restore(CLASSIC, JSON.stringify({ ...snapshot, liquidBalance: '1' })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  /**
   * A settled snapshot has to be **re-derivable**, not merely self-consistent.
   *
   * Reconciling the credit alone is not enough: two different orders can pay a
   * ticket the same amount — trivially, any two under which every line loses —
   * so a snapshot naming the wrong order would restore cleanly under a
   * recomputed checksum and a host would then show a settled column that never
   * happened. The snapshot therefore carries the revealed seed (public the
   * moment the round closed) and restore re-expands it.
   */
  it('rejects a forged settled order even when the credit still reconciles', async () => {
    const seedHex = seed(41);
    const transcript = makePermutationTranscript(seedHex, CLASSIC, 'forgery');
    const book = new PermutationBook(CLASSIC);
    // A line that loses under the real order, chosen so the forged order below
    // makes it lose too: both settle at zero, so the credit tells them apart not
    // at all.
    const loser = transcript.order[3] as number;
    await book.place({ idempotencyKey: 'a', bet: { code: 'first', item: loser }, stake: 100n });
    const receipt = await book.settle({ idempotencyKey: 's', revealedSeed: seedHex, transcript });
    expect(receipt.credited).toBe(0n);

    const snapshot = book.snapshot() as unknown as Record<string, unknown>;
    const settlement = snapshot.settlement as Record<string, unknown>;
    const real = settlement.order as number[];
    // Swap two positions that are not position 0, so `first {loser}` still loses.
    const forged = [...real];
    [forged[1], forged[2]] = [forged[2] as number, forged[1] as number];
    expect(forged.join()).not.toBe(real.join());

    const reseal = (value: Record<string, unknown>): string =>
      JSON.stringify({
        ...value,
        snapshotHash: snapshotHash({ ...value, snapshotHash: undefined }),
      });
    for (const mutation of [
      { ...settlement, order: forged },
      { ...settlement, revealedSeed: seed(42) },
      { ...settlement, roundId: 'another-round' },
      { ...settlement, commitment: '0'.repeat(64) },
    ])
      expect(
        () => PermutationBook.restore(CLASSIC, reseal({ ...snapshot, settlement: mutation })),
        JSON.stringify(mutation).slice(0, 70),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));

    // The honest one still restores, and comes back carrying the same proof.
    const restored = PermutationBook.restore(CLASSIC, reseal(snapshot));
    expect(restored.settledOrder).toEqual([...transcript.order]);
  });

  it.each([
    ['not an object', '4'],
    ['unknown key', JSON.stringify({ schema: 'reveal-engine/permutation-book-v1', extra: 1 })],
    ['not JSON', '{'],
  ])('fails closed on a hostile snapshot: %s', (_label, input) => {
    const error = captureError(() => PermutationBook.restore(CLASSIC, input));
    expect(error).toBeInstanceOf(RevealEngineError);
    expect((error as RevealEngineError).code).toBe('INVALID_SNAPSHOT');
  });

  it('refuses a snapshot whose claims repeat one behavioural claim', async () => {
    const { book } = await settledBook();
    const snapshot = book.snapshot() as unknown as Record<string, unknown>;
    const claims = snapshot.claims as Record<string, unknown>[];
    const aliased = {
      ...snapshot,
      claims: [
        claims[0],
        { ...claims[1], code: 'slot', parameters: [(claims[0]!.parameters as number[])[0], 0] },
        claims[2],
      ],
    };
    expect(() =>
      PermutationBook.restore(
        CLASSIC,
        JSON.stringify({
          ...aliased,
          snapshotHash: snapshotHash({ ...aliased, snapshotHash: undefined }),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
  });

  /**
   * The conformance check re-derives a staked snapshot by hand because checks
   * are synchronous. This pins that re-derivation against a real round, so a
   * change to the book's shape fails here rather than quietly weakening the
   * tamper set into something restore would have rejected anyway.
   */
  it('builds the conformance snapshot exactly as a real staked round would', async () => {
    const seedHex = seed(2);
    const roundId = 'conformance-2';
    const order = derivePermutationOrder(seedHex, CLASSIC, roundId);
    const book = new PermutationBook(CLASSIC);
    await book.place({
      idempotencyKey: 'place-first',
      bet: { code: 'first', item: order[0] as number },
      stake: CLASSIC.minLineStake,
    });
    await book.place({
      idempotencyKey: 'place-stack',
      bet: { code: 'stack', before: order[0] as number, after: order[1] as number },
      stake: CLASSIC.minLineStake + CLASSIC.stakeQuantum,
    });
    expect(book.snapshot()).toEqual(stakedSnapshotFor(CLASSIC, seedHex, roundId));
  });
});

describe('permutation module: conformance', () => {
  it.each([aetherOrderClassicReference, aetherOrderSevenReference, triadReference])(
    'passes its own declared checks for $id',
    (definition) => {
      const report = assertModuleConformance(permutation, definition, 3);
      expect(report.ok).toBe(true);
      expect(report.moduleId).toBe('permutation');
      expect(report.checks).toEqual([
        'NOT_DEEP_FROZEN',
        'SHUFFLE_NOT_BIJECTIVE',
        'STEP_STRUCTURE_LEAKS_TRUTH',
        'PRICING_IDENTITY_BROKEN',
        'FAMILY_NOT_HOMOGENEOUS',
        'CLAIM_IDENTITY_NOT_BEHAVIOURAL',
        'TRUTH_IS_PERMUTATION',
        'TRANSCRIPT_ROUND_TRIP',
        'PRICE_NOT_NORMALISED',
        'SETTLEMENT_DISAGREES_WITH_PRICE',
        'SNAPSHOT_NOT_REVALIDATED',
      ]);
      // `checks` is what was declared; `ran` is what executed. Six checks are
      // definition-scoped and run once; five are round-scoped and run per seed.
      expect(report.ran).toEqual({
        NOT_DEEP_FROZEN: 1,
        SHUFFLE_NOT_BIJECTIVE: 1,
        STEP_STRUCTURE_LEAKS_TRUTH: 1,
        PRICING_IDENTITY_BROKEN: 1,
        FAMILY_NOT_HOMOGENEOUS: 1,
        CLAIM_IDENTITY_NOT_BEHAVIOURAL: 1,
        TRUTH_IS_PERMUTATION: 3,
        TRANSCRIPT_ROUND_TRIP: 3,
        PRICE_NOT_NORMALISED: 3,
        SETTLEMENT_DISAGREES_WITH_PRICE: 3,
        SNAPSHOT_NOT_REVALIDATED: 3,
      });
      const n = definition.items.length;
      const factorial = Array.from({ length: n }, (_unused, index) => index + 1).reduce(
        (product, value) => product * value,
        1,
      );
      // Both exhaustive sweeps really did cover the whole space.
      expect(report.counters.drawVectors).toBe(factorial);
      expect(report.counters.truthsSwept).toBe(factorial);
    },
  );

  it('reports a definition that violates the contract instead of throwing', () => {
    const report = checkModuleConformance(permutation, {} as never, 1);
    expect(report.ok).toBe(false);
    expect(report.definitionId).toBe('<invalid>');
  });

  it('ships every reference through the registry-driven runner', () => {
    const references = permutation.conformance.references.map((reference) => reference.id);
    expect(references).toEqual(['aether-order-classic', 'aether-order-seven', 'triad']);
    for (const reference of permutation.conformance.references)
      expect(checkModuleConformance(permutation, reference.definition, 1).ok).toBe(true);
  });
});

describe('permutation module: the aether-order adapter surface', () => {
  /**
   * `aether-order/docs/ENGINE.md` describes the adapter the game expects. The
   * five families this module ships are the ones it names as `full`, `slot`,
   * `first`, `last` and `stack`, and `aether-order/docs/MATH.md` §3.1 publishes
   * their counts. This is the compatibility statement, kept as executable code
   * so it cannot drift into a claim nobody checks.
   */
  it.each([
    ['CLASSIC', aetherOrderClassicReference, 120, { slot: 24, stack: 24 }],
    ['SEVEN', aetherOrderSevenReference, 5040, { slot: 720, stack: 720 }],
  ])('reproduces the published %s counts exactly', (_label, definition, total, counts) => {
    const orders = enumerateOrders(definition.items.length);
    expect(orders).toHaveLength(total);
    const winCount = (bet: PermutationBet): number =>
      orders.filter((order) => betWins(definition, bet, order)).length;
    expect(winCount({ code: 'full', order: orders[0]! })).toBe(1);
    expect(winCount({ code: 'slot', item: 0, position: 2 })).toBe(counts.slot);
    expect(winCount({ code: 'first', item: 0 })).toBe(counts.slot);
    expect(winCount({ code: 'last', item: 0 })).toBe(counts.slot);
    expect(winCount({ code: 'stack', before: 0, after: 1 })).toBe(counts.stack);
  });

  it('publishes the alias groups the game client has to merge', () => {
    const n = CLASSIC.items.length;
    const groups = new Map<string, string[]>();
    for (const code of ['slot', 'first', 'last', 'stack'] as const)
      for (const bet of enumerateInstances(CLASSIC, code)) {
        const signature = claimSignature(CLASSIC, bet);
        groups.set(signature, [...(groups.get(signature) ?? []), code]);
      }
    const aliased = [...groups.values()].filter((codes) => codes.length > 1);
    // Exactly `first === slot@0` and `last === slot@n-1`, once per item.
    expect(aliased).toHaveLength(2 * n);
    expect(aliased.every((codes) => codes.length === 2)).toBe(true);
  });

  it('keeps the module version inside the fingerprint, so behaviour cannot move silently', () => {
    // The bet catalogue lives in the module, not in the adapter, so there is no
    // adapter predicate that could be reversed behind a declarative digest — but
    // a module version bump *is* a behaviour change, and it moves every
    // fingerprint by construction.
    const fields = canonicalDefinitionFields(CLASSIC);
    expect(fields[0]).toBe('permutation');
    expect(fields[1]).toBe(permutation.version);
    expect(permutationFingerprint(CLASSIC)).toBe(permutation.definitions.fingerprint(CLASSIC));
  });
});
