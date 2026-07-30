import { describe, expect, it } from 'vitest';
import { ENGINE_LIMITS } from '../src/api/limits.js';
import { sealCommitment, sealSeedCommitment } from '../src/core/commitment.js';
import { assertModuleConformance } from '../src/conformance/module-conformance.js';
import { encodeFields, type CanonicalField } from '../src/internal/canonical.js';
import { equal, multiply, rational, type Rational } from '../src/core/rational.js';
import {
  COMMITMENT_VERSION,
  ENGINE_API_VERSION,
  MODULE_API_VERSION,
} from '../src/core/versions.js';
import { requireModule } from '../src/modules/index.js';
import {
  MAX_ROUND_ID_BYTES,
  ROUND_REF_SEPARATOR,
  SURVIVAL_LIMITS,
  SurvivalBook,
  belief,
  contractMenu,
  definitionFields,
  defineSurvivalGame,
  deriveSteps,
  deriveTruth,
  distributionTotal,
  expectedSurvivorsFromDistribution,
  fiveRunnerReference,
  laneSizes,
  laneSurvivorDistribution,
  makeTranscript,
  marginalSurvival,
  maxRoundReturn,
  oracleTrialReference,
  parseRoundRefId,
  price,
  survivorDistribution,
  roundIdentityOf,
  roundRefId,
  seedCommitment,
  stagedSurvival,
  stakedSnapshotFor,
  survivalFingerprint,
  transcriptToWire,
  type SurvivalChoice,
  type SurvivalDefinition,
  type SurvivalStep,
} from '../src/modules/staged-survival/index.js';
import { seed } from './helpers.js';
import { survivalAdmission } from './support/survival-admission.js';

const definition = fiveRunnerReference;
/** The sweep the CLI runs in CI; a narrower one in tests would let CI find things first. */
const CONFORMANCE_SEEDS = 16;
const ENTROPY = 'a1'.repeat(32);
const roundIdFor = (name: string, entropy = ENTROPY): string =>
  roundRefId({ roundId: name, clientEntropy: entropy });

/** Rides the whole field with the first contract the shrinking menu offers. */
function ridePath(
  game: SurvivalDefinition,
  truth: ReturnType<typeof deriveTruth>,
  stages = game.stages,
): SurvivalChoice[] {
  const choices: SurvivalChoice[] = [];
  let live = game.entities;
  for (let stage = 0; stage < stages && live > 0; stage += 1) {
    const menu = contractMenu(game, live);
    if (menu.length === 0) break;
    choices.push({ contractId: (menu[0] as { id: string }).id, banked: [] });
    const steps = deriveSteps(game, truth, choices);
    live = (steps[steps.length - 1] as SurvivalStep).survivors.length;
  }
  return choices;
}

describe('staged-survival: module contract declarations', () => {
  it('declares the shape the contract documents for this lifecycle', () => {
    expect(requireModule('staged-survival')).toBe(stagedSurvival);
    expect(stagedSurvival.moduleApiVersion).toBe(MODULE_API_VERSION);
    expect(stagedSurvival.truth.kind).toBe('composite');
    expect(stagedSurvival.steps.choiceTiming).toBe('before-step');
    expect(stagedSurvival.steps.beliefSpace).toBe('marginal');
    expect(stagedSurvival.book.positions).toBe('multi');
    expect(stagedSurvival.book.settlement).toBe('partial');
    expect(stagedSurvival.book.actions).toEqual(['enter', 'choose', 'bank', 'settle']);
    expect(stagedSurvival.transcript.schema).toBe('staged-survival/transcript-v1');
    expect(stagedSurvival.book.snapshotSchema).toBe('staged-survival/book-v2');
    // A choice-timed module owes both of these, and `defineLifecycleModule`
    // refuses to build one that does not expose them.
    expect(typeof stagedSurvival.transcript.seedCommitment).toBe('function');
    expect(typeof stagedSurvival.transcript.choicesOf).toBe('function');
    expect(typeof stagedSurvival.steps.price).toBe('function');
    expect(Object.isFrozen(stagedSurvival)).toBe(true);
  });

  it('passes its own conformance suite on every declared reference', () => {
    for (const reference of stagedSurvival.conformance.references) {
      const report = assertModuleConformance(
        stagedSurvival,
        reference.definition,
        CONFORMANCE_SEEDS,
      );
      expect(report.ok).toBe(true);
      // Every declared check actually executed; a listed-but-never-run code
      // would be a report claiming evidence it did not produce.
      for (const code of report.checks) expect(report.ran[code]).toBeGreaterThan(0);
    }
  });

  it('composes the commitment body out of the encoders it declares', () => {
    const roundId = roundIdFor('compose');
    const round = roundIdentityOf(definition, roundId);
    const truth = stagedSurvival.truth.derive(seed(7), definition, roundId);
    const choices: SurvivalChoice[] = [{ contractId: 'wide', banked: [] }];
    const steps = stagedSurvival.steps.derive(seed(7), definition, round, truth, choices);
    // Rebuilt from the declared encoders alone: if the body ever stops
    // composing `truth.encode` and `steps.encode`, this stops matching.
    const rebuilt = encodeFields([
      'staged-survival commitment',
      COMMITMENT_VERSION,
      round.moduleId,
      ...definitionFields(definition),
      survivalFingerprint(definition),
      round.roundId,
      ...stagedSurvival.truth.encode(truth),
      choices.length,
      ...choices.flatMap((choice): CanonicalField[] => [
        choice.contractId,
        choice.banked.length,
        ...choice.banked,
      ]),
      steps.length,
      ...steps.flatMap((step) => [...stagedSurvival.steps.encode(step)]),
    ]);
    const body = stagedSurvival.transcript.commitmentBody(definition, round, truth, steps, choices);
    expect(Buffer.from(body).equals(rebuilt)).toBe(true);
    const transcript = stagedSurvival.transcript.build(seed(7), definition, roundId, choices);
    expect(transcript.commitment).toBe(sealCommitment(seed(7), body));
  });

  it('rejects a choice log that exceeds the engine bound before deriving anything', () => {
    const roundId = roundIdFor('bounded');
    const round = roundIdentityOf(definition, roundId);
    const truth = stagedSurvival.truth.derive(seed(8), definition, roundId);
    const oversized = Array.from({ length: ENGINE_LIMITS.maxLoggedChoices + 1 }, () => ({
      contractId: 'wide',
      banked: [] as number[],
    }));
    expect(() =>
      stagedSurvival.steps.derive(seed(8), definition, round, truth, oversized),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CHOICE' }));
  });

  it('holds derivation to the step budget it declared', () => {
    expect(stagedSurvival.steps.maxSteps).toBe(SURVIVAL_LIMITS.maxStages);
    expect(stagedSurvival.steps.count(definition)).toBe(definition.stages);
    const roundId = roundIdFor('budget');
    const truth = deriveTruth(seed(9), definition, roundId);
    const tooMany = Array.from({ length: definition.stages + 1 }, () => ({
      contractId: 'narrow',
      banked: [] as number[],
    }));
    expect(() => deriveSteps(definition, truth, tooMany)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CHOICE' }),
    );
  });
});

describe('staged-survival: the adapter surface', () => {
  it('refuses a contract whose hazard and multiplier do not exactly cancel', () => {
    expect(() =>
      defineSurvivalGame({
        ...definition,
        id: 'unfair-v1',
        contracts: [
          {
            ...(definition.contracts[2] as SurvivalDefinition['contracts'][number]),
            // p = 1/4 needs mu = 4; 39/10 is close and therefore worse than wrong.
            multiplier: rational(39n, 10n),
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER' }));
  });

  it('refuses a continuation return that is not exactly one', () => {
    expect(() =>
      defineSurvivalGame({
        ...definition,
        id: 'recharging-v1',
        pricing: { ...definition.pricing, continuationReturn: rational(99n, 100n) },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER' }));
  });

  it('refuses a denominator the draw modulus cannot divide exactly', () => {
    expect(() =>
      defineSurvivalGame({
        ...definition,
        id: 'inexact-v1',
        // 7 does not divide 1,200,000, so the survival test could only be a
        // rounded comparison, which is the one thing this module never does.
        contracts: [
          {
            ...(definition.contracts[2] as SurvivalDefinition['contracts'][number]),
            profile: { laneFailure: rational(1n, 7n), entitySurvival: rational(1n, 2n) },
            multiplier: rational(7n, 3n),
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER' }));
  });

  it('refuses a cap declared unreachable that the arithmetic can reach', () => {
    // The exact maximum round return is 191/200 * 4^3 = 1528/25 = 61.12.
    expect(equal(maxRoundReturn(definition), rational(1528n, 25n))).toBe(true);
    expect(() =>
      defineSurvivalGame({
        ...definition,
        id: 'tight-v1',
        risk: { ...definition.risk, maxWinMultiple: 61n },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER' }));
    // 62 clears it, and declaring the cap reachable is always allowed.
    expect(
      defineSurvivalGame({
        ...definition,
        id: 'tight-v1',
        risk: { ...definition.risk, maxWinMultiple: 62n },
      }).risk.maxWinMultiple,
    ).toBe(62n);
    expect(
      defineSurvivalGame({
        ...definition,
        id: 'honest-v1',
        risk: { ...definition.risk, maxWinMultiple: 2n, capMustBeUnreachable: false },
      }).risk.maxWinMultiple,
    ).toBe(2n);
  });

  it('refuses duplicate contract ids and an empty menu at the full field', () => {
    expect(() =>
      defineSurvivalGame({
        ...definition,
        id: 'dup-v1',
        contracts: [
          definition.contracts[0] as SurvivalDefinition['contracts'][number],
          definition.contracts[0] as SurvivalDefinition['contracts'][number],
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER' }));
    expect(() =>
      defineSurvivalGame({
        ...definition,
        id: 'closed-v1',
        contracts: [
          {
            ...(definition.contracts[0] as SurvivalDefinition['contracts'][number]),
            minEntities: 5,
          },
        ],
        entities: 4,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER' }));
  });

  it('refuses a definition whose counterfactually complete tape exceeds the draw budget', () => {
    expect(() =>
      defineSurvivalGame({ ...definition, id: 'huge-v1', entities: 32, stages: 64 }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADAPTER' }));
  });

  it('refuses a definition it could not price, as an adapter defect and at define time', () => {
    // Every declared field here is legal on its own — the modulus is under
    // 2^256, `p * mu == 1` holds exactly, the entity and lane widths are inside
    // module limits — but `den(c)^laneWidth` and `mu^stages` are not declared
    // fields, they are derived ones, and they are what overflows.
    //
    // Regression: these used to be accepted, and the overflow then surfaced from
    // inside the rational primitives as `INVALID_RATIONAL` at the first
    // derivation. That reads as an engine arithmetic failure rather than as the
    // adapter defect it is, and it aborts a conformance run part way through.
    const wide = 1n << 250n;
    const overflowing: SurvivalDefinition = {
      ...definition,
      id: 'unpriceable-v1',
      entities: 32,
      stages: 1,
      drawModulus: wide,
      contracts: [
        {
          id: 'wide',
          label: 'Wide',
          laneWidth: 32,
          minEntities: 1,
          profile: { laneFailure: rational(0n, 1n), entitySurvival: rational(wide - 1n, wide) },
          multiplier: rational(wide, wide - 1n),
        },
      ],
      risk: { ...definition.risk, capMustBeUnreachable: false },
    };
    expect(() => defineSurvivalGame(overflowing)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ADAPTER', path: '$.contracts[0].profile' }),
    );
    // Narrowing the field to a single lane of one puts the survivor law back
    // inside the limit; the pricing chain is then the binding constraint, and it
    // is reported against the multiplier that raises it to the stage count.
    const narrow = 1n << 40n;
    const priceable = {
      ...overflowing,
      id: 'unpriceable-v2',
      entities: 1,
      stages: 64,
      drawModulus: narrow,
      contracts: [
        {
          ...(overflowing.contracts[0] as SurvivalDefinition['contracts'][number]),
          laneWidth: 1,
          profile: { laneFailure: rational(0n, 1n), entitySurvival: rational(narrow - 1n, narrow) },
          multiplier: rational(narrow, narrow - 1n),
        },
      ],
    };
    expect(() => defineSurvivalGame(priceable)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ADAPTER', path: '$.contracts[0].multiplier' }),
    );
    // Same declaration over three stages instead of sixty-four is priceable, so
    // the bound is a bound on the derived width and not a ban on wide rationals.
    expect(defineSurvivalGame({ ...priceable, id: 'priceable-v1', stages: 3 }).stages).toBe(3);
  });

  it('does not refuse a high-resolution adapter whose arithmetic actually fits', () => {
    // The bounds are sufficient rather than tight, so the risk they carry is a
    // *false* refusal. This is the case that pins how much slack is acceptable:
    // the whole 32-entity field in one lane, at 60-bit denominators — near the
    // edge of what the engine limit allows, and it must define and derive.
    const modulus = 1n << 60n;
    const highResolution: SurvivalDefinition = {
      ...definition,
      id: 'high-resolution-v1',
      entities: 32,
      stages: 1,
      drawModulus: modulus,
      contracts: [
        {
          id: 'wide',
          label: 'Wide',
          laneWidth: 32,
          minEntities: 1,
          profile: {
            laneFailure: rational(0n, 1n),
            entitySurvival: rational(modulus - 1n, modulus),
          },
          multiplier: rational(modulus, modulus - 1n),
        },
      ],
      risk: { ...definition.risk, capMustBeUnreachable: false },
    };
    const game = defineSurvivalGame(highResolution);
    const law = survivorDistribution(game, game.contracts[0] as never, 32);
    expect(law).toHaveLength(33);
    expect(equal(distributionTotal(law), rational(1n))).toBe(true);
    expect(
      equal(
        expectedSurvivorsFromDistribution(law),
        multiply(rational(32n), marginalSurvival(game.contracts[0] as never)),
      ),
    ).toBe(true);
  });

  it('bounds the lane size of the exported per-lane law by the contract width', () => {
    // `laneSurvivorDistribution` is reachable with an arbitrary size, and `c^j`
    // below it is a power: a validated contract with a wide denominator would
    // otherwise overflow the engine limit and raise `INVALID_RATIONAL` from the
    // rational primitives rather than refusing an out-of-range argument.
    const narrow = definition.contracts[2] as never;
    expect(laneSurvivorDistribution(narrow, 1)).toHaveLength(2);
    for (const size of [2, 100, -1, 1.5])
      expect(() => laneSurvivorDistribution(narrow, size)).toThrowError(
        expect.objectContaining({ code: 'INVALID_CHOICE' }),
      );
    // `lanePartition()` never produces a lane wider than the contract, so the
    // internal path is unaffected: width 3 at a field of 5 stays inside it.
    expect(laneSurvivorDistribution(definition.contracts[0] as never, 3)).toHaveLength(4);
  });

  it('fingerprints the enumerated lane sizes, not only the width that generates them', () => {
    const base = survivalFingerprint(definition);
    expect(base).toBe(survivalFingerprint(defineSurvivalGame({ ...definition })));
    // Same lane count for a field of five (2), different sizes: [3,2] vs [4,1].
    expect(
      laneSizes(definition.contracts[0] as SurvivalDefinition['contracts'][number], 5),
    ).toEqual([3, 2]);
    const rebalanced = defineSurvivalGame({
      ...definition,
      contracts: definition.contracts.map((contract, index) =>
        index === 0 ? { ...contract, laneWidth: 4 } : contract,
      ),
    });
    expect(
      laneSizes(rebalanced.contracts[0] as SurvivalDefinition['contracts'][number], 5),
    ).toEqual([4, 1]);
    expect(survivalFingerprint(rebalanced)).not.toBe(base);
    // Cosmetics stay out: renaming a contract must not change the game's identity.
    const relabelled = defineSurvivalGame({
      ...definition,
      contracts: definition.contracts.map((contract) => ({ ...contract, label: 'Renamed' })),
    });
    expect(survivalFingerprint(relabelled)).toBe(base);
  });

  it('moves the whole tape with the fingerprint, not only with the label', () => {
    // SWARM's §6.4 wants the derived grid to move with the definition
    // **fingerprint**. Two twins sharing an id, a version and a round — and
    // differing only in the hazards that decide what a draw *means* — used to
    // produce byte-identical tapes under one seed, because the sampler domain
    // was `definition.id`. The seed pre-commitment bound the fingerprint
    // independently, so no player could exploit it; the grid was still blind to
    // the fields that price it, and nothing in the repo would have noticed.
    const shared = {
      apiVersion: ENGINE_API_VERSION,
      id: 'twin-trial',
      version: '1.0.0',
      entities: 3,
      stages: 2,
      drawModulus: 1_200_000n,
      pricing: {
        entryReturn: rational(191n, 200n),
        continuationReturn: rational(1n),
        rounding: 'floor' as const,
      },
      risk: {
        maxWinMultiple: 1_000n,
        capBasis: 'round-external-stake' as const,
        capMustBeUnreachable: true,
      },
    };
    const twin = (
      laneFailure: Rational,
      entitySurvival: Rational,
      mu: Rational,
    ): SurvivalDefinition =>
      defineSurvivalGame({
        ...shared,
        contracts: [
          {
            id: 'only',
            label: 'Only',
            laneWidth: 1,
            minEntities: 1,
            profile: { laneFailure, entitySurvival },
            multiplier: mu,
          },
        ],
      });
    const left = twin(rational(1n, 2n), rational(1n, 2n), rational(4n, 1n));
    const right = twin(rational(1n, 4n), rational(2n, 3n), rational(2n, 1n));
    // Same id and version, so the old domain could not tell them apart.
    expect(left.id).toBe(right.id);
    expect(left.version).toBe(right.version);
    expect(survivalFingerprint(left)).not.toBe(survivalFingerprint(right));
    const roundId = roundIdFor('twin-round');
    expect(roundIdentityOf(left, roundId).definitionId).toBe(survivalFingerprint(left));
    expect(deriveTruth(seed(31), left, roundId).digest).not.toBe(
      deriveTruth(seed(31), right, roundId).digest,
    );
    // ...while a cosmetic edit still leaves the round byte-identical, which is
    // the property the fingerprint had all along and must keep.
    const relabelled = defineSurvivalGame({
      ...shared,
      contracts: left.contracts.map((contract) => ({ ...contract, label: 'Renamed' })),
    });
    expect(deriveTruth(seed(31), relabelled, roundId).digest).toBe(
      deriveTruth(seed(31), left, roundId).digest,
    );
  });

  it('declares an identity a host can persist in five parts', () => {
    expect(stagedSurvival.definitions.identity(definition)).toEqual({
      moduleId: 'staged-survival',
      moduleVersion: '1.0.0',
      definitionId: 'five-runner-trial-v1',
      definitionVersion: '1.0.0',
      fingerprint: survivalFingerprint(definition),
    });
    expect(definition.apiVersion).toBe(ENGINE_API_VERSION);
  });
});

describe('staged-survival: the round pair and the publication order', () => {
  it('round-trips the canonical round id and rejects a malformed one', () => {
    const canonical = roundIdFor('round-9');
    expect(parseRoundRefId(canonical)).toEqual({
      roundId: 'round-9',
      clientEntropy: ENTROPY,
    });
    for (const bad of [
      'round-9',
      `round-9|${'zz'.repeat(32)}`,
      `round-9|${'a1'.repeat(31)}`,
      `round|9|${ENTROPY}`,
      `|${ENTROPY}`,
      `${'x'.repeat(64)}|${ENTROPY}`,
      42,
      null,
    ])
      expect(() => parseRoundRefId(bad)).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONTEXT' }),
      );
    // Uppercase entropy is a different string, and the module does not coerce.
    expect(() => parseRoundRefId(`round-9|${ENTROPY.toUpperCase()}`)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONTEXT' }),
    );
  });

  it('exports the round-id budget ADR 0008 tells a host to check', () => {
    // ADR 0008 accepts a real ergonomic cost — the round pair rides inside the
    // contract's single `roundId: string`, so the operator half is narrower than
    // the engine's identifier bound — and names one mitigation: a host can check
    // the budget rather than discover it from a rejected round. That mitigation
    // is only real if the number is importable, and if it is the *true* edge.
    expect(MAX_ROUND_ID_BYTES).toBe(
      ENGINE_LIMITS.maxIdentifierBytes - SURVIVAL_LIMITS.clientEntropyBytes * 2 - 1,
    );
    expect(ROUND_REF_SEPARATOR).toBe('|');
    const atLimit = 'r'.repeat(MAX_ROUND_ID_BYTES);
    expect(parseRoundRefId(roundRefId({ roundId: atLimit, clientEntropy: ENTROPY }))).toEqual({
      roundId: atLimit,
      clientEntropy: ENTROPY,
    });
    // One byte past it fails, so the exported number is the boundary itself and
    // not an approximation of it.
    expect(() => roundRefId({ roundId: `${atLimit}r`, clientEntropy: ENTROPY })).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONTEXT' }),
    );
  });

  it('binds the entropy into every draw and out of the seed pre-commitment', () => {
    const first = deriveTruth(seed(21), definition, roundIdFor('r'));
    const second = deriveTruth(seed(21), definition, roundIdFor('r', 'b2'.repeat(32)));
    expect(first.digest).not.toBe(second.digest);
    expect(first.draws).toHaveLength(
      definition.stages * definition.contracts.length * definition.entities * 2,
    );
    // The pre-commitment is what proves the seed predates the entropy, so it
    // must be publishable before the entropy exists — which means it cannot
    // depend on it.
    const published = seedCommitment(
      seed(21),
      definition,
      roundIdentityOf(definition, roundIdFor('r')),
    );
    expect(
      seedCommitment(
        seed(21),
        definition,
        roundIdentityOf(definition, roundIdFor('r', 'b2'.repeat(32))),
      ),
    ).toBe(published);
    // ...and it is exactly core's seed sealing over the operator round id.
    expect(published).toBe(
      sealSeedCommitment(seed(21), {
        moduleId: 'staged-survival',
        definitionId: definition.id,
        definitionFingerprint: survivalFingerprint(definition),
        roundId: 'r',
        proofVersion: COMMITMENT_VERSION,
      }),
    );
    expect(
      seedCommitment(seed(22), definition, roundIdentityOf(definition, roundIdFor('r'))),
    ).not.toBe(published);
  });
});

describe('staged-survival: the tape is counterfactually complete', () => {
  it('derives the same tape whatever the player decides, and covers every route', () => {
    const roundId = roundIdFor('counterfactual');
    const truth = deriveTruth(seed(30), definition, roundId);
    const digest = truth.digest;
    // Every contract of the menu, at every stage, has its own lane and entity
    // draws: a decision selects which committed draws are read, never which
    // draws exist.
    for (const contractId of ['wide', 'split', 'narrow']) {
      const choices: SurvivalChoice[] = [{ contractId, banked: [] }];
      const steps = deriveSteps(definition, truth, choices);
      expect(steps).toHaveLength(1);
      expect(deriveTruth(seed(30), definition, roundId).digest).toBe(digest);
    }
    // Every draw is addressed exactly once, with the declared modulus.
    const addresses = new Set(truth.draws.map((draw) => `${draw.label}#${draw.counter}`));
    expect(addresses.size).toBe(truth.draws.length);
    for (const draw of truth.draws) {
      expect(draw.modulus).toBe(definition.drawModulus);
      expect(draw.value).toBeGreaterThanOrEqual(0n);
      expect(draw.value).toBeLessThan(definition.drawModulus);
    }
  });

  it('refuses a truth whose draws are not at their declared addresses', () => {
    const roundId = roundIdFor('forged');
    const truth = deriveTruth(seed(31), definition, roundId);
    const shortened = Object.freeze({ ...truth, draws: truth.draws.slice(0, 3) });
    expect(() =>
      deriveSteps(definition, shortened, [{ contractId: 'wide', banked: [] }]),
    ).toThrowError(expect.objectContaining({ code: 'DERIVATION_FAILED' }));
    const relabelled = Object.freeze({
      ...truth,
      draws: truth.draws.map((draw, index) => (index === 0 ? { ...draw, counter: 99 } : draw)),
    });
    expect(() =>
      deriveSteps(definition, relabelled, [{ contractId: 'wide', banked: [] }]),
    ).toThrowError(expect.objectContaining({ code: 'DERIVATION_FAILED' }));
  });

  it('refuses a decision the menu does not offer to the field it faces', () => {
    const roundId = roundIdFor('menu');
    const truth = deriveTruth(seed(32), definition, roundId);
    expect(contractMenu(definition, 5).map((contract) => contract.id)).toEqual([
      'wide',
      'split',
      'narrow',
    ]);
    expect(contractMenu(definition, 2).map((contract) => contract.id)).toEqual(['split', 'narrow']);
    expect(contractMenu(definition, 1).map((contract) => contract.id)).toEqual(['narrow']);
    expect(() =>
      deriveSteps(definition, truth, [{ contractId: 'wide', banked: [0, 1, 2] }]),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CHOICE' }));
    expect(() =>
      deriveSteps(definition, truth, [{ contractId: 'ghost', banked: [] }]),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CHOICE' }));
    // Banking the whole field leaves nothing to resolve, so no decision follows.
    expect(() =>
      deriveSteps(definition, truth, [{ contractId: 'narrow', banked: [0, 1, 2, 3, 4] }]),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CHOICE' }));
    // A banked subset must be running, ascending and distinct.
    expect(() =>
      deriveSteps(definition, truth, [{ contractId: 'narrow', banked: [1, 0] }]),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CHOICE' }));
  });
});

describe('staged-survival: property and metamorphic sweeps', () => {
  const seeds = Array.from({ length: 24 }, (_value, index) => seed(100 + index));

  it('keeps every step internally consistent with its own geometry', () => {
    for (const [index, seedHex] of seeds.entries()) {
      const roundId = roundIdFor(`sweep-${index}`);
      const truth = deriveTruth(seedHex, definition, roundId);
      const choices = ridePath(definition, truth);
      const steps = deriveSteps(definition, truth, choices);
      let field = [0, 1, 2, 3, 4];
      for (const step of steps) {
        const resolved = [...step.survivors, ...step.failed].sort((left, right) => left - right);
        expect(resolved).toEqual(field);
        expect(step.lanes.flatMap((lane) => [...lane.entities])).toEqual(field);
        const contract = definition.contracts.find(
          (candidate) => candidate.id === step.contractId,
        ) as SurvivalDefinition['contracts'][number];
        expect(step.lanes.map((lane) => lane.entities.length)).toEqual([
          ...laneSizes(contract, field.length),
        ]);
        for (const lane of step.lanes)
          if (lane.collapsed)
            for (const entity of lane.entities) expect(step.survivors).not.toContain(entity);
        field = [...step.survivors];
      }
    }
  });

  it('is metamorphic under an unchanged decision log and moves under a changed one', () => {
    for (const [index, seedHex] of seeds.slice(0, 8).entries()) {
      const roundId = roundIdFor(`meta-${index}`);
      const truth = deriveTruth(seedHex, definition, roundId);
      const choices = ridePath(definition, truth);
      const first = makeTranscript(seedHex, definition, roundId, choices);
      const again = makeTranscript(seedHex, definition, roundId, choices);
      expect(JSON.stringify(transcriptToWire(first))).toBe(JSON.stringify(transcriptToWire(again)));
      // Truncating the log truncates the transcript and nothing else: the tape
      // is untouched, and the shorter proof still verifies on its own.
      if (choices.length > 1) {
        const shorter = makeTranscript(seedHex, definition, roundId, choices.slice(0, -1));
        expect(shorter.tapeDigest).toBe(first.tapeDigest);
        expect(shorter.steps).toHaveLength(choices.length - 1);
        expect(shorter.commitment).not.toBe(first.commitment);
        expect(stagedSurvival.verify(seedHex, definition, transcriptToWire(shorter))).toMatchObject(
          { ok: true },
        );
      }
    }
  });

  it('accrues exactly stake x entryReturn x prod(mu) and eliminates to exactly zero', async () => {
    for (const [index, seedHex] of seeds.slice(0, 6).entries()) {
      const roundId = roundIdFor(`value-${index}`);
      const truth = deriveTruth(seedHex, definition, roundId);
      const choices = ridePath(definition, truth);
      const steps = deriveSteps(definition, truth, choices);
      const book = new SurvivalBook(definition, survivalAdmission(definition, seedHex, roundId));
      for (let entity = 0; entity < definition.entities; entity += 1)
        await book.enter(`e-${entity}`, entity, 1_000n);
      for (const [stage, choice] of choices.entries()) {
        await book.choose(`c-${stage}`, choice.contractId);
        await book.resolve(steps[stage] as SurvivalStep);
      }
      for (const claim of book.claims) {
        let expected: Rational = multiply(rational(1_000n), definition.pricing.entryReturn);
        let alive = true;
        for (const step of steps) {
          if (step.failed.includes(claim.entity)) alive = false;
          if (!alive) break;
          const contract = definition.contracts.find(
            (candidate) => candidate.id === step.contractId,
          ) as SurvivalDefinition['contracts'][number];
          expected = multiply(expected, contract.multiplier);
        }
        if (!alive) {
          // Elimination is exactly zero, never an epsilon.
          expect(claim.value).toEqual(rational(0n));
          expect(claim.live).toBe(false);
        } else {
          expect(equal(claim.value, expected)).toBe(true);
        }
      }
      const weights = belief(definition, steps);
      expect(weights.weights).toHaveLength(definition.entities + 1);
      const live = new Set((steps[steps.length - 1] as SurvivalStep | undefined)?.survivors ?? []);
      weights.weights.slice(0, definition.entities).forEach((weight, entity) => {
        expect(weight).toBe(live.has(entity) ? 1n : 0n);
      });
      expect(weights.weights[definition.entities]).toBe(live.size === 0 ? 1n : 0n);
    }
  });

  it('prices a claim at the exact marginal survival of its contract, and zero when dead', () => {
    const roundId = roundIdFor('price');
    const truth = deriveTruth(seed(60), definition, roundId);
    const steps = deriveSteps(definition, truth, [{ contractId: 'wide', banked: [] }]);
    const step = steps[0] as SurvivalStep;
    const alive = step.survivors[0];
    if (alive !== undefined)
      expect(
        equal(price(definition, steps, { entity: alive, contractId: 'narrow' }), rational(1n, 4n)),
      ).toBe(true);
    const dead = step.failed[0];
    if (dead !== undefined)
      expect(price(definition, steps, { entity: dead, contractId: 'narrow' })).toEqual(
        rational(0n),
      );
    // The marginal is a declaration of the profile, not of the lane geometry.
    expect(equal(marginalSurvival(definition.contracts[0] as never), rational(21n, 25n))).toBe(
      true,
    );
    expect(equal(marginalSurvival(definition.contracts[1] as never), rational(3n, 4n))).toBe(true);
    expect(equal(marginalSurvival(definition.contracts[2] as never), rational(1n, 4n))).toBe(true);
  });
});

describe('staged-survival: the round book', () => {
  async function openRound(
    game = definition,
    stake = 1_000n,
    seedHex = seed(1),
    roundId = roundIdFor('book-default'),
  ): Promise<SurvivalBook> {
    const book = new SurvivalBook(game, survivalAdmission(game, seedHex, roundId));
    for (let entity = 0; entity < game.entities; entity += 1)
      await book.enter(`enter-${entity}`, entity, stake);
    return book;
  }

  it('accumulates the cap basis across every externally funded entry', async () => {
    const book = await openRound();
    expect(book.capBasisStake).toBe(5_000n);
    expect(book.liquidBalance).toBe(0n);
    expect(book.claims.map((claim) => claim.entity)).toEqual([0, 1, 2, 3, 4]);
    expect(
      book.claims.every((claim) =>
        equal(claim.value, multiply(rational(1_000n), definition.pricing.entryReturn)),
      ),
    ).toBe(true);
  });

  it('refuses a decision before every entity is funded, and an entry after one', async () => {
    const book = new SurvivalBook(
      definition,
      survivalAdmission(definition, seed(1), roundIdFor('partial')),
    );
    await book.enter('enter-0', 0, 1_000n);
    await expect(book.choose('c', 'wide')).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
    for (let entity = 1; entity < 5; entity += 1)
      await book.enter(`enter-${entity}`, entity, 1_000n);
    await book.choose('c', 'wide');
    await expect(book.enter('late', 0, 1_000n)).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
    await expect(book.bank('b', [1])).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
  });

  it('refuses a bank before every entity is funded, so a credited round always restores', async () => {
    // Regression, and the reason `bank()` carries the same full-funding guard as
    // `choose()`. `enter(0) -> bank([0])` used to be accepted and to credit real
    // money, after which `enter(1..4)` was still legal — and `restore()` refuses
    // an `enter` receipt that follows a `bank` one, so the round became
    // permanently unreconnectable at that point and at every later point of its
    // life. No value leaked (the cap basis only grows, so an early bank is
    // measured against a strictly smaller ceiling); what leaked was availability.
    const book = new SurvivalBook(
      definition,
      survivalAdmission(definition, seed(1), roundIdFor('banking')),
    );
    await book.enter('enter-0', 0, 1_000_000n);
    await expect(book.bank('bank-early', [0])).rejects.toMatchObject({
      code: 'CLAIM_REJECTED',
      path: '$.claims',
    });
    expect(book.liquidBalance).toBe(0n);
    expect(SurvivalBook.restore(definition, book.snapshot()).liquidBalance).toBe(0n);

    for (let entity = 1; entity < definition.entities; entity += 1)
      await book.enter(`enter-${entity}`, entity, 1_000_000n);
    // The same subset, banked once the field is complete: 1,000,000 * 191/200.
    const receipt = await book.bank('bank-late', [0]);
    expect(receipt.credited).toBe(955_000n);
    expect(receipt.capped).toBe(false);
    expect(book.capBasisStake).toBe(5_000_000n);
    const restored = SurvivalBook.restore(definition, book.snapshot());
    expect(restored.liquidBalance).toBe(955_000n);
    expect(JSON.stringify(restored.snapshot())).toBe(JSON.stringify(book.snapshot()));
    // No entry can follow a credited bank, which is what makes `restore()`'s
    // receipt ordering rule agree with the live path. This is a *consequence*
    // and the assertion says only that, not that it discriminates: a bank cannot
    // run until every entity is funded, at which point every id is a duplicate.
    for (let entity = 0; entity < definition.entities; entity += 1)
      await expect(book.enter(`enter-late-${entity}`, entity, 1_000n)).rejects.toMatchObject({
        code: 'CLAIM_REJECTED',
      });
  });

  it('refuses a stake too wide for the round arithmetic, before it mutates anything', async () => {
    // The stake is the one input to `stake * entryReturn * prod(mu)` that is a
    // runtime argument rather than a declaration, and `enter()` used to check
    // only its sign. A stake wide enough to overflow that product was accepted
    // past `fundStake()` — which had already moved the cap basis and the entry
    // list — and then threw `INVALID_RATIONAL` while building the claim, leaving
    // an inflated basis, an entry with no claim, and no receipt. `restore()`
    // could not even parse the result: it threw `INVALID_RATIONAL` too.
    const book = new SurvivalBook(definition);
    const widest = (1n << BigInt(SURVIVAL_LIMITS.maxStakeBits)) - 1n;
    for (const stake of [widest + 1n, 1n << 4_090n]) {
      await expect(book.enter('too-wide', 0, stake)).rejects.toMatchObject({
        code: 'CLAIM_REJECTED',
        path: '$.stake',
      });
      // Nothing moved: no claim, no receipt, and above all no cap basis.
      expect(book.claims).toEqual([]);
      expect(book.capBasisStake).toBeUndefined();
      expect(book.ledgerRevision).toBe(0);
      expect(SurvivalBook.restore(definition, book.snapshot()).claims).toEqual([]);
    }
    // The boundary itself is legal, and the round it opens still restores.
    book.bindRound(survivalAdmission(definition, seed(1), roundIdFor('wide-stake')));
    for (let entity = 0; entity < definition.entities; entity += 1)
      await book.enter(`wide-${entity}`, entity, widest);
    expect(book.capBasisStake).toBe(widest * BigInt(definition.entities));
    expect(SurvivalBook.restore(definition, book.snapshot()).capBasisStake).toBe(
      book.capBasisStake,
    );
  });

  it('replays an exact retry and refuses a changed payload under the same key', async () => {
    const book = await openRound();
    const first = await book.choose('choose-0', 'wide');
    const retry = await book.choose('choose-0', 'wide');
    expect(retry).toEqual(first);
    await expect(book.choose('choose-0', 'narrow')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('refuses a step that does not resolve the decision it was fenced to', async () => {
    const roundId = roundIdFor('fence');
    const truth = deriveTruth(seed(70), definition, roundId);
    const book = await openRound(definition, 1_000n, seed(70), roundId);
    await book.choose('choose-0', 'wide');
    const wide = deriveSteps(definition, truth, [
      { contractId: 'wide', banked: [] },
    ])[0] as SurvivalStep;
    const narrow = deriveSteps(definition, truth, [
      { contractId: 'narrow', banked: [] },
    ])[0] as SurvivalStep;
    await expect(book.resolve(narrow)).rejects.toMatchObject({ code: 'TRANSCRIPT_MISMATCH' });
    await expect(book.resolve({ ...wide, index: 3 })).rejects.toMatchObject({
      code: 'STALE_FRAME',
    });
    // A step that resolves the wrong field must leave the book untouched, not
    // half-applied: the check runs before the first claim is mutated.
    const before = JSON.stringify(book.snapshot());
    const shifted = {
      ...wide,
      survivors: wide.survivors.slice(1),
      failed: [...wide.failed, wide.survivors[0] ?? 0].sort((left, right) => left - right),
    };
    await expect(
      book.resolve({ ...shifted, survivors: [...shifted.survivors, 99] }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPT_MISMATCH' });
    expect(JSON.stringify(book.snapshot())).toBe(before);

    await book.resolve(wide);
    expect(book.stageRevision).toBe(1);
    // The stored step is a frozen canonical copy, so a caller that kept a
    // reference cannot rewrite a settled round's history through it.
    expect(Object.isFrozen(book.steps[0])).toBe(true);
    expect(Object.isFrozen(book.steps[0]?.survivors)).toBe(true);
  });

  it('folds the banked subset into the decision it precedes', async () => {
    const roundId = roundIdFor('fold');
    const truth = deriveTruth(seed(71), definition, roundId);
    const book = await openRound(definition, 1_000n, seed(72), roundId);
    await book.choose('choose-0', 'wide');
    const first = makeTranscript(seed(71), definition, roundId, book.choices);
    await book.resolve(first.steps[0] as SurvivalStep);
    const live = [...book.live];
    if (live.length < 2) return;
    await book.bank('bank-0', [live[0] as number]);
    await book.choose('choose-1', book.menu()[0] as string);
    expect(book.choices[1]?.banked).toEqual([live[0]]);
    const second = makeTranscript(seed(71), definition, roundId, book.choices);
    expect(second.steps[1]?.banked).toEqual([live[0]]);
    // ...and the withdrawn entity is not in the field the stage resolves.
    expect(second.steps[1]?.survivors).not.toContain(live[0]);
    expect(second.steps[1]?.failed).not.toContain(live[0]);
    expect(deriveTruth(seed(71), definition, roundId).digest).toBe(truth.digest);
  });

  it('refuses a settlement proof built from a different decision log', async () => {
    const roundId = roundIdFor('settle-log');
    const book = await openRound(definition, 1_000n, seed(72), roundId);
    await book.choose('choose-0', 'wide');
    const mine = makeTranscript(seed(72), definition, roundId, book.choices);
    await book.resolve(mine.steps[0] as SurvivalStep);
    const foreign = makeTranscript(seed(72), definition, roundId, [
      { contractId: 'narrow', banked: [] },
    ]);
    // The foreign proof verifies perfectly on its own; it is simply not the
    // proof of the round this book played.
    expect(stagedSurvival.verify(seed(72), definition, transcriptToWire(foreign))).toMatchObject({
      ok: true,
    });
    await expect(book.settle('settle-0', seed(72), foreign)).rejects.toMatchObject({
      code: 'TRANSCRIPT_MISMATCH',
    });
    await expect(book.settle('settle-1', seed(73), mine)).rejects.toMatchObject({
      code: 'INVALID_TRANSCRIPT',
    });
    const receipt = await book.settle('settle-2', seed(72), mine);
    expect(book.terminal).toBe(true);
    expect(receipt.action).toBe('settle');
    await expect(book.bank('after', [0])).rejects.toMatchObject({ code: 'ROUND_TERMINAL' });
  });

  it('does not replay a successful settlement when the same key carries another seed', async () => {
    const roundId = roundIdFor('settle-seed-idempotency');
    const seedHex = seed(172);
    const book = await openRound(definition, 1_000n, seedHex, roundId);
    await book.choose('choose-0', 'wide');
    const transcript = makeTranscript(seedHex, definition, roundId, book.choices);
    await book.resolve(transcript.steps[0] as SurvivalStep);
    const first = await book.settle('settle', seedHex, transcript);
    expect(first.action).toBe('settle');
    await expect(book.settle('settle', seed(173), transcript)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('refuses a settlement while a logged decision is still unresolved', async () => {
    const roundId = roundIdFor('pending');
    const book = await openRound(definition, 1_000n, seed(74), roundId);
    await book.choose('choose-0', 'wide');
    const transcript = makeTranscript(seed(74), definition, roundId, book.choices);
    await expect(book.settle('settle', seed(74), transcript)).rejects.toMatchObject({
      code: 'CLAIM_REJECTED',
    });
  });

  it('pins the re-derived staked snapshot against a genuinely driven round', async () => {
    const seedHex = seed(80);
    const roundId = roundIdFor('pinned');
    const derived = stakedSnapshotFor(definition, seedHex, roundId);
    const book = new SurvivalBook(definition, survivalAdmission(definition, seedHex, roundId));
    // The same idempotency keys the re-derivation uses: they are part of the
    // receipt, so a comparison that let them differ would be comparing a
    // payload `restore()` never sees.
    for (let entity = 0; entity < definition.entities; entity += 1)
      await book.enter(`staked-enter-${entity}`, entity, 1_000n);
    await book.choose('staked-choose-0', (derived.choices[0] as SurvivalChoice).contractId);
    const transcript = makeTranscript(seedHex, definition, roundId, book.choices);
    await book.resolve(transcript.steps[0] as SurvivalStep);
    const banked = (derived.steps[0] as SurvivalStep).survivors[0];
    if (banked !== undefined) await book.bank('staked-bank-0', [banked]);
    const driven = JSON.parse(JSON.stringify(book.snapshot())) as Record<string, unknown>;
    const rebuilt = JSON.parse(JSON.stringify(derived.snapshot)) as Record<string, unknown>;
    // Field for field, including the receipt log and the checksum: a conformance
    // check that re-derives a payload `restore()` would reject for the wrong
    // reason proves nothing.
    for (const key of Object.keys(rebuilt).sort()) {
      const drivenReceipts = driven[key];
      expect({ [key]: drivenReceipts }).toEqual({ [key]: rebuilt[key] });
    }
    expect(driven).toEqual(rebuilt);
  });

  it('round-trips a snapshot at every point of a full round', async () => {
    const seedHex = seed(81);
    const roundId = roundIdFor('roundtrip');
    const book = await openRound(definition, 1_000n, seedHex, roundId);
    const check = (): void => {
      const snapshot = book.snapshot();
      const restored = SurvivalBook.restore(definition, snapshot);
      expect(JSON.parse(JSON.stringify(restored.snapshot()))).toEqual(
        JSON.parse(JSON.stringify(snapshot)),
      );
      expect(restored.liquidBalance).toBe(book.liquidBalance);
      expect(restored.capBasisStake).toBe(book.capBasisStake);
      expect(restored.live).toEqual(book.live);
    };
    check();
    for (let stage = 0; stage < definition.stages; stage += 1) {
      if (stage > 0 && book.live.length > 1) {
        await book.bank(`bank-${stage}`, [book.live[0] as number]);
        check();
      }
      // The contract is read off the menu the *banked* field offers, at the
      // moment of the decision. Picking it from a path derived without banking
      // would be picking from a different round: banking shrinks the field, and
      // a contract on the menu before the bank need not still be on it after.
      const menu = book.menu();
      if (menu.length === 0) break;
      await book.choose(`choose-${stage}`, menu[0] as string);
      check();
      const transcript = makeTranscript(seedHex, definition, roundId, book.choices);
      await book.resolve(transcript.steps[stage] as SurvivalStep);
      check();
      if (book.live.length === 0) break;
    }
    const transcript = makeTranscript(seedHex, definition, roundId, book.choices);
    await book.settle('settle', seedHex, transcript);
    check();
  });

  it('carries the oracle reference through a whole round too', async () => {
    const seedHex = seed(90);
    const roundId = roundIdFor('oracle-book');
    const truth = deriveTruth(seedHex, oracleTrialReference, roundId);
    const choices = ridePath(oracleTrialReference, truth);
    const book = await openRound(oracleTrialReference, 500n, seedHex, roundId);
    expect(book.capBasisStake).toBe(1_500n);
    for (const [stage, choice] of choices.entries()) {
      await book.choose(`choose-${stage}`, choice.contractId);
      const transcript = makeTranscript(seedHex, oracleTrialReference, roundId, book.choices);
      await book.resolve(transcript.steps[stage] as SurvivalStep);
    }
    const transcript = makeTranscript(seedHex, oracleTrialReference, roundId, book.choices);
    await book.settle('settle', seedHex, transcript);
    expect(book.terminal).toBe(true);
    expect(book.liquidBalance).toBeLessThanOrEqual(
      1_500n * oracleTrialReference.risk.maxWinMultiple,
    );
  });
});
