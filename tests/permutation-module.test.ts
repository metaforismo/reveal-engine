import { describe, expect, it } from 'vitest';
import { ENGINE_LIMITS } from '../src/api/limits.js';
import { RevealEngineError } from '../src/api/errors.js';
import { sealCommitment } from '../src/core/commitment.js';
import {
  assertModuleConformance,
  checkModuleConformance,
} from '../src/conformance/module-conformance.js';
import { commandFingerprint } from '../src/core/ledger.js';
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
  MAX_ITEMS,
  MIN_ITEMS,
  PERMUTATION_BET_CODES,
  permutation,
  permutationFingerprint,
  permutationCommitmentBody,
  permutationTranscriptToWire,
  PermutationBook,
  price,
  representativeInstance,
  serializePermutationTranscript,
  triadReference,
  verifyPermutationTranscript,
  type PermutationBet,
  type PermutationDefinition,
  type PermutationRoundBinding,
  type PermutationTranscript,
} from '../src/modules/permutation/index.js';
// Deep import on purpose: `stakedSnapshotFor` is conformance scaffolding and is
// deliberately absent from the module's public surface, exactly as
// `progressive-market/checks.ts` keeps its own.
import { stakedSnapshotFor } from '../src/modules/permutation/checks.js';
import { seed } from './helpers.js';

const CLASSIC = aetherOrderClassicReference;
const SEVEN = aetherOrderSevenReference;

/** A definition skeleton at any supported size, priced from the §5.1 closed forms. */
const TRIAD_SHAPE = {
  version: '1.0.0',
  rtp: rational(24n, 25n),
  maxWinMultiple: 1_000_000n,
  stakeQuantum: 25n,
  minLineStake: 25n,
  maxLineStake: 2_500n,
  maxTicketStake: 10_000n,
  maxOpenBets: 6,
} as const;

function paytableForSize(size: number): PermutationDefinition['paytable'] {
  let factorial = 1n;
  for (let step = 2n; step <= BigInt(size); step += 1n) factorial *= step;
  const flat = rational(24n * BigInt(size), 25n);
  return { full: rational(24n * factorial, 25n), slot: flat, first: flat, last: flat, stack: flat };
}

/**
 * The round an operator publishes before betting opens, read off the proof.
 *
 * Real deployments publish the commitment first and settle against it later;
 * here the transcript is derived up front, which is the same act in the other
 * order — the whole round is a pure function of `(seed, definition, roundId)`,
 * so the commitment exists the moment the operator picks a seed.
 */
const bindingOf = (transcript: PermutationTranscript): PermutationRoundBinding =>
  Object.freeze({ roundId: transcript.roundId, commitment: transcript.commitment });

function captureError(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

function restoreWithoutBinding(definition: PermutationDefinition, snapshot: string | object) {
  return Reflect.apply(PermutationBook.restore, undefined, [
    definition,
    snapshot,
  ]) as PermutationBook;
}

describe('permutation module: contract surface', () => {
  it('registers alongside the progressive market without displacing it', () => {
    expect(listModules().map((module) => module.id)).toEqual([
      'progressive-market',
      'sequential-cards',
      'staged-survival',
      'permutation',
    ]);
    expect(findModule('permutation')).toBe(permutation);
    expect(requireModule('permutation').moduleApiVersion).toBe(MODULE_API_VERSION);
    expect(Object.isFrozen(permutation)).toBe(true);
  });

  /**
   * `definePermutationGame` prices each family from `representativeInstance`
   * rather than from `enumerateInstances(...)[0]`, which cost `O(n!)` for `full`
   * — 17.3 ms at `n = 8` on a public export a host may call per request.
   *
   * The cheap path is sound only while it returns exactly what the catalogue's
   * head returns, so that equality is asserted here for every code at every
   * supported `n` instead of being asserted in a comment. A future edit to
   * either side that breaks the correspondence fails here rather than silently
   * pricing a family off an instance that is not in it.
   */
  it('prices from a representative instance identical to the catalogue head', () => {
    for (let size = MIN_ITEMS; size <= MAX_ITEMS; size += 1) {
      const definition = definePermutationGame({
        ...TRIAD_SHAPE,
        id: `representative-n${size}`,
        items: Array.from({ length: size }, (_unused, index) => `item-${index}`),
        paytable: paytableForSize(size),
      });
      for (const code of PERMUTATION_BET_CODES)
        expect(representativeInstance(definition, code)).toStrictEqual(
          enumerateInstances(definition, code)[0],
        );
    }
  });

  it('declares the shape the lifecycle contract predicted for it', () => {
    expect(permutation.truth.kind).toBe('permutation');
    expect(permutation.steps.choiceTiming).toBe('none');
    expect(permutation.steps.beliefSpace).toBe('marginal');
    expect(permutation.book.positions).toBe('multi');
    expect(permutation.book.settlement).toBe('paytable');
    expect(permutation.book.actions).toEqual(['place', 'settle']);
    expect(permutation.transcript.schema).toBe('reveal-engine/permutation-transcript-v1');
    expect(permutation.book.snapshotSchema).toBe('reveal-engine/permutation-book-v2');
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

  /**
   * The refusal below is **core's**, and naming it as core's is the point.
   *
   * `defineLifecycleModule()` wraps every choice-taking hook as `hook(...,
   * guard(choices))`, and for `choiceTiming: 'none'` that guard raises
   * `INVALID_CHOICE` before the module's closure runs at all. A duplicate check
   * inside the module would therefore never execute: dead code that reads like
   * a control, is covered by no test that could tell the difference, and would
   * go on passing if core's guard were deleted tomorrow.
   *
   * What makes leaving it out safe is not the wrapper but the **arity**.
   * `permutationCommitmentBody` has no choice parameter, so there is no log for
   * the sealed bytes to bind and no way for one to reach them — which is a
   * stronger statement than a check, and the assertions below are what say it.
   */
  it('leaves the choice-log refusal to core, and has no parameter one could reach', () => {
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

    // The module's own proof-bearing function takes four arguments, not five.
    expect(permutationCommitmentBody).toHaveLength(4);
    expect(
      Buffer.compare(
        permutationCommitmentBody(CLASSIC, round, truth, steps),
        permutation.transcript.commitmentBody(CLASSIC, round, truth, steps, []),
      ),
    ).toBe(0);
    // So a caller that smuggles a log past the declaration cannot change the
    // bytes: there is nothing on the other side that reads it.
    expect(
      Buffer.compare(
        permutationCommitmentBody(CLASSIC, round, truth, steps),
        (permutationCommitmentBody as unknown as (...args: readonly unknown[]) => Buffer)(
          CLASSIC,
          round,
          truth,
          steps,
          ['x'],
        ),
      ),
    ).toBe(0);
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
    const book = new PermutationBook(definition, bindingOf(transcript));
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
    const book = new PermutationBook(
      tight,
      bindingOf(makePermutationTranscript(seed(22), tight, 'budget-round')),
    );
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
    // A rewritten commitment never reaches the verifier: it is not the
    // commitment this book was bound to, which is the earlier and more
    // fundamental refusal.
    await expect(
      book.settle({
        idempotencyKey: 's2',
        revealedSeed: seedHex,
        transcript: { ...permutationTranscriptToWire(transcript), commitment: '0'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'COMMITMENT_MISMATCH', path: '$.transcript.commitment' });
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
    const book = new PermutationBook(capped, bindingOf(transcript));
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
    const book = new PermutationBook(tight, bindingOf(transcript));
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
    const book = new PermutationBook(definition, bindingOf(transcript));
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
    const { transcript, book } = await settledBook();
    const snapshot = book.snapshot();
    expect(snapshot.settlement).toBeNull();
    expect(snapshot.stepRevision).toBe(0);
    const restored = PermutationBook.restore(
      CLASSIC,
      JSON.stringify(snapshot),
      bindingOf(transcript),
    );
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
    const restored = PermutationBook.restore(
      CLASSIC,
      JSON.stringify(snapshot),
      bindingOf(transcript),
    );
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
    const published = bindingOf(transcript);
    expect(() => PermutationBook.restore(CLASSIC, reseal(snapshot), published)).not.toThrow();

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
        () => PermutationBook.restore(CLASSIC, reseal({ ...snapshot, ...mutation }), published),
        JSON.stringify(mutation).slice(0, 90),
      ).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/SNAPSHOT|MISMATCH/u) }),
      );

    // Unsealed corruption is still caught, by the checksum this time.
    expect(() =>
      PermutationBook.restore(
        CLASSIC,
        JSON.stringify({ ...snapshot, liquidBalance: '1' }),
        published,
      ),
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
    const book = new PermutationBook(CLASSIC, bindingOf(transcript));
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
        () =>
          PermutationBook.restore(
            CLASSIC,
            reseal({ ...snapshot, settlement: mutation }),
            bindingOf(transcript),
          ),
        JSON.stringify(mutation).slice(0, 70),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));

    // The honest one still restores, and comes back carrying the same proof.
    const restored = PermutationBook.restore(CLASSIC, reseal(snapshot), bindingOf(transcript));
    expect(restored.settledOrder).toEqual([...transcript.order]);
  });

  it.each([
    ['not an object', '4'],
    ['unknown key', JSON.stringify({ schema: 'reveal-engine/permutation-book-v2', extra: 1 })],
    ['not JSON', '{'],
  ])('fails closed on a hostile snapshot: %s', (_label, input) => {
    const error = captureError(() => PermutationBook.restore(CLASSIC, input, null));
    expect(error).toBeInstanceOf(RevealEngineError);
    expect((error as RevealEngineError).code).toBe('INVALID_SNAPSHOT');
  });

  it('refuses a snapshot whose claims repeat one behavioural claim', async () => {
    const { transcript, book } = await settledBook();
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
        bindingOf(transcript),
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
    const book = new PermutationBook(
      CLASSIC,
      bindingOf(makePermutationTranscript(seedHex, CLASSIC, roundId)),
    );
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
        'DERIVATION_OFF_SCHEDULE',
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
      // definition-scoped and run once; six are round-scoped and run per seed.
      expect(report.ran).toEqual({
        NOT_DEEP_FROZEN: 1,
        SHUFFLE_NOT_BIJECTIVE: 1,
        DERIVATION_OFF_SCHEDULE: 3,
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
      // One staked snapshot per seed and a fixed tamper set over it. Pinned so
      // that dropping a case — most of all the missing-published-round one or
      // the consistent whole-round rewrite — fails here rather than quietly
      // shrinking what conformance proves.
      expect(report.counters.snapshots).toBe(3);
      expect(report.counters.snapshotTampers).toBe(3 * 16);
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

/**
 * The round a book is bound to, and what happens to a proof for any other one.
 *
 * Every transcript this module builds is internally valid and verifies against
 * its own seed, so "the transcript verifies" answers a question nobody asked.
 * The question a settlement turns on is *which round* the ticket was placed
 * into, and the only thing that can answer it is a commitment published before
 * the ticket existed.
 */
describe('permutation module: the round a book is bound to', () => {
  const seedHex = seed(51);
  const roundIdAt = (index: number): string => `round-${String(index).padStart(4, '0')}`;

  /** Places a three-line ticket into the transcript's round and returns the book. */
  async function ticketFor(transcript: PermutationTranscript): Promise<PermutationBook> {
    const book = new PermutationBook(CLASSIC, bindingOf(transcript));
    const first = transcript.order[0] as number;
    const second = transcript.order[1] as number;
    await book.place({ idempotencyKey: 'a', bet: { code: 'first', item: first }, stake: 5_000n });
    await book.place({
      idempotencyKey: 'b',
      bet: { code: 'slot', item: second, position: 1 },
      stake: 5_000n,
    });
    await book.place({
      idempotencyKey: 'c',
      bet: { code: 'stack', before: first, after: second },
      stake: 5_000n,
    });
    return book;
  }

  /**
   * The attack, run end to end: place, then shop for a better round.
   *
   * An operator holding a placed ticket derives a transcript for every round id
   * it likes — the seed is its own — and picks whichever settles the ticket at
   * zero. Nothing about that transcript is forged: it verifies, its commitment
   * opens to the revealed seed, and a snapshot of that round would reconcile.
   * The only thing wrong with it is that it is not the round the player bet
   * into, and that is exactly what the binding knows.
   */
  it('refuses a settlement for a round it was not bound to, however honest that proof is', async () => {
    const honest = makePermutationTranscript(seedHex, CLASSIC, roundIdAt(1));
    const book = await ticketFor(honest);
    expect(book.stakedTotal).toBe(15_000n);
    const owed = book.grossFor(honest.order);
    expect(owed.numerator).toBeGreaterThan(0n);

    // Shop, exactly as an operator who had already seen the ticket would.
    let shopped: PermutationTranscript | undefined;
    for (let index = 0; index < 64 && shopped === undefined; index += 1) {
      const candidate = makePermutationTranscript(seedHex, CLASSIC, roundIdAt(index));
      if (candidate.roundId !== honest.roundId && book.grossFor(candidate.order).numerator === 0n)
        shopped = candidate;
    }
    expect(shopped, 'a losing round exists to shop for').toBeDefined();
    // It is a genuine proof — that is the whole point of the example.
    expect(verifyPermutationTranscript(seedHex, CLASSIC, shopped as PermutationTranscript).ok).toBe(
      true,
    );

    await expect(
      book.settle({
        idempotencyKey: 's',
        revealedSeed: seedHex,
        transcript: shopped as PermutationTranscript,
      }),
    ).rejects.toMatchObject({ code: 'COMMITMENT_MISMATCH', path: '$.transcript.roundId' });
    expect(book.terminal).toBe(false);
    expect(book.liquidBalance).toBe(0n);

    // The round it was bound to settles, and pays what it owed.
    const receipt = await book.settle({
      idempotencyKey: 's',
      revealedSeed: seedHex,
      transcript: honest,
    });
    expect(receipt.capped).toBe(false);
    expect(rational(receipt.credited)).toEqual(owed);
  });

  /**
   * The same refusal with the round id held fixed, so it is the commitment doing
   * the work rather than a string comparison on a label.
   */
  it('refuses a proof that reuses the bound round id under a different commitment', async () => {
    const honest = makePermutationTranscript(seedHex, CLASSIC, roundIdAt(1));
    const other = makePermutationTranscript(seed(52), CLASSIC, roundIdAt(1));
    expect(other.commitment).not.toBe(honest.commitment);
    const book = await ticketFor(honest);
    await expect(
      book.settle({ idempotencyKey: 's', revealedSeed: seed(52), transcript: other }),
    ).rejects.toMatchObject({ code: 'COMMITMENT_MISMATCH', path: '$.transcript.commitment' });
    expect(book.terminal).toBe(false);
  });

  it('will not take a bet, or settle, before the round is published', async () => {
    const book = new PermutationBook(CLASSIC);
    expect(book.binding).toBeUndefined();
    await expect(
      book.place({ idempotencyKey: 'a', bet: { code: 'first', item: 0 }, stake: 25n }),
    ).rejects.toMatchObject({ code: 'CLAIM_REJECTED', path: '$.binding' });
    const transcript = makePermutationTranscript(seedHex, CLASSIC, roundIdAt(3));
    await expect(
      book.settle({ idempotencyKey: 's', revealedSeed: seedHex, transcript }),
    ).rejects.toMatchObject({ code: 'CLAIM_REJECTED', path: '$.binding' });
    expect(book.claims).toHaveLength(0);
    expect(book.capBasisStake).toBeUndefined();
    expect(book.terminal).toBe(false);
  });

  it('binds once, before the first bet, and never again', async () => {
    const transcript = makePermutationTranscript(seedHex, CLASSIC, roundIdAt(4));
    const book = new PermutationBook(CLASSIC);
    book.bind(bindingOf(transcript));
    expect(book.binding).toEqual(bindingOf(transcript));
    // Re-binding is refused whether or not the value offered is the same one.
    expect(() => book.bind(bindingOf(transcript))).toThrowError(
      expect.objectContaining({ code: 'CLAIM_REJECTED', path: '$.binding' }),
    );
    await book.place({
      idempotencyKey: 'a',
      bet: { code: 'first', item: transcript.order[0] as number },
      stake: 25n,
    });

    // And a book that already holds a claim cannot be pointed at a round chosen
    // afterwards — the ordering the whole control rests on. Reaching that state
    // needs a bound book, so this binds, places, and then tries to re-bind.
    const staked = new PermutationBook(CLASSIC, bindingOf(transcript));
    await staked.place({
      idempotencyKey: 'a',
      bet: { code: 'first', item: transcript.order[0] as number },
      stake: 25n,
    });
    const later = makePermutationTranscript(seedHex, CLASSIC, roundIdAt(5));
    expect(() => staked.bind(bindingOf(later))).toThrowError(
      expect.objectContaining({ code: 'CLAIM_REJECTED', path: '$.binding' }),
    );
    expect(staked.binding).toEqual(bindingOf(transcript));
  });

  it.each([
    ['not an object', null],
    ['a string', 'round-0001'],
    ['an array', []],
    ['missing the commitment', { roundId: 'r' }],
    ['missing the round id', { commitment: '0'.repeat(64) }],
    ['carrying an extra field', { roundId: 'r', commitment: '0'.repeat(64), nonce: 1 }],
    ['an empty round id', { roundId: '', commitment: '0'.repeat(64) }],
    ['a control character in the round id', { roundId: 'a\u0000b', commitment: '0'.repeat(64) }],
    ['a short commitment', { roundId: 'r', commitment: '0'.repeat(63) }],
    ['an upper-case commitment', { roundId: 'r', commitment: 'A'.repeat(64) }],
    ['a non-hex commitment', { roundId: 'r', commitment: 'z'.repeat(64) }],
  ])('refuses a malformed binding: %s', (_label, binding) => {
    for (const operation of [
      () => new PermutationBook(CLASSIC, binding as never),
      () => new PermutationBook(CLASSIC).bind(binding as never),
    ]) {
      const error = captureError(operation);
      expect(error).toBeInstanceOf(RevealEngineError);
      expect(error).not.toBeInstanceOf(TypeError);
      expect((error as RevealEngineError).code).toBe('CLAIM_REJECTED');
    }
  });

  /**
   * The binding and the settlement have to agree with each other.
   *
   * This is the *internal* half of the round question, and it is worth having on
   * its own: a terminal snapshot names a round twice, once in the binding and
   * once in the settlement that re-derives from the revealed seed, and the two
   * disagreeing is a snapshot describing a state the book cannot reach. The
   * *external* half — which round the caller actually published — is a different
   * control and lives in its own describe below.
   */
  it('reconciles the binding against the settlement it re-derives', async () => {
    const honest = makePermutationTranscript(seedHex, CLASSIC, roundIdAt(1));
    const book = await ticketFor(honest);
    await book.settle({ idempotencyKey: 's', revealedSeed: seedHex, transcript: honest });
    const snapshot = book.snapshot() as unknown as Record<string, unknown>;
    expect(snapshot.binding).toEqual(bindingOf(honest));

    const reseal = (value: Record<string, unknown>): string =>
      JSON.stringify({
        ...value,
        snapshotHash: snapshotHash({ ...value, snapshotHash: undefined }),
      });
    const other = makePermutationTranscript(seedHex, CLASSIC, roundIdAt(2));

    // Half a rewrite: the binding names a round the settlement does not. Each is
    // restored against the round its own binding claims, so the refusal is the
    // internal contradiction and not the published-round check.
    for (const mutation of [
      { ...snapshot, binding: bindingOf(other) },
      { ...snapshot, binding: { ...bindingOf(honest), commitment: '0'.repeat(64) } },
    ])
      expect(
        () =>
          PermutationBook.restore(
            CLASSIC,
            reseal(mutation),
            mutation.binding as PermutationRoundBinding,
          ),
        JSON.stringify(mutation.binding),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));

    // Dropping the binding entirely does not turn a settled book into a book
    // that has done nothing.
    expect(() =>
      PermutationBook.restore(CLASSIC, reseal({ ...snapshot, binding: null }), null),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT', path: '$.binding' }));

    // The honest snapshot restores against the round it was played in, and only
    // against that one.
    expect(PermutationBook.restore(CLASSIC, reseal(snapshot), bindingOf(honest)).terminal).toBe(
      true,
    );
    expect(() => PermutationBook.restore(CLASSIC, reseal(snapshot), bindingOf(other))).toThrowError(
      expect.objectContaining({ code: 'COMMITMENT_MISMATCH', path: '$.expectedBinding' }),
    );
  });
});

/**
 * The declared module surface, exercised through the declaration itself.
 *
 * `permutation.book.create`, `.restore` and `.snapshot` are how a host that
 * resolved the module by id reaches the book, and a factory wired to the wrong
 * class satisfies the type perfectly. Reading the declaration's *properties*
 * proves nothing about that; calling it does.
 */
describe('permutation module: the book reached through the declaration', () => {
  const seedHex = seed(61);
  const roundId = 'declared-surface';

  it('creates, binds, settles, snapshots and restores through the declared factories', async () => {
    const module = requireModule('permutation');
    const transcript = makePermutationTranscript(seedHex, CLASSIC, roundId);
    const book = module.book.create(CLASSIC) as PermutationBook;
    expect(book).toBeInstanceOf(PermutationBook);
    // The contract's factory has no round to hand over, so what it returns is
    // unbound — and therefore cannot take money.
    expect(book.binding).toBeUndefined();
    await expect(
      book.place({ idempotencyKey: 'a', bet: { code: 'first', item: 0 }, stake: 25n }),
    ).rejects.toMatchObject({ code: 'CLAIM_REJECTED', path: '$.binding' });

    book.bind(bindingOf(transcript));
    await book.place({
      idempotencyKey: 'a',
      bet: { code: 'first', item: transcript.order[0] as number },
      stake: 100n,
    });
    const receipt = await book.settle({
      idempotencyKey: 's',
      revealedSeed: seedHex,
      transcript,
    });
    expect(receipt.credited).toBe(480n);

    const snapshot = module.book.snapshot(book);
    expect(snapshot).toEqual(book.snapshot());
    expect((snapshot as { schema: string }).schema).toBe(module.book.snapshotSchema);

    const restored = module.book.restore(
      CLASSIC,
      snapshot,
      bindingOf(transcript),
    ) as PermutationBook;
    expect(restored).toBeInstanceOf(PermutationBook);
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.liquidBalance).toBe(480n);
    expect(restored.binding).toEqual(bindingOf(transcript));

    // And it re-validates rather than returning a fresh book.
    const tampered = { ...(snapshot as Record<string, unknown>), liquidBalance: '999999' };
    expect(() =>
      PermutationBook.restore(
        CLASSIC,
        JSON.stringify({
          ...tampered,
          snapshotHash: snapshotHash({ ...tampered, snapshotHash: undefined }),
        }),
        bindingOf(transcript),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));

    // What the contract path *can* restore is the state where no money is at
    // risk, which is the same narrowness `create` has and equally deliberate.
    const fresh = module.book.restore(CLASSIC, new PermutationBook(CLASSIC).snapshot(), null);
    expect((fresh as PermutationBook).binding).toBeUndefined();
  });

  it('declares a claim budget the book it builds actually enforces', async () => {
    const module = requireModule('permutation');
    const tight = definePermutationGame({ ...CLASSIC, id: 'declared-budget', maxOpenBets: 2 });
    const transcript = makePermutationTranscript(seedHex, tight, roundId);
    const book = module.book.create(tight) as PermutationBook;
    book.bind(bindingOf(transcript));
    await book.place({ idempotencyKey: 'a', bet: { code: 'first', item: 0 }, stake: 25n });
    await book.place({ idempotencyKey: 'b', bet: { code: 'first', item: 1 }, stake: 25n });
    await expect(
      book.place({ idempotencyKey: 'c', bet: { code: 'first', item: 2 }, stake: 25n }),
    ).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
    expect(tight.maxOpenBets).toBeLessThanOrEqual(module.book.maxOpenClaims);
  });
});

/**
 * Hostile arguments reaching the pure counting exports.
 *
 * `validation.ts` sets the standard these hold to: "a hostile argument reaching
 * a pure counting function is a `RevealEngineError` rather than a `TypeError`
 * from three frames down". A function that returns `undefined` instead fails it
 * more quietly and further from the cause.
 */
describe('permutation module: counting exports refuse what they cannot count', () => {
  it.each([
    ['below the floor', 2],
    ['one above the ceiling', MAX_ITEMS + 1],
    ['far above the ceiling', 13],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['not a number', Number.NaN],
    ['unsafe', Number.MAX_SAFE_INTEGER + 2],
  ])('bounds enumerateOrders at the draw sizes it supports: %s', (_label, n) => {
    const started = Date.now();
    const error = captureError(() => enumerateOrders(n));
    expect(error).toBeInstanceOf(RevealEngineError);
    expect((error as RevealEngineError).code).toBe('INVALID_CONTEXT');
    // The refusal is the point: an unbounded `n` is an unbounded allocation, so
    // it has to be immediate rather than eventual.
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('still enumerates every supported draw size exactly', () => {
    const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));
    for (let n = MIN_ITEMS; n <= MAX_ITEMS; n += 1)
      expect(enumerateOrders(n)).toHaveLength(factorial(n));
  });

  it.each(['bogus', '__proto__', 'toString', 'constructor', '', 'FULL'])(
    'refuses an unknown bet code rather than returning undefined: %j',
    (code) => {
      for (const operation of [
        () => enumerateInstances(CLASSIC, code as never),
        () => betParameters({ code } as never),
        () => betFromParameters(CLASSIC, code, [0]),
        () => assertBet({ code, item: 0 }, CLASSIC),
      ]) {
        const error = captureError(operation);
        expect(error).toBeInstanceOf(RevealEngineError);
        expect(error).not.toBeInstanceOf(TypeError);
        expect((error as RevealEngineError).code).toBe('CLAIM_REJECTED');
      }
    },
  );

  it.each([
    ['a field the code does not own', { code: 'first', item: 0, position: 9 }],
    ['a slot parameter on a last bet', { code: 'last', item: 0, position: 0 }],
    ['a stack field on a slot bet', { code: 'slot', item: 0, position: 0, after: 1 }],
    ['an order on a first bet', { code: 'first', item: 0, order: [0, 1, 2, 3, 4] }],
    ['a missing field', { code: 'slot', item: 0 }],
    ['no fields at all', { code: 'stack' }],
  ])('refuses a bet whose fields do not match its code: %s', (_label, bet) => {
    const error = captureError(() => assertBet(bet, CLASSIC));
    expect(error).toBeInstanceOf(RevealEngineError);
    expect((error as RevealEngineError).code).toBe('CLAIM_REJECTED');
  });

  /**
   * The reason the loose reading is a money problem and not only a tidiness one:
   * `first{0}` and `slot{0,9}` are not the same claim, and `position: 9` is not
   * even a legal position. Accepting the first spelling silently would sell a
   * player a claim they did not ask for.
   */
  it('does not silently reinterpret a typo as a cheaper claim', async () => {
    const transcript = makePermutationTranscript(seed(62), CLASSIC, 'typo-round');
    const book = new PermutationBook(CLASSIC, bindingOf(transcript));
    await expect(
      book.place({
        idempotencyKey: 'a',
        bet: { code: 'first', item: 0, position: 9 } as never,
        stake: 25n,
      }),
    ).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
    expect(book.claims).toHaveLength(0);
    expect(book.stakedTotal).toBe(0n);
  });
});

/**
 * Every field of every receipt in a terminal snapshot, rewritten and re-sealed.
 *
 * The receipt log is the part of a snapshot that says *what the player did*, and
 * the contract requires it to be re-derived rather than read. "Re-derived"
 * cannot mean "mostly": a field nobody checks is a field a restored audit record
 * can disagree with the operator's command log about, even when the money still
 * reconciles. Two used to be unchecked — a `place` receipt's `capped` flag and
 * the `settle` receipt's idempotency key — and both are the kind that fail
 * quietly, because neither moves a balance.
 *
 * So this sweeps the cross product rather than a chosen list: for every receipt
 * and every wire field, one plausible rewrite, re-sealed so the checksum is not
 * what refuses it. The count is asserted too, so a field added to the receipt
 * wire form without a case here fails the test rather than slipping past it.
 */
describe('permutation module: no receipt field restores unchallenged', () => {
  const seedHex = seed(71);
  const roundId = 'receipt-sweep';

  /** One plausible rewrite per field, per action. */
  const rewrites: Readonly<Record<string, (current: unknown, action: string) => unknown>> =
    Object.freeze({
      schema: () => 'reveal-engine/receipt-v9',
      idempotencyKey: (current) => `${String(current)}-rewritten`,
      commandFingerprint: () => 'f'.repeat(64),
      action: (_current, action) => (action === 'place' ? 'settle' : 'place'),
      ledgerRevision: (current) => (current as number) + 1,
      frameRevision: (current) => (current as number) + 1,
      debited: (current) => (current === '0' ? '25' : '0'),
      credited: (current) => (current === '0' ? '25' : '0'),
      balanceDelta: (current) => `${-Number(current as string)}`,
      capped: (current) => !(current as boolean),
    });

  it('refuses a rewrite of any single receipt field, on the merits', async () => {
    const transcript = makePermutationTranscript(seedHex, CLASSIC, roundId);
    const book = new PermutationBook(CLASSIC, {
      roundId: transcript.roundId,
      commitment: transcript.commitment,
    });
    await book.place({
      idempotencyKey: 'a',
      bet: { code: 'first', item: transcript.order[0] as number },
      stake: 100n,
    });
    await book.place({
      idempotencyKey: 'b',
      bet: { code: 'last', item: transcript.order[0] as number },
      stake: 25n,
    });
    const settleReceipt = await book.settle({
      idempotencyKey: 'settle-key',
      revealedSeed: seedHex,
      transcript,
    });
    expect(settleReceipt.credited).toBeGreaterThan(0n);

    const snapshot = book.snapshot() as unknown as Record<string, unknown>;
    const entries = snapshot.receipts as {
      fingerprint: string;
      receipt: Record<string, unknown>;
    }[];
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.receipt.action)).toEqual(['place', 'place', 'settle']);
    // The settle receipt names the key the settlement records, and that is now
    // the thing restore checks rather than assumes.
    expect((snapshot.settlement as { idempotencyKey: string }).idempotencyKey).toBe('settle-key');
    expect(entries[2]?.receipt.idempotencyKey).toBe('settle-key');

    const reseal = (value: Record<string, unknown>): string =>
      JSON.stringify({
        ...value,
        snapshotHash: snapshotHash({ ...value, snapshotHash: undefined }),
      });
    const published = bindingOf(transcript);
    expect(() => PermutationBook.restore(CLASSIC, reseal(snapshot), published)).not.toThrow();

    const fields = Object.keys(entries[0]!.receipt);
    // Every wire field has a rewrite; a new one added upstream fails here.
    expect(fields.sort()).toEqual(Object.keys(rewrites).sort());

    let swept = 0;
    for (const [index, entry] of entries.entries())
      for (const field of fields) {
        const action = entry.receipt.action as string;
        const mutated = {
          ...snapshot,
          receipts: entries.map((original, position) =>
            position === index
              ? {
                  ...original,
                  receipt: {
                    ...original.receipt,
                    [field]: rewrites[field]!(original.receipt[field], action),
                  },
                }
              : original,
          ),
        };
        const label = `receipt[${index}].${field}`;
        expect(
          () => PermutationBook.restore(CLASSIC, reseal(mutated), published),
          label,
        ).toThrowError(RevealEngineError);
        swept += 1;
      }
    expect(swept).toBe(entries.length * fields.length);
  });

  /**
   * The two the sweep was added for, called out by name.
   *
   * A `place` receipt's `capped` flag and the `settle` receipt's key are the
   * fields that move no balance, so a restore that missed them would still
   * reconcile every number and still be wrong about what happened.
   */
  it('names the two fields that move no money and are checked anyway', async () => {
    const transcript = makePermutationTranscript(seedHex, CLASSIC, roundId);
    const book = new PermutationBook(CLASSIC, {
      roundId: transcript.roundId,
      commitment: transcript.commitment,
    });
    await book.place({
      idempotencyKey: 'a',
      bet: { code: 'first', item: transcript.order[0] as number },
      stake: 100n,
    });
    await book.settle({ idempotencyKey: 'settle-key', revealedSeed: seedHex, transcript });
    const snapshot = book.snapshot() as unknown as Record<string, unknown>;
    const entries = snapshot.receipts as {
      fingerprint: string;
      receipt: Record<string, unknown>;
    }[];
    const reseal = (value: Record<string, unknown>): string =>
      JSON.stringify({
        ...value,
        snapshotHash: snapshotHash({ ...value, snapshotHash: undefined }),
      });

    const withReceipt = (
      index: number,
      patch: Record<string, unknown>,
    ): Record<string, unknown> => ({
      ...snapshot,
      receipts: entries.map((entry, position) =>
        position === index ? { ...entry, receipt: { ...entry.receipt, ...patch } } : entry,
      ),
    });

    // A stake that claims to have met a ceiling. It did not; `place` mints
    // `capped: false` unconditionally, because a debit cannot meet a credit cap.
    const published = bindingOf(transcript);
    expect(entries[0]?.receipt.capped).toBe(false);
    expect(() =>
      PermutationBook.restore(CLASSIC, reseal(withReceipt(0, { capped: true })), published),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));

    // A settle receipt filed under a key the settlement does not name. The
    // balances all still reconcile — which is exactly why it needed a check.
    expect(() =>
      PermutationBook.restore(
        CLASSIC,
        reseal(withReceipt(1, { idempotencyKey: 'not-the-key' })),
        published,
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_SNAPSHOT', path: '$.settlement.idempotencyKey' }),
    );

    // Rewriting both halves consistently is refused too: the settlement's key is
    // itself bounded, and the pair has to agree.
    const bothRewritten = {
      ...withReceipt(1, { idempotencyKey: 'moved' }),
      settlement: { ...(snapshot.settlement as object), idempotencyKey: 'moved' },
    };
    const restored = PermutationBook.restore(CLASSIC, reseal(bothRewritten), published);
    // It restores — the pair is consistent — and the round is still terminal, so
    // the rewrite bought nothing: no second settle is possible either way.
    expect(restored.terminal).toBe(true);
    expect(restored.liquidBalance).toBe(book.liquidBalance);
  });
});

/**
 * Which round a restored snapshot plays, and who is entitled to say so.
 *
 * The attack this guards is short: an operator takes a ticket in round A,
 * rewrites the reconnect snapshot onto round B, restores, and settles against B.
 * Every balance still reconciles, because a rewrite that moves no money moves no
 * money — the ticket simply loses.
 *
 * There are two rewrites and they are not equally hard.
 *
 * A **partial** rewrite — the binding moved and nothing else — contradicts the
 * receipt log, because a `place` command's identity includes the round: the same
 * bet at the same stake is a different command in a different draw. That is
 * caught below, and it is the whole of what the fingerprint buys.
 *
 * A **consistent** rewrite is not caught, and cannot be. `commandFingerprint` is
 * an unkeyed SHA-256 over public fields and `makePermutationTranscript` is an
 * exported function, so whoever can rewrite the snapshot can recompute every
 * fingerprint, the settlement and the checksum, and hand over a flawless
 * snapshot of a real different round — at any stake, staked or settled. The
 * second test builds exactly that and shows it restoring as a fixed point,
 * because a control that does not exist should be demonstrated absent rather
 * than described away.
 *
 * What defends the ticket is that `restore()` will not name a round on a
 * snapshot's say-so. For any bound snapshot the caller must supply the round it
 * published, and that value comes from outside the store the adversary rewrote.
 */
describe('permutation module: which round a restored snapshot plays', () => {
  const seedHex = seed(81);
  const reseal = (value: Record<string, unknown>): string =>
    JSON.stringify({
      ...value,
      snapshotHash: snapshotHash({ ...value, snapshotHash: undefined }),
    });

  /** A staked, non-terminal ticket on round A: no settlement, no revealed seed. */
  const stakedOnA = async (): Promise<{
    roundA: PermutationTranscript;
    roundB: PermutationTranscript;
    book: PermutationBook;
    snapshot: Record<string, unknown>;
  }> => {
    const roundA = makePermutationTranscript(seedHex, CLASSIC, 'staked-a');
    const roundB = makePermutationTranscript(seedHex, CLASSIC, 'staked-b');
    const book = new PermutationBook(CLASSIC, bindingOf(roundA));
    await book.place({
      idempotencyKey: 'a',
      bet: { code: 'first', item: roundA.order[0] as number },
      stake: 100n,
    });
    await book.place({
      idempotencyKey: 'b',
      bet: { code: 'slot', item: roundA.order[1] as number, position: 1 },
      stake: 25n,
    });
    const snapshot = book.snapshot() as unknown as Record<string, unknown>;
    // The premise: nothing else in this snapshot knows which round it is.
    expect(snapshot.settlement).toBeNull();
    expect(snapshot.terminal).toBe(false);
    return { roundA, roundB, book, snapshot };
  };

  it('catches a partial rewrite, where the binding moved and the receipts did not', async () => {
    const { roundA, roundB, snapshot } = await stakedOnA();
    expect(() =>
      PermutationBook.restore(CLASSIC, reseal(snapshot), bindingOf(roundA)),
    ).not.toThrow();

    // Here the caller is told round B and the snapshot says round B, so the
    // published-round check passes — and the place receipts, minted against A,
    // are what refuses it. This is the one rewrite the fingerprint really stops.
    for (const mutation of [
      { ...snapshot, binding: bindingOf(roundB) },
      { ...snapshot, binding: { ...bindingOf(roundA), roundId: 'staked-b' } },
      { ...snapshot, binding: { ...bindingOf(roundA), commitment: roundB.commitment } },
    ])
      expect(
        () =>
          PermutationBook.restore(
            CLASSIC,
            reseal(mutation),
            mutation.binding as PermutationRoundBinding,
          ),
        JSON.stringify(mutation.binding),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT', path: '$.claims' }));

    // The same ticket placed into the other round is a different command log,
    // which is the property that refusal rests on.
    const elsewhere = new PermutationBook(CLASSIC, bindingOf(roundB));
    await elsewhere.place({
      idempotencyKey: 'a',
      bet: { code: 'first', item: roundA.order[0] as number },
      stake: 100n,
    });
    const here = (snapshot.receipts as { receipt: { commandFingerprint: string } }[])[0]!;
    const there = elsewhere.snapshot().receipts[0]!;
    expect(there.receipt.commandFingerprint).not.toBe(here.receipt.commandFingerprint);
  });

  /**
   * The consistent rewrite: built here, shown undetectable, then refused by the
   * only thing that can refuse it.
   *
   * Nothing below reaches for a private symbol. `commandFingerprint` is core's
   * exported hash over public fields, and the substituted round's commitment
   * comes from this module's own exported transcript builder. That is the point:
   * the cost of the forgery is a dozen lines and no secret at all.
   */
  it('cannot detect a consistent whole-round rewrite, and refuses it on the published round instead', async () => {
    const { roundA, roundB, snapshot } = await stakedOnA();
    const claims = snapshot.claims as { code: string; parameters: number[]; stake: string }[];
    const receipts = snapshot.receipts as {
      fingerprint: string;
      receipt: Record<string, unknown>;
    }[];

    const sealed = reseal({
      ...snapshot,
      binding: bindingOf(roundB),
      receipts: receipts.map((entry, index) => {
        const claim = claims[index]!;
        const fingerprint = commandFingerprint('place', [
          roundB.roundId,
          roundB.commitment,
          claim.code,
          ...claim.parameters,
          BigInt(claim.stake),
        ]);
        return { fingerprint, receipt: { ...entry.receipt, commandFingerprint: fingerprint } };
      }),
    });

    // Undetectable, pinned as a fact about this code rather than left as a
    // worry. Told round B was published, restore accepts it, keeps both claims
    // and the whole 125 stake, and re-serializes to the same bytes: a fixed
    // point, indistinguishable from an honest snapshot of round B — which is
    // exactly what it now is.
    const moved = PermutationBook.restore(CLASSIC, sealed, bindingOf(roundB));
    expect(moved.binding).toEqual(bindingOf(roundB));
    expect(moved.claims).toHaveLength(2);
    expect(moved.claims.reduce((total, claim) => total + claim.stake, 0n)).toBe(125n);
    expect(JSON.stringify(moved.snapshot())).toBe(sealed);

    // And it is worth money: this ticket wins in A and loses in B.
    const stolen = await moved.settle({
      idempotencyKey: 's',
      revealedSeed: seedHex,
      transcript: roundB,
    });
    const honest = new PermutationBook(CLASSIC, bindingOf(roundA));
    await honest.place({
      idempotencyKey: 'a',
      bet: { code: 'first', item: roundA.order[0] as number },
      stake: 100n,
    });
    await honest.place({
      idempotencyKey: 'b',
      bet: { code: 'slot', item: roundA.order[1] as number, position: 1 },
      stake: 25n,
    });
    const paid = await honest.settle({
      idempotencyKey: 's',
      revealedSeed: seedHex,
      transcript: roundA,
    });
    expect(stolen.credited).toBe(0n);
    expect(paid.credited).toBeGreaterThan(0n);

    // The only control that bites: the caller holds round A, because publishing
    // A is what opened the round, and A is not what these bytes name.
    expect(() => PermutationBook.restore(CLASSIC, sealed, bindingOf(roundA))).toThrowError(
      expect.objectContaining({ code: 'COMMITMENT_MISMATCH', path: '$.expectedBinding' }),
    );
  });

  it('refuses every bound snapshot when the caller supplies no published round', async () => {
    const { roundA, book, snapshot } = await stakedOnA();
    // Staked and non-terminal.
    expect(() => restoreWithoutBinding(CLASSIC, reseal(snapshot))).toThrowError(
      expect.objectContaining({ code: 'COMMITMENT_MISMATCH', path: '$.expectedBinding' }),
    );
    // And settled, which carries a re-derivable proof and is refused all the
    // same: a proof says how a round went, never which round was played.
    await book.settle({ idempotencyKey: 's', revealedSeed: seedHex, transcript: roundA });
    const terminal = book.snapshot() as unknown as Record<string, unknown>;
    expect(terminal.terminal).toBe(true);
    expect(() => restoreWithoutBinding(CLASSIC, reseal(terminal))).toThrowError(
      expect.objectContaining({ code: 'COMMITMENT_MISMATCH', path: '$.expectedBinding' }),
    );
    // Supplied, it restores and the money comes back with it.
    expect(
      PermutationBook.restore(CLASSIC, reseal(terminal), bindingOf(roundA)).liquidBalance,
    ).toBe(book.liquidBalance);
  });

  /**
   * Absent evidence and malformed evidence must not converge.
   *
   * The realistic host bug is `restore(definition, snapshot, lookup() ?? null)`,
   * where the lookup missed. If a nullish or half-built binding were treated as
   * "no evidence supplied", it would take the evidence-free path — and on a
   * *bound* snapshot that path is the whole vulnerability. `null` is the
   * explicit unbound sentinel; every other supplied value is a binding and is
   * validated as one.
   */
  it.each([
    ['a number', 0],
    ['a string', 'staked-a'],
    ['an array', []],
    ['an empty object', {}],
    ['a roundId with no commitment', { roundId: 'staked-a' }],
    ['a commitment with no roundId', { commitment: '0'.repeat(64) }],
    ['a binding with an extra field', { roundId: 'staked-a', commitment: '0'.repeat(64), n: 1 }],
    ['a non-hex commitment', { roundId: 'staked-a', commitment: 'z'.repeat(64) }],
  ])(
    'refuses malformed published-round evidence rather than ignoring it: %s',
    async (_l, given) => {
      const { snapshot } = await stakedOnA();
      const error = captureError(() =>
        PermutationBook.restore(CLASSIC, reseal(snapshot), given as never),
      );
      expect(error).toBeInstanceOf(RevealEngineError);
      expect(error).not.toBeInstanceOf(TypeError);
      expect((error as RevealEngineError).code).toBe('CLAIM_REJECTED');
      // `$.expectedBinding`, or a field inside it — the argument the caller got wrong.
      // Never `$.binding`, which would blame the snapshot for a caller's bug.
      expect((error as RevealEngineError).path).toMatch(/^\$\.expectedBinding(\.|$)/u);
    },
  );

  /**
   * A bound book that has done nothing is still bound, and still needs the round.
   *
   * The rule is deliberately uniform — a binding means evidence — rather than
   * carved out for the empty case. Restoring an empty bound snapshot under
   * another round really is harmless, being indistinguishable from constructing
   * a fresh book bound to it; but "bound implies evidence" is a rule an auditor
   * can check in one line, and a carve-out is the seam a later change reopens.
   *
   * The evidence-free path is therefore exactly the *unbound* snapshot, which is
   * the one state that cannot hold a claim or a settlement, selected with the
   * lifecycle contract's explicit `null` sentinel.
   */
  it('restores only the unbound snapshot without evidence, and checks any that is offered', () => {
    const roundA = makePermutationTranscript(seedHex, CLASSIC, 'staked-a');
    const roundB = makePermutationTranscript(seedHex, CLASSIC, 'staked-b');

    const bound = new PermutationBook(CLASSIC, bindingOf(roundA)).snapshot() as unknown as Record<
      string,
      unknown
    >;
    expect(bound.claims).toEqual([]);
    expect(() => restoreWithoutBinding(CLASSIC, reseal(bound))).toThrowError(
      expect.objectContaining({ code: 'COMMITMENT_MISMATCH', path: '$.expectedBinding' }),
    );
    const repointed = reseal({ ...bound, binding: bindingOf(roundB) });
    expect(() => PermutationBook.restore(CLASSIC, repointed, bindingOf(roundA))).toThrowError(
      expect.objectContaining({ code: 'COMMITMENT_MISMATCH', path: '$.expectedBinding' }),
    );
    expect(PermutationBook.restore(CLASSIC, repointed, bindingOf(roundB)).binding).toEqual(
      bindingOf(roundB),
    );

    const unbound = new PermutationBook(CLASSIC).snapshot() as unknown as Record<string, unknown>;
    expect(unbound.binding).toBeNull();
    expect(PermutationBook.restore(CLASSIC, reseal(unbound), null).binding).toBeUndefined();
    // A caller naming a round is telling restore something these bytes
    // contradict, and is told so rather than handed an unbound book anyway.
    expect(() => PermutationBook.restore(CLASSIC, reseal(unbound), bindingOf(roundA))).toThrowError(
      expect.objectContaining({ code: 'COMMITMENT_MISMATCH', path: '$.expectedBinding' }),
    );
    // And the unbound path cannot be used to launder a staked ticket past the
    // evidence requirement: an unbound book cannot have staked anything.
    expect(() =>
      PermutationBook.restore(
        CLASSIC,
        reseal({ ...unbound, claims: [{ key: 'a', code: 'first', parameters: [0], stake: '25' }] }),
        null,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT', path: '$.binding' }));
  });
});
