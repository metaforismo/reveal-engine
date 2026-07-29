import { describe, expect, it } from 'vitest';
import { MODULE_API_VERSION } from '../src/core/versions.js';
import { defineLifecycleModule, samplerScopeOf } from '../src/core/module.js';
import {
  assertModuleConformance,
  checkModuleConformance,
  conformanceSeed,
} from '../src/conformance/module-conformance.js';
import { findModule, listModules, requireModule } from '../src/modules/index.js';
import { progressiveMarket } from '../src/modules/progressive-market/module.js';
import {
  binaryBeaconReference,
  blackSignalReference,
  constellationReference,
} from '../src/modules/progressive-market/references/index.js';
import { sealCommitment } from '../src/core/commitment.js';
import { ENGINE_LIMITS } from '../src/api/limits.js';
import { rational, type Rational } from '../src/core/rational.js';
import { snapshotHash } from '../src/core/snapshot.js';
import {
  orderingFixtureDefinition,
  orderingFixtureLargeDefinition,
  orderingFixtureModule,
  type OrderingBet,
  type OrderingStep,
} from './support/ordering-fixture-module.js';
import { seed } from './helpers.js';

describe('lifecycle module contract', () => {
  it('registers progressive-market as a module, not as the engine spine', () => {
    expect(listModules().map((module) => module.id)).toEqual(['progressive-market']);
    expect(findModule('progressive-market')).toBe(progressiveMarket);
    expect(requireModule('progressive-market').moduleApiVersion).toBe(MODULE_API_VERSION);
    expect(progressiveMarket.truth.kind).toBe('scalar-index');
    expect(progressiveMarket.steps.choiceTiming).toBe('none');
    expect(progressiveMarket.book.positions).toBe('single');
    expect(progressiveMarket.book.settlement).toBe('winner-takes-claim');
    expect(progressiveMarket.book.actions).toEqual(['open', 'sell', 'settle']);
    expect(progressiveMarket.transcript.schema).toBe('reveal-engine/transcript-v2');
    expect(progressiveMarket.book.snapshotSchema).toBe('reveal-engine/round-book-v1');
    expect(Object.isFrozen(progressiveMarket)).toBe(true);
  });

  it('routes every declared hook to the relocated implementation', () => {
    const definition = binaryBeaconReference;
    const identity = progressiveMarket.definitions.identity(definition);
    expect(identity).toMatchObject({
      moduleId: 'progressive-market',
      definitionId: definition.id,
      definitionVersion: definition.adapterVersion,
    });
    expect(identity.fingerprint).toBe(progressiveMarket.definitions.fingerprint(definition));

    const roundId = 'contract-round';
    const round = { ...identity, roundId, proofVersion: 'reveal-engine/commit-v2' as const };
    const truth = progressiveMarket.truth.derive(seed(11), definition, roundId);
    const steps = progressiveMarket.steps.derive(seed(11), definition, round, truth, []);
    expect(steps).toHaveLength(progressiveMarket.steps.count(definition));

    const transcript = progressiveMarket.transcript.build(seed(11), definition, roundId);
    expect(transcript.truth).toBe(truth);
    expect(progressiveMarket.steps.equal(transcript.evidence, steps)).toBe(true);
    expect(transcript.commitment).toBe(
      sealCommitment(
        seed(11),
        progressiveMarket.transcript.commitmentBody(definition, round, truth, steps, []),
      ),
    );
    expect(progressiveMarket.verify(seed(11), definition, transcript).ok).toBe(true);
    expect(
      progressiveMarket.transcript.fromWire(progressiveMarket.transcript.toWire(transcript)),
    ).toEqual(transcript);

    const belief = progressiveMarket.steps.belief(definition, steps);
    expect(belief.total).toBe(belief.weights.reduce((sum, weight) => sum + weight, 0n));
    expect(progressiveMarket.truth.encode(truth)).toEqual([truth]);
    expect(progressiveMarket.truth.equal(truth, truth)).toBe(true);
    expect(progressiveMarket.truth.enumerate?.(definition)).toEqual([0, 1]);
    expect(progressiveMarket.steps.encode(steps[0]!)).toEqual([
      steps[0]!.index,
      steps[0]!.target,
      steps[0]!.favour,
      steps[0]!.other,
      steps[0]!.label,
    ]);
    expect(progressiveMarket.definitions.define(definition)).toEqual(definition);
    expect(samplerScopeOf(round)).toEqual({
      domain: definition.id,
      roundId,
      proofVersion: 'reveal-engine/commit-v2',
    });
  });

  it('drives a real round through the module book hooks', async () => {
    const definition = binaryBeaconReference;
    const transcript = progressiveMarket.transcript.build(seed(12), definition, 'book-round');
    const book = progressiveMarket.book.create(definition);
    await book.open({
      idempotencyKey: 'open',
      expectedFrameRevision: 0,
      outcome: transcript.truth,
      stake: 100n,
    });
    for (const event of transcript.evidence) await book.advanceFrame(event);
    const receipt = await book.settle({
      idempotencyKey: 'settle',
      expectedFrameRevision: transcript.evidence.length,
      revealedSeed: seed(12),
      transcript,
    });
    expect(receipt.credited).toBeGreaterThan(0n);
    const snapshot = progressiveMarket.book.snapshot(book);
    const restored = progressiveMarket.book.restore(definition, snapshot);
    expect(progressiveMarket.book.snapshot(restored)).toEqual(snapshot);
  });

  it.each([blackSignalReference, constellationReference, binaryBeaconReference])(
    'runs the generic conformance harness for $id',
    (definition) => {
      const report = checkModuleConformance(progressiveMarket, definition, 4);
      expect(report.ok, JSON.stringify(report.failures)).toBe(true);
      expect(report.schema).toBe('reveal-engine/module-conformance-v1');
      expect(report.moduleId).toBe('progressive-market');
      expect(report.counters.transcripts).toBe(4);
      expect(report.counters.truthsSwept).toBe(4 * definition.outcomes.length);
      expect(report.checks).toContain('TRUTH_SWEEP');
    },
  );

  it('reports a definition that violates the contract instead of throwing', () => {
    const report = checkModuleConformance(progressiveMarket, {} as never, 1);
    expect(report.ok).toBe(false);
    expect(report.definitionId).toBe('<invalid>');
    expect(() => assertModuleConformance(progressiveMarket, {} as never, 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ADAPTER' }),
    );
    expect(conformanceSeed(3)).toBe(seed(3));
  });

  it.each([
    ['bad api version', { moduleApiVersion: 'reveal-engine/module-v0' }],
    ['missing verifier', { verify: undefined }],
    ['missing book contract', { book: undefined }],
    ['no conformance checks', { conformance: { defaultSeeds: 1, checks: [] } }],
    [
      'schema outside accepted set',
      { transcript: { ...orderingFixtureModule.transcript, schema: 'x/v1' } },
    ],
    ['no receipt actions', { book: { ...orderingFixtureModule.book, actions: [] } }],
  ])('rejects a malformed module: %s', (_label, mutation) => {
    expect(() =>
      defineLifecycleModule({ ...orderingFixtureModule, ...mutation } as never),
    ).toThrow();
  });
});

describe('shape (a)/(c): permutation truth, zero elimination, combinatorial paytable', () => {
  const definition = orderingFixtureDefinition;

  it('accepts a permutation truth and a multi-claim paytable book', () => {
    expect(orderingFixtureModule.truth.kind).toBe('permutation');
    expect(orderingFixtureModule.book.positions).toBe('multi');
    expect(orderingFixtureModule.book.settlement).toBe('paytable');
    expect(orderingFixtureModule.book.maxOpenClaims).toBeGreaterThan(1);
    const truth = orderingFixtureModule.truth.derive(seed(20), definition, 'r1');
    expect([...truth].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('eliminates revealed outcomes to exactly zero, never to an epsilon', () => {
    const transcript = orderingFixtureModule.transcript.build(seed(21), definition, 'r2');
    const belief = orderingFixtureModule.steps.belief(definition, transcript.steps);
    expect(belief.total).toBe(1n);
    expect(belief.weights.filter((weight) => weight === 0n)).toHaveLength(3);
    expect(belief.weights[transcript.truth[0] as number]).toBe(1n);
  });

  it('prices a combinatorial paytable exactly, outside the flat weight vector', () => {
    const large = orderingFixtureLargeDefinition;
    // 8! = 40,320 orderings and 336 trifectas, both far beyond maxOutcomes = 64.
    expect(orderingFixtureModule.steps.beliefSpace).toBe('marginal');
    expect(large.items.length).toBeLessThanOrEqual(ENGINE_LIMITS.maxOutcomes);
    const priceOf = (bet: OrderingBet, steps: readonly OrderingStep[] = []): Rational =>
      (orderingFixtureModule.steps.price as NonNullable<typeof orderingFixtureModule.steps.price>)(
        large,
        steps,
        bet,
      );
    expect(priceOf({ kind: 'win', items: [3] })).toEqual(rational(1n, 8n));
    expect(priceOf({ kind: 'exacta', items: [3, 5] })).toEqual(rational(1n, 56n));
    expect(priceOf({ kind: 'trifecta', items: [3, 5, 1] })).toEqual(rational(1n, 336n));

    const transcript = orderingFixtureModule.transcript.build(seed(26), large, 'r-large');
    const eliminated = transcript.steps[0] as OrderingStep;
    expect(
      priceOf({ kind: 'win', items: [eliminated.item] }, transcript.steps.slice(0, 1)),
    ).toEqual(rational(0n));
    // One position revealed leaves 7! orderings, so a fresh trifecta is 4!/7!.
    expect(
      priceOf(
        {
          kind: 'trifecta',
          items: [
            transcript.truth[0] as number,
            transcript.truth[1] as number,
            transcript.truth[2] as number,
          ],
        },
        transcript.steps.slice(0, 1),
      ),
    ).toEqual(rational(1n, 210n));
  });

  it('verifies by pure re-derivation and rejects a tampered truth', () => {
    const transcript = orderingFixtureModule.transcript.build(seed(22), definition, 'r3');
    expect(orderingFixtureModule.verify(seed(22), definition, transcript)).toMatchObject({
      ok: true,
    });
    expect(
      orderingFixtureModule.verify(seed(22), definition, {
        ...transcript,
        truth: [...transcript.truth].reverse(),
      }),
    ).toMatchObject({ ok: false, code: 'TRANSCRIPT_MISMATCH' });
    expect(orderingFixtureModule.verify(seed(23), definition, transcript)).toMatchObject({
      ok: false,
    });
    expect(orderingFixtureModule.verify(seed(22), definition, { schema: 'other' })).toMatchObject({
      ok: false,
      code: 'INVALID_TRANSCRIPT',
    });
    expect(
      orderingFixtureModule.verify(seed(22), { ...definition, version: '9.9.9' }, transcript),
    ).toMatchObject({ ok: false, code: 'DEFINITION_MISMATCH' });
  });

  it('settles several simultaneous claims from one shared ledger', async () => {
    const transcript = orderingFixtureModule.transcript.build(seed(24), definition, 'r4');
    const book = orderingFixtureModule.book.create(definition);
    const winner = transcript.truth[0] as number;
    const loser = transcript.truth[1] as number;
    await book.stake('claim-a', { kind: 'win', items: [winner] }, 100n, []);
    await book.stake('claim-b', { kind: 'win', items: [loser] }, 50n, []);
    expect(book.claims).toHaveLength(2);
    expect(book.capBasisStake).toBe(150n);
    const receipt = await book.settle('settle', transcript);
    expect(receipt.credited).toBe(388n);
    expect(book.terminal).toBe(true);
    expect(orderingFixtureModule.book.snapshot(book)).toMatchObject({
      schema: 'ordering-fixture/book-v1',
      terminal: true,
    });
  });

  it('pays a legitimate multi-position claim that a single-basis cap would have crushed', async () => {
    // The regression this fixture exists for: with a cap basis pinned to the
    // round's FIRST stake, staking 1 on a loser then 10,000 on the winner caps
    // a legitimate 38,800 claim at 10. Independently funded positions must each
    // raise the ceiling.
    const transcript = orderingFixtureModule.transcript.build(seed(27), definition, 'r6');
    const winner = transcript.truth[0] as number;
    const loser = transcript.truth[1] as number;
    const capped = { ...definition, maxWinMultiple: 10n };
    const book = orderingFixtureModule.book.create(capped);
    await book.stake('tiny-loser', { kind: 'win', items: [loser] }, 1n, []);
    await book.stake('real-bet', { kind: 'win', items: [winner] }, 10_000n, []);
    expect(book.capBasisStake).toBe(10_001n);
    const receipt = await book.settle('settle', transcript);
    expect(receipt.credited).toBe(38_800n);
    expect(receipt.capped).toBe(false);
    // The ceiling is still a hard multiple of what the player actually risked.
    expect(receipt.credited).toBeLessThanOrEqual(10_001n * 10n);
  });

  it('restores a staked, settled book by re-validating it and rejects a tampered one', async () => {
    const transcript = orderingFixtureModule.transcript.build(seed(28), definition, 'r7');
    const book = orderingFixtureModule.book.create(definition);
    await book.stake('a', { kind: 'win', items: [transcript.truth[0] as number] }, 100n, []);
    await book.stake(
      'b',
      { kind: 'exacta', items: [transcript.truth[0] as number, transcript.truth[1] as number] },
      25n,
      [],
    );
    await book.settle('settle', transcript);
    const snapshot = orderingFixtureModule.book.snapshot(book) as Record<string, unknown>;
    const restored = orderingFixtureModule.book.restore(definition, JSON.stringify(snapshot));
    expect(orderingFixtureModule.book.snapshot(restored)).toEqual(snapshot);
    expect(restored.claims).toHaveLength(2);
    expect(restored.capBasisStake).toBe(125n);
    // Re-sealed, so each mutation is rejected on its merits rather than by the
    // snapshot hash: a tampered store would recompute the hash too.
    for (const mutation of [
      { liquidBalance: '999999' },
      { capBasisStake: '999999' },
      { terminal: false },
      { claims: [] },
      { ledgerRevision: 9 },
      // A rewritten bet must not survive the receipt that recorded it.
      {
        claims: (snapshot.claims as Record<string, unknown>[]).map((claim, index) =>
          index === 0 ? { ...claim, stake: '999999' } : claim,
        ),
      },
    ]) {
      const tampered = {
        ...snapshot,
        ...mutation,
        snapshotHash: snapshotHash({ ...snapshot, ...mutation, snapshotHash: undefined }),
      };
      expect(() =>
        orderingFixtureModule.book.restore(definition, JSON.stringify(tampered)),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }));
    }
  });

  it('refuses a stake on an outcome already eliminated to zero', async () => {
    const transcript = orderingFixtureModule.transcript.build(seed(25), definition, 'r5');
    const book = orderingFixtureModule.book.create(definition);
    const eliminated = transcript.steps[0]?.item as number;
    await expect(
      book.stake('claim', { kind: 'win', items: [eliminated] }, 10n, transcript.steps),
    ).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
  });

  it('passes its own declared conformance checks', () => {
    const report = assertModuleConformance(orderingFixtureModule, definition, 6);
    expect(report.ok).toBe(true);
    expect(report.counters).toMatchObject({ truths: 6, transcripts: 6, snapshots: 6 });
    expect(report.moduleId).toBe('ordering-fixture');
  });
});
