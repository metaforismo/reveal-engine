import { describe, expect, it } from 'vitest';
import { ENGINE_LIMITS } from '../src/api/limits.js';
import { sealSeedCommitment } from '../src/core/commitment.js';
import { snapshotHash } from '../src/core/snapshot.js';
import { defineLifecycleModule } from '../src/core/module.js';
import { COMMITMENT_VERSION } from '../src/core/versions.js';
import { assertModuleConformance } from '../src/conformance/module-conformance.js';
import { progressiveMarket } from '../src/modules/progressive-market/module.js';
import { binaryBeaconReference } from '../src/modules/progressive-market/references/index.js';
import {
  stagedSurvivalFixtureDefinition as definition,
  stagedSurvivalFixtureModule as survival,
  type SurvivalStep,
  type SurvivalTranscript,
} from './support/staged-survival-fixture-module.js';
import { seed } from './helpers.js';

const roundOf = (roundId: string): Parameters<typeof survival.steps.derive>[2] =>
  Object.freeze({
    moduleId: survival.id,
    definitionId: definition.id,
    roundId,
    proofVersion: COMMITMENT_VERSION,
  });

/** Recomputes the checksum so a mutation is judged on its merits, not on the hash. */
const reseal = (snapshot: Record<string, unknown>): Record<string, unknown> => ({
  ...snapshot,
  snapshotHash: snapshotHash({ ...snapshot, snapshotHash: undefined }),
});

/** Every stage resolved under one contract, for a round that plays to the end. */
const allStages = (contract: string): string[] =>
  Array.from({ length: definition.stages }, () => contract);

describe('shape (b): a round whose transcript is a function of seed and choices', () => {
  it('declares choice timing, partial settlement, and a seed pre-commitment', () => {
    expect(survival.steps.choiceTiming).toBe('before-step');
    expect(survival.book.settlement).toBe('partial');
    expect(survival.book.positions).toBe('multi');
    expect(survival.truth.kind).toBe('composite');
    expect(typeof survival.transcript.seedCommitment).toBe('function');
  });

  it('derives a tape from the seed alone and steps from the tape plus the choices', () => {
    const truth = survival.truth.derive(seed(40), definition, 'r1');
    expect(truth.draws).toHaveLength(definition.stages * definition.entities);
    expect(survival.truth.equal(truth, survival.truth.derive(seed(40), definition, 'r1'))).toBe(
      true,
    );
    // A different decision log cannot change one draw of the tape.
    expect(survival.truth.derive(seed(40), definition, 'r1').digest).toBe(truth.digest);

    const round = roundOf('r1');
    const steady = survival.steps.derive(seed(40), definition, round, truth, allStages('steady'));
    const again = survival.steps.derive(seed(40), definition, round, truth, allStages('steady'));
    const bold = survival.steps.derive(seed(40), definition, round, truth, allStages('bold'));
    expect(survival.steps.equal(steady, again)).toBe(true);
    expect(survival.steps.equal(steady, bold)).toBe(false);
    // The transcript is exactly as long as the decision log.
    expect(survival.steps.derive(seed(40), definition, round, truth, ['steady'])).toHaveLength(1);
  });

  it('publishes a seed commitment before any choice exists and re-derives it on reveal', () => {
    const round = roundOf('r2');
    const published = survival.transcript.seedCommitment?.(seed(41), definition, round) as string;
    expect(published).toMatch(/^[0-9a-f]{64}$/u);
    expect(published).toBe(
      sealSeedCommitment(seed(41), {
        moduleId: survival.id,
        definitionId: definition.id,
        definitionFingerprint: survival.definitions.fingerprint(definition),
        roundId: 'r2',
        proofVersion: COMMITMENT_VERSION,
      }),
    );

    // The published value is the same whatever the player later decides.
    for (const choices of [[], ['steady'], allStages('bold')]) {
      const transcript = survival.transcript.build(seed(41), definition, 'r2', choices);
      expect(transcript.seedCommitment).toBe(published);
      expect(survival.verify(seed(41), definition, transcript)).toMatchObject({ ok: true });
    }
    // A round settled under a different seed fails at the pre-commitment, not later.
    const transcript = survival.transcript.build(seed(41), definition, 'r2', ['steady']);
    expect(survival.verify(seed(42), definition, transcript)).toMatchObject({
      ok: false,
      code: 'COMMITMENT_MISMATCH',
      path: '$.seedCommitment',
    });
  });

  it('refuses to re-settle one commitment under a different choice log', () => {
    const honest = survival.transcript.build(seed(43), definition, 'r3', allStages('steady'));
    expect(survival.verify(seed(43), definition, honest)).toMatchObject({ ok: true });

    // Swap the decision log but keep the recorded steps: re-derivation catches it.
    const relabelled: SurvivalTranscript = { ...honest, choices: allStages('bold') };
    expect(survival.verify(seed(43), definition, relabelled)).toMatchObject({
      ok: false,
      code: 'TRANSCRIPT_MISMATCH',
    });

    // Swap both consistently — a whole second settlement of the same round — and
    // the published commitment no longer matches, because the body binds choices.
    const forged = survival.transcript.build(seed(43), definition, 'r3', allStages('bold'));
    const resettled: SurvivalTranscript = { ...forged, commitment: honest.commitment };
    expect(survival.verify(seed(43), definition, resettled)).toMatchObject({
      ok: false,
      code: 'COMMITMENT_MISMATCH',
      path: '$.commitment',
    });
    expect(forged.commitment).not.toBe(honest.commitment);
    expect(forged.seedCommitment).toBe(honest.seedCommitment);
  });

  it('runs a real round: per-entity claims, a banked subset, and a settled remainder', async () => {
    const roundId = 'r4';
    const truth = survival.truth.derive(seed(44), definition, roundId);
    const book = survival.book.create(definition);
    const stakes = [100n, 50n, 25n, 25n];
    for (const [entity, stake] of stakes.entries())
      await book.enter(`enter-${entity}`, entity, stake);
    // Each entity is funded separately, so each one raises the round ceiling.
    expect(book.capBasisStake).toBe(200n);
    expect(book.claims).toHaveLength(4);

    const choices: string[] = [];
    for (let stage = 0; stage < definition.stages; stage += 1) {
      const contract = stage === 0 ? 'steady' : 'bold';
      await book.choose(`choose-${stage}`, contract);
      choices.push(contract);
      const steps = survival.steps.derive(
        seed(44),
        definition,
        roundOf(roundId),
        truth,
        choices,
      ) as readonly SurvivalStep[];
      await book.resolve(steps[stage] as SurvivalStep);

      const live = book.claims.filter((claim) => claim.live);
      if (stage === 0 && live.length > 1) {
        // Bank a strict subset and leave the rest at risk: partial settlement.
        const banked = await book.bank('bank-1', [live[0]?.entity as number]);
        expect(banked.credited).toBeGreaterThan(0n);
        expect(book.claims.filter((claim) => claim.banked)).toHaveLength(1);
        expect(book.claims.filter((claim) => claim.live).length).toBe(live.length - 1);
        expect(book.terminal).toBe(false);
      }
      if (book.terminal) break;
    }

    const transcript = survival.transcript.build(seed(44), definition, roundId, choices);
    if (!book.terminal) {
      const receipt = await book.settle('settle', seed(44), transcript);
      expect(receipt.action).toBe('settle');
      expect(book.terminal).toBe(true);
    }
    // The whole round stayed inside a ceiling proportional to the money staked.
    expect(book.liquidBalance).toBeLessThanOrEqual(200n * definition.maxWinMultiple);
    expect(book.choices).toEqual(choices);
    expect(survival.book.snapshot(book)).toMatchObject({
      schema: 'staged-survival-fixture/book-v1',
      terminal: true,
    });
  });

  it("rejects a settlement proof built from someone else's decisions", async () => {
    const roundId = 'r5';
    const truth = survival.truth.derive(seed(45), definition, roundId);
    const book = survival.book.create(definition);
    await book.enter('enter-0', 0, 10n);
    await book.choose('choose-0', 'steady');
    const steps = survival.steps.derive(seed(45), definition, roundOf(roundId), truth, ['steady']);
    await book.resolve(steps[0] as SurvivalStep);

    const foreign = survival.transcript.build(seed(45), definition, roundId, ['bold']);
    await expect(book.settle('settle', seed(45), foreign)).rejects.toMatchObject({
      code: 'TRANSCRIPT_MISMATCH',
    });
    const honest = survival.transcript.build(seed(45), definition, roundId, ['steady']);
    await expect(book.settle('settle', seed(45), honest)).resolves.toMatchObject({
      action: 'settle',
    });
  });

  it('refuses a stage step that does not match the decision the book logged', async () => {
    const roundId = 'r6';
    const truth = survival.truth.derive(seed(46), definition, roundId);
    const book = survival.book.create(definition);
    await book.enter('enter-0', 0, 10n);
    await book.choose('choose-0', 'steady');
    const boldStep = survival.steps.derive(seed(46), definition, roundOf(roundId), truth, [
      'bold',
    ])[0] as SurvivalStep;
    await expect(book.resolve(boldStep)).rejects.toMatchObject({ code: 'TRANSCRIPT_MISMATCH' });
    await expect(book.choose('choose-again', 'bold')).rejects.toMatchObject({
      code: 'CLAIM_REJECTED',
    });

    const fresh = survival.book.create(definition);
    await fresh.enter('enter-0', 0, 10n);
    await expect(fresh.choose('choose-unknown', 'nope')).rejects.toMatchObject({
      code: 'INVALID_CHOICE',
    });
  });

  it('reconnects mid-round with the decision log intact, and rejects a tampered one', async () => {
    const roundId = 'r9';
    const truth = survival.truth.derive(seed(49), definition, roundId);
    const book = survival.book.create(definition);
    await book.enter('enter-0', 0, 60n);
    await book.enter('enter-1', 1, 40n);
    await book.choose('choose-0', 'steady');
    const steps = survival.steps.derive(seed(49), definition, roundOf(roundId), truth, ['steady']);
    await book.resolve(steps[0] as SurvivalStep);

    const snapshot = survival.book.snapshot(book) as Record<string, unknown>;
    const restored = survival.book.restore(definition, JSON.stringify(snapshot));
    // A round that loses its decision log cannot be settled at all: the proof is
    // a function of it. So the log is state, and it must survive the reconnect.
    expect(restored.choices).toEqual(['steady']);
    expect(restored.stageRevision).toBe(1);
    expect(restored.capBasisStake).toBe(100n);
    expect(survival.book.snapshot(restored)).toEqual(snapshot);

    // Re-sealed, so each mutation is rejected on its merits rather than by the
    // snapshot hash: a tampered store would recompute the hash too.
    for (const mutation of [
      { choices: ['bold'] },
      { choices: [] },
      { capBasisStake: '999999' },
      { liquidBalance: '5' },
      { stageRevision: 3 },
      { claims: [] },
    ]) {
      const tampered = reseal({ ...snapshot, ...mutation });
      expect(() => survival.book.restore(definition, JSON.stringify(tampered))).toThrowError(
        expect.objectContaining({
          code: expect.stringMatching(/INVALID_SNAPSHOT|INVALID_CHOICE/u),
        }),
      );
    }
  });

  it('passes its own declared conformance checks', () => {
    const report = assertModuleConformance(survival, definition, 5);
    expect(report.ok).toBe(true);
    expect(report.moduleId).toBe('staged-survival-fixture');
    expect(report.checks).toEqual([
      'TAPE_NOT_DETERMINISTIC',
      'CHOICES_DO_NOT_DRIVE_STEPS',
      'COMMITMENT_IGNORES_CHOICES',
      'SEED_PRECOMMITMENT_BROKEN',
    ]);
    expect(report.counters).toMatchObject({ tapes: 10, choiceLogs: 15, commitmentBodies: 10 });
  });
});

describe('core enforces the choice limits it publishes', () => {
  it('bounds the logged choice list on every contract entry point', () => {
    const truth = survival.truth.derive(seed(47), definition, 'r7');
    const tooMany = Array.from({ length: ENGINE_LIMITS.maxLoggedChoices + 1 }, () => 'steady');
    expect(() =>
      survival.steps.derive(seed(47), definition, roundOf('r7'), truth, tooMany),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CHOICE' }));
    expect(() => survival.transcript.build(seed(47), definition, 'r7', tooMany)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CHOICE' }),
    );
    expect(() =>
      survival.transcript.commitmentBody(definition, roundOf('r7'), truth, [], tooMany),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CHOICE' }));
  });

  /**
   * `verify()` is the only entry point that consumes a choice log straight off
   * the wire, and the contract's phase order has it re-derive steps from the
   * transcript's own log rather than through the guarded `steps.derive`. Core
   * closes that path through `transcript.choicesOf`, so the bound holds where it
   * actually matters instead of only on the paths a host already controls.
   */
  it('bounds the choice log a verifier reads off the wire', () => {
    const honest = survival.transcript.build(seed(47), definition, 'r7', allStages('steady'));
    expect(survival.verify(seed(47), definition, honest)).toMatchObject({ ok: true });

    const flooded = {
      ...honest,
      choices: Array.from({ length: ENGINE_LIMITS.maxLoggedChoices + 1 }, () => 'steady'),
    };
    expect(survival.verify(seed(47), definition, flooded)).toMatchObject({
      ok: false,
      code: 'INVALID_TRANSCRIPT',
      message: 'Logged choice count exceeds the engine limit',
      path: '$.choices',
    });
    // A transcript that does not decode at all is still the module's to report.
    expect(survival.verify(seed(47), definition, { schema: 'nope' })).toMatchObject({ ok: false });
  });

  it('refuses a choice-timed module that cannot expose its decoded choice log', () => {
    expect(() =>
      defineLifecycleModule({
        ...survival,
        transcript: { ...survival.transcript, choicesOf: undefined },
      } as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_MODULE' }));
  });

  it('refuses to hand choices to a module that declares none', () => {
    const truth = progressiveMarket.truth.derive(seed(48), binaryBeaconReference, 'r8');
    const round = {
      moduleId: progressiveMarket.id,
      definitionId: binaryBeaconReference.id,
      roundId: 'r8',
      proofVersion: COMMITMENT_VERSION,
    } as const;
    expect(() =>
      progressiveMarket.steps.derive(seed(48), binaryBeaconReference, round, truth, ['x'] as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CHOICE' }));
  });

  it('refuses a choice-timed module that publishes no seed pre-commitment', () => {
    expect(() =>
      defineLifecycleModule({
        ...survival,
        transcript: { ...survival.transcript, seedCommitment: undefined },
      } as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_MODULE' }));
    expect(() =>
      defineLifecycleModule({
        ...survival,
        steps: { ...survival.steps, beliefSpace: 'marginal', price: undefined },
      } as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_MODULE' }));
    expect(() =>
      defineLifecycleModule({
        ...survival,
        book: { ...survival.book, positions: 'single', maxOpenClaims: 8 },
      } as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_MODULE' }));
    expect(() =>
      defineLifecycleModule({
        ...survival,
        book: { ...survival.book, maxOpenClaims: ENGINE_LIMITS.maxRoundClaims + 1 },
      } as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_MODULE' }));
    expect(() =>
      defineLifecycleModule({
        ...survival,
        conformance: { ...survival.conformance, references: [] },
      } as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_MODULE' }));
  });
});
