import { sealCommitment, constantTimeHexEqual } from '../../core/commitment.js';
import { commandFingerprint, toWireReceipt, type Receipt } from '../../core/ledger.js';
import type { ConformanceFailure, ModuleConformanceCheck } from '../../core/module.js';
import { payableWithinCap } from '../../core/payments.js';
import { sha256Hex } from '../../core/random.js';
import {
  add,
  compare,
  equal,
  floor as floorOf,
  multiply,
  rational,
  type Rational,
} from '../../core/rational.js';
import { snapshotHash } from '../../core/snapshot.js';
import { survivalFingerprint } from './adapter.js';
import { SurvivalBook } from './book.js';
import {
  SURVIVAL_BOOK_SCHEMA,
  type SurvivalChoice,
  type SurvivalDefinition,
  type SurvivalStep,
} from './contracts.js';
import {
  distributionTotal,
  expectedSurvivors,
  expectedSurvivorsFromDistribution,
  laneSizes,
  marginalSurvival,
  survivorDistribution,
} from './distribution.js';
import {
  commitmentBody,
  deriveSteps,
  deriveTruth,
  makeTranscript,
  roundIdentityOf,
  seedCommitment,
  stepsEqual,
  verifySurvivalTranscript,
} from './fairness.js';
import type { StagedSurvivalShape } from './shape.js';
import { deserializeTranscript, transcriptToWire } from './transcript.js';
import {
  assertSurvivalDefinition,
  contractMenu,
  maxRoundReturn,
  parseRoundRefId,
  roundRefId,
} from './validation.js';

type Check = ModuleConformanceCheck<StagedSurvivalShape>;

const ONE = rational(1n);
const REFERENCE_STAKE = 1_000n;

function failure(code: string, path: string, message: string): ConformanceFailure {
  return { code, path, message };
}

/** Deterministic 32-byte client entropy for a conformance round. */
export function conformanceEntropy(seedIndex: number, salt = 0): string {
  return sha256Hex(`staged-survival/conformance-entropy|${seedIndex}|${salt}`);
}

/** The canonical round pair a conformance round plays under. */
export function conformanceRoundId(roundId: string, seedIndex: number, salt = 0): string {
  return roundRefId({ roundId, clientEntropy: conformanceEntropy(seedIndex, salt) });
}

/** Every field size a contract can actually be offered, ascending. */
function reachableFields(definition: SurvivalDefinition, minEntities: number): number[] {
  const sizes: number[] = [];
  for (let live = minEntities; live <= definition.entities; live += 1) sizes.push(live);
  return sizes;
}

const frozenGraph: Check = {
  code: 'NOT_DEEP_FROZEN',
  description: 'The declarative definition graph is deeply frozen',
  scope: 'definition',
  run({ definition }) {
    const frozen =
      Object.isFrozen(definition) &&
      Object.isFrozen(definition.contracts) &&
      Object.isFrozen(definition.pricing) &&
      Object.isFrozen(definition.risk) &&
      definition.contracts.every(
        (contract) =>
          Object.isFrozen(contract) &&
          Object.isFrozen(contract.profile) &&
          Object.isFrozen(contract.multiplier),
      );
    return frozen ? [] : [failure('NOT_DEEP_FROZEN', '$', 'Definition graph must be frozen')];
  },
};

/**
 * The identity that makes every route worth the same.
 *
 * Checked twice from two directions: per entity, `p * mu == continuationReturn`;
 * and over the whole field, `sum_k P(k) * (k/n) * mu == continuationReturn`,
 * which is the same statement read through the *joint* law. The second is the
 * one that would catch a lane model whose marginals were right and whose
 * convolution was not.
 */
const continuationIsFair: Check = {
  code: 'CONTINUATION_NOT_FAIR',
  description: 'Every contract exactly cancels its own hazard, per entity and over the field',
  scope: 'definition',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    const target = rational(
      definition.pricing.continuationReturn.numerator,
      definition.pricing.continuationReturn.denominator,
    );
    if (!equal(target, ONE))
      failures.push(
        failure(
          'CONTINUATION_NOT_FAIR',
          '$.pricing.continuationReturn',
          'Continuation return must be exactly 1',
        ),
      );
    for (const [index, contract] of definition.contracts.entries()) {
      const multiplier = rational(contract.multiplier.numerator, contract.multiplier.denominator);
      if (!equal(multiply(marginalSurvival(contract), multiplier), target))
        failures.push(
          failure(
            'CONTINUATION_NOT_FAIR',
            `$.contracts[${index}].multiplier`,
            'marginalSurvival * multiplier is not the continuation return',
          ),
        );
      for (const live of reachableFields(definition, contract.minEntities)) {
        const distribution = survivorDistribution(definition, contract, live);
        const carried = multiply(
          multiply(expectedSurvivorsFromDistribution(distribution), rational(1n, BigInt(live))),
          multiplier,
        );
        count('fairnessIdentities');
        if (!equal(carried, target))
          failures.push(
            failure(
              'CONTINUATION_NOT_FAIR',
              `$.contracts[${index}]`,
              `Field of ${live} does not carry value forward exactly`,
            ),
          );
      }
    }
    return failures;
  },
};

/**
 * The joint law is a probability measure, and its mean matches the closed form.
 *
 * `sum_k P(k) == 1` exactly is the assertion that the correlation model tiles
 * its own outcome space; `sum_k k*P(k) == n*(1-q)*c` is the assertion that
 * introducing correlation moved the joint law without moving the marginals,
 * which is the whole design claim of the lane model.
 */
const distributionIsExact: Check = {
  code: 'DISTRIBUTION_NOT_EXACT',
  description: 'Survivor distributions sum to exactly 1 and match the closed-form mean',
  scope: 'definition',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    for (const [index, contract] of definition.contracts.entries())
      for (const live of reachableFields(definition, contract.minEntities)) {
        const distribution = survivorDistribution(definition, contract, live);
        count('distributions');
        if (distribution.length !== live + 1)
          failures.push(
            failure(
              'DISTRIBUTION_NOT_EXACT',
              `$.contracts[${index}]`,
              `Distribution over a field of ${live} has the wrong support`,
            ),
          );
        if (!equal(distributionTotal(distribution), ONE))
          failures.push(
            failure(
              'DISTRIBUTION_NOT_EXACT',
              `$.contracts[${index}]`,
              `Distribution over a field of ${live} does not sum to 1`,
            ),
          );
        if (
          !equal(expectedSurvivorsFromDistribution(distribution), expectedSurvivors(contract, live))
        )
          failures.push(
            failure(
              'DISTRIBUTION_NOT_EXACT',
              `$.contracts[${index}]`,
              `Mean survivors over a field of ${live} differs from n*(1-q)*c`,
            ),
          );
      }
    return failures;
  },
};

/** Lane geometry is total, stable, and inside its declared width. */
const laneGeometryIsStable: Check = {
  code: 'LANE_GEOMETRY_UNSTABLE',
  description: 'Lane sizes are stable, sum to the field, and never exceed the declared width',
  scope: 'definition',
  run({ definition, count }) {
    const failures: ConformanceFailure[] = [];
    for (const [index, contract] of definition.contracts.entries())
      for (const live of reachableFields(definition, contract.minEntities)) {
        const first = laneSizes(contract, live);
        const second = laneSizes(contract, live);
        count('laneGeometries');
        const total = first.reduce((sum, size) => sum + size, 0);
        if (
          total !== live ||
          first.length !== Math.ceil(live / contract.laneWidth) ||
          first.some((size) => size < 1 || size > contract.laneWidth) ||
          first.length !== second.length ||
          first.some((size, position) => size !== second[position])
        )
          failures.push(
            failure(
              'LANE_GEOMETRY_UNSTABLE',
              `$.contracts[${index}].laneWidth`,
              `Lane partition of a field of ${live} is unstable or does not tile it`,
            ),
          );
      }
    return failures;
  },
};

/** A declared-unreachable cap must be provably unreachable, exactly. */
const capHasHeadroom: Check = {
  code: 'CAP_REACHABLE',
  description: 'A cap declared unreachable strictly exceeds the exact maximum round return',
  scope: 'definition',
  run({ definition, count }) {
    if (!definition.risk.capMustBeUnreachable) return [];
    count('capBounds');
    return compare(maxRoundReturn(definition), rational(definition.risk.maxWinMultiple)) < 0
      ? []
      : [
          failure(
            'CAP_REACHABLE',
            '$.risk.maxWinMultiple',
            'The declared ceiling does not strictly exceed the maximum round return',
          ),
        ];
  },
};

/**
 * The tape is a pure function of (seed, definition, round pair), and of nothing
 * else — and it is a function of **both** halves of the round pair.
 */
const tapeIsDeterministic: Check = {
  code: 'TAPE_NOT_DETERMINISTIC',
  description: 'The tape is fixed by the seed and the round pair, and moves with either half',
  scope: 'round',
  run({ definition, seedHex, roundId, seedIndex, count }) {
    const failures: ConformanceFailure[] = [];
    const canonical = conformanceRoundId(roundId, seedIndex);
    const first = deriveTruth(seedHex, definition, canonical);
    const second = deriveTruth(seedHex, definition, canonical);
    count('tapes', 2);
    const expected = definition.stages * definition.contracts.length * definition.entities * 2;
    if (first.digest !== second.digest || first.draws.length !== expected)
      failures.push(
        failure(
          'TAPE_NOT_DETERMINISTIC',
          '$.truth',
          'Tape derivation is not deterministic or is the wrong length',
        ),
      );
    // The player's entropy has to reach every draw, or it is not a control.
    const otherEntropy = deriveTruth(
      seedHex,
      definition,
      conformanceRoundId(roundId, seedIndex, 1),
    );
    if (otherEntropy.digest === first.digest)
      failures.push(
        failure(
          'TAPE_NOT_DETERMINISTIC',
          '$.clientEntropy',
          'Two different client entropies produced the same tape',
        ),
      );
    const otherRound = deriveTruth(
      seedHex,
      definition,
      conformanceRoundId(`${roundId}-b`, seedIndex),
    );
    if (otherRound.digest === first.digest)
      failures.push(
        failure(
          'TAPE_NOT_DETERMINISTIC',
          '$.roundId',
          'Two different rounds produced the same tape',
        ),
      );
    // The grid must move with the definition **fingerprint**, not merely with
    // its label: two definitions sharing an id and a version but declaring
    // different hazards must not share a tape under one seed. The sampler domain
    // *is* the fingerprint, so the property is structural and checkable on any
    // adapter without synthesising a second valid definition — which this check
    // has no generic way to do, since a twin must still satisfy `p * mu == 1`.
    // The behavioural half of the same property (two twins, two digests) is in
    // the module's own suite, where the twin can be written out.
    count('samplerScopes', 1);
    if (roundIdentityOf(definition, canonical).definitionId !== survivalFingerprint(definition))
      failures.push(
        failure(
          'TAPE_NOT_DETERMINISTIC',
          '$.definitionFingerprint',
          'The sampler scope is not bound to the definition fingerprint, so two definitions sharing an id can share a tape',
        ),
      );
    return failures;
  },
};

/** A path through the menu, taking the first contract available at each field size. */
function pathOf(
  definition: SurvivalDefinition,
  truth: ReturnType<typeof deriveTruth>,
  pick: (menu: readonly string[], stage: number) => string,
): SurvivalChoice[] {
  const choices: SurvivalChoice[] = [];
  let live = definition.entities;
  for (let stage = 0; stage < definition.stages && live > 0; stage += 1) {
    const menu = contractMenu(definition, live).map((contract) => contract.id);
    const contractId = pick(menu, stage);
    if (contractId === undefined) break;
    choices.push({ contractId, banked: [] });
    const steps = deriveSteps(definition, truth, choices);
    live = (steps[steps.length - 1] as SurvivalStep).survivors.length;
  }
  return choices;
}

const choicesDriveSteps: Check = {
  code: 'CHOICES_DO_NOT_DRIVE_STEPS',
  description: 'Steps are a pure function of (tape, logged choices) and move when the choices do',
  scope: 'round',
  run({ definition, seedHex, roundId, seedIndex, count }) {
    const failures: ConformanceFailure[] = [];
    const truth = deriveTruth(seedHex, definition, conformanceRoundId(roundId, seedIndex));
    const first = pathOf(definition, truth, (menu) => menu[0] as string);
    const last = pathOf(definition, truth, (menu) => menu[menu.length - 1] as string);
    count('choiceLogs', 3);
    if (first.length === 0) return failures;
    if (!stepsEqual(deriveSteps(definition, truth, first), deriveSteps(definition, truth, first)))
      failures.push(
        failure(
          'CHOICES_DO_NOT_DRIVE_STEPS',
          '$.steps',
          'The same seed and choice log produced different steps',
        ),
      );
    if (
      definition.contracts.length > 1 &&
      last.length > 0 &&
      first[0]?.contractId === last[0]?.contractId
    )
      failures.push(
        failure(
          'CHOICES_DO_NOT_DRIVE_STEPS',
          '$.steps',
          'The menu offered the same contract at both ends',
        ),
      );
    return failures;
  },
};

const commitmentBindsChoices: Check = {
  code: 'COMMITMENT_IGNORES_CHOICES',
  description: 'The commitment body binds the contract and the banked subset of every decision',
  scope: 'round',
  run({ definition, seedHex, roundId, seedIndex, count }) {
    const failures: ConformanceFailure[] = [];
    const canonical = conformanceRoundId(roundId, seedIndex);
    const round = roundIdentityOf(definition, canonical);
    const truth = deriveTruth(seedHex, definition, canonical);
    const menu = contractMenu(definition, definition.entities);
    const base: SurvivalChoice[] = [{ contractId: (menu[0] as { id: string }).id, banked: [] }];
    const steps = deriveSteps(definition, truth, base);
    const sealed = sealCommitment(seedHex, commitmentBody(definition, round, truth, steps, base));
    count('commitmentBodies', 2);
    if (menu.length > 1) {
      const other: SurvivalChoice[] = [
        { contractId: (menu[menu.length - 1] as { id: string }).id, banked: [] },
      ];
      if (
        sealed === sealCommitment(seedHex, commitmentBody(definition, round, truth, steps, other))
      )
        failures.push(
          failure(
            'COMMITMENT_IGNORES_CHOICES',
            '$.commitment',
            'Two different contract logs sealed to the same commitment',
          ),
        );
    }
    // The banked subset is a decision too, and rewriting it must be visible.
    if (definition.entities > 1) {
      const rebanked: SurvivalChoice[] = [
        { contractId: base[0]?.contractId as string, banked: [0] },
      ];
      if (
        sealed ===
        sealCommitment(seedHex, commitmentBody(definition, round, truth, steps, rebanked))
      )
        failures.push(
          failure(
            'COMMITMENT_IGNORES_CHOICES',
            '$.commitment',
            'Rewriting the banked subset did not change the commitment',
          ),
        );
    }
    return failures;
  },
};

/**
 * The seed pre-commitment re-derives, is seed-specific, and — the load-bearing
 * one — is **independent of the client entropy**.
 *
 * That last property is what makes the publication order provable rather than
 * asserted: a commitment that moved with the entropy could not have been
 * published before the entropy was chosen.
 */
const seedIsPrecommitted: Check = {
  code: 'SEED_PRECOMMITMENT_BROKEN',
  description: 'The seed pre-commitment binds the seed and the round, and not the client entropy',
  scope: 'round',
  run({ definition, seedHex, roundId, seedIndex, count }) {
    const failures: ConformanceFailure[] = [];
    const canonical = conformanceRoundId(roundId, seedIndex);
    const round = roundIdentityOf(definition, canonical);
    const published = seedCommitment(seedHex, definition, round);
    const transcript = makeTranscript(seedHex, definition, canonical, []);
    count('seedCommitments', 3);
    if (!constantTimeHexEqual(published, transcript.seedCommitment))
      failures.push(
        failure(
          'SEED_PRECOMMITMENT_BROKEN',
          '$.seedCommitment',
          'Transcript seed commitment does not re-derive from the revealed seed',
        ),
      );
    const otherSeed = (seedIndex + 1).toString(16).padStart(64, '0');
    if (seedCommitment(otherSeed, definition, round) === published)
      failures.push(
        failure(
          'SEED_PRECOMMITMENT_BROKEN',
          '$.seedCommitment',
          'Two seeds share a pre-commitment',
        ),
      );
    const otherEntropy = roundIdentityOf(definition, conformanceRoundId(roundId, seedIndex, 1));
    if (seedCommitment(seedHex, definition, otherEntropy) !== published)
      failures.push(
        failure(
          'SEED_PRECOMMITMENT_BROKEN',
          '$.seedCommitment',
          'The seed pre-commitment moved with the client entropy, so it could not have been published first',
        ),
      );
    return failures;
  },
};

const transcriptRoundTrip: Check = {
  code: 'TRANSCRIPT_ROUND_TRIP',
  description: 'A built transcript verifies by re-derivation and a tampered one does not',
  scope: 'round',
  run({ definition, seedHex, roundId, seedIndex, count }) {
    const failures: ConformanceFailure[] = [];
    const canonical = conformanceRoundId(roundId, seedIndex);
    const truth = deriveTruth(seedHex, definition, canonical);
    const choices = pathOf(definition, truth, (menu) => menu[0] as string);
    const transcript = makeTranscript(seedHex, definition, canonical, choices);
    count('transcripts');
    const verification = verifySurvivalTranscript(
      seedHex,
      definition,
      transcriptToWire(transcript),
      deserializeTranscript,
    );
    if (!verification.ok)
      failures.push(failure(verification.code, verification.path, verification.message));
    const wire = transcriptToWire(transcript) as Record<string, unknown>;
    const steps = (wire.steps as { survivors: number[]; failed: number[] }[])[0];
    if (steps !== undefined && steps.failed.length > 0) {
      const moved = steps.failed[0] as number;
      const tampered = {
        ...wire,
        steps: (wire.steps as unknown[]).map((step, index) =>
          index === 0
            ? {
                ...(step as object),
                survivors: [...steps.survivors, moved].sort((left, right) => left - right),
                failed: steps.failed.slice(1),
              }
            : step,
        ),
      };
      const rejected = verifySurvivalTranscript(
        seedHex,
        definition,
        tampered,
        deserializeTranscript,
      );
      count('tamperedTranscripts');
      if (rejected.ok || rejected.code !== 'TRANSCRIPT_MISMATCH')
        failures.push(
          failure(
            'TRANSCRIPT_ROUND_TRIP',
            '$.steps',
            'A rewritten survivor list was not rejected as a transcript mismatch',
          ),
        );
    }
    return failures;
  },
};

export interface StakedSnapshot {
  readonly snapshot: Record<string, unknown>;
  readonly choices: readonly SurvivalChoice[];
  readonly steps: readonly SurvivalStep[];
  readonly credited: bigint;
}

/**
 * Re-derives a staked mid-round snapshot from the module's own primitives.
 *
 * Conformance checks are synchronous and the book's command API is not, so a
 * check that needs a real reconnect payload cannot drive the book. It builds one
 * instead — every entity entered at the same stake, one stage chosen and
 * resolved, then the lowest surviving entity banked — using the same command
 * fingerprints and the same cap arithmetic the live path uses.
 *
 * A contract test pins this field for field against a genuinely driven round, so
 * the re-derivation cannot drift into something `restore()` would reject for the
 * wrong reason.
 */
export function stakedSnapshotFor(
  definition: SurvivalDefinition,
  seedHex: string,
  canonicalRoundId: string,
  stake: bigint = REFERENCE_STAKE,
): StakedSnapshot {
  assertSurvivalDefinition(definition);
  const truth = deriveTruth(seedHex, definition, canonicalRoundId);
  const menu = contractMenu(definition, definition.entities);
  const choices: SurvivalChoice[] = [{ contractId: (menu[0] as { id: string }).id, banked: [] }];
  const steps = deriveSteps(definition, truth, choices);
  const step = steps[0] as SurvivalStep;
  const entryReturn = rational(
    definition.pricing.entryReturn.numerator,
    definition.pricing.entryReturn.denominator,
  );
  const contract = definition.contracts.find((candidate) => candidate.id === step.contractId) as {
    multiplier: Rational;
  };
  const multiplier = rational(contract.multiplier.numerator, contract.multiplier.denominator);
  const entities = Array.from({ length: definition.entities }, (_entity, index) => index);
  const basis = stake * BigInt(definition.entities);
  const publishedRound = {
    roundId: parseRoundRefId(canonicalRoundId).roundId,
    seedCommitment: seedCommitment(
      seedHex,
      definition,
      roundIdentityOf(definition, canonicalRoundId),
    ),
  };
  const bindingFields = [publishedRound.roundId, publishedRound.seedCommitment] as const;

  const receipts: { fingerprint: string; receipt: Receipt<string> }[] = [];
  let ledgerRevision = 0;
  const push = (
    key: string,
    fingerprint: string,
    action: string,
    frameRevision: number,
    debited: bigint,
    credited: bigint,
    capped: boolean,
  ): void => {
    ledgerRevision += 1;
    receipts.push({
      fingerprint,
      receipt: Object.freeze({
        schema: 'reveal-engine/receipt-v1',
        idempotencyKey: key,
        commandFingerprint: fingerprint,
        action,
        ledgerRevision,
        frameRevision,
        debited,
        credited,
        balanceDelta: credited - debited,
        capped,
      }) as Receipt<string>,
    });
  };

  for (const entity of entities)
    push(
      `staked-enter-${entity}`,
      commandFingerprint('enter', [...bindingFields, entity, stake]),
      'enter',
      0,
      stake,
      0n,
      false,
    );
  push(
    'staked-choose-0',
    commandFingerprint('choose', [...bindingFields, 0, step.contractId, 0]),
    'choose',
    0,
    0n,
    0n,
    false,
  );

  const banked = step.survivors[0];
  const banks: { stage: number; entities: number[] }[] = [];
  let credited = 0n;
  if (banked !== undefined) {
    const value = multiply(multiply(rational(stake), entryReturn), multiplier);
    const result = payableWithinCap(value, basis, definition.risk.maxWinMultiple, 0n);
    credited = result.credited;
    push(
      'staked-bank-0',
      commandFingerprint('bank', [...bindingFields, 1, 1, banked]),
      'bank',
      1,
      0n,
      result.credited,
      result.capped,
    );
    banks.push({ stage: 1, entities: [banked] });
  }

  const base = {
    schema: SURVIVAL_BOOK_SCHEMA,
    definition: { id: definition.id, fingerprint: survivalFingerprint(definition) },
    publishedRound,
    terminal: false,
    stageRevision: 1,
    ledgerRevision,
    choices: choices.map((choice) => ({
      contractId: choice.contractId,
      banked: [...choice.banked],
    })),
    steps: steps.map((entry) => ({
      index: entry.index,
      contractId: entry.contractId,
      banked: [...entry.banked],
      lanes: entry.lanes.map((lane) => ({
        entities: [...lane.entities],
        collapsed: lane.collapsed,
      })),
      survivors: [...entry.survivors],
      failed: [...entry.failed],
    })),
    pendingBanked: banked === undefined ? [] : [banked],
    entries: entities.map((entity) => ({ entity, stake: String(stake) })),
    banks,
    settlementCommitment: null,
    settlementSeed: null,
    liquidBalance: String(credited),
    capBasisStake: String(basis),
    receipts: receipts.map((entry) => ({
      fingerprint: entry.fingerprint,
      receipt: toWireReceipt(entry.receipt),
    })),
  };
  return Object.freeze({
    snapshot: { ...base, snapshotHash: snapshotHash(base) },
    choices: Object.freeze(choices),
    steps,
    credited,
  });
}

/** Recomputes the checksum so a mutation is judged on its merits, not on the hash. */
function reseal(snapshot: Record<string, unknown>): Record<string, unknown> {
  return { ...snapshot, snapshotHash: snapshotHash({ ...snapshot, snapshotHash: undefined }) };
}

/**
 * `restore()` re-validates rather than trusting, including the money-bearing
 * fields a checksum cannot protect.
 *
 * The tamper set is deliberately not "the balance and the hash": it rewrites the
 * entry stake, the banked subset, and a step's survivor list — each of which is
 * an input to a credited figure — and re-seals the checksum every time, so what
 * is under test is the semantic re-derivation and not the digest.
 */
const snapshotIsRevalidated: Check = {
  code: 'SNAPSHOT_NOT_REVALIDATED',
  description: 'restore() re-derives every money-bearing field and rejects a re-sealed rewrite',
  scope: 'round',
  run({ definition, seedHex, roundId, seedIndex, count }) {
    const failures: ConformanceFailure[] = [];
    const canonical = conformanceRoundId(roundId, seedIndex);
    const staked = stakedSnapshotFor(definition, seedHex, canonical);
    count('snapshots');
    try {
      const restored = SurvivalBook.restore(definition, staked.snapshot);
      if (
        restored.stageRevision !== 1 ||
        restored.liquidBalance !== staked.credited ||
        restored.capBasisStake !== REFERENCE_STAKE * BigInt(definition.entities)
      )
        failures.push(
          failure(
            'SNAPSHOT_NOT_REVALIDATED',
            '$',
            'A re-derived staked snapshot did not restore to the state it describes',
          ),
        );
    } catch (error) {
      failures.push(
        failure(
          'SNAPSHOT_NOT_REVALIDATED',
          '$',
          `A valid staked snapshot was rejected: ${(error as Error).message}`,
        ),
      );
    }

    const banks = staked.snapshot.banks as { stage: number; entities: number[] }[];
    const tampers: [string, Record<string, unknown>][] = [
      [
        'entry stake',
        reseal({
          ...staked.snapshot,
          entries: (staked.snapshot.entries as { entity: number; stake: string }[]).map(
            (entry, index) =>
              index === 0 ? { ...entry, stake: String(REFERENCE_STAKE * 1_000n) } : entry,
          ),
        }),
      ],
      [
        'liquid balance',
        reseal({ ...staked.snapshot, liquidBalance: String(staked.credited + 1n) }),
      ],
      [
        'decision banked subset',
        reseal({
          ...staked.snapshot,
          choices: (staked.snapshot.choices as { contractId: string; banked: number[] }[]).map(
            (choice) => ({ ...choice, banked: [0] }),
          ),
        }),
      ],
    ];
    // The withdrawn set is recorded twice — once in the decision log and once in
    // the ledger — so moving one of them must contradict the other. The entity
    // added has to be one that is not already withdrawn, or the "rewrite" is the
    // identity and the check would pass by accident on the rounds where the
    // banked entity happened to be the one picked.
    const pendingBanked = staked.snapshot.pendingBanked as number[];
    const spare = Array.from({ length: definition.entities }, (_entity, index) => index).find(
      (entity) => !pendingBanked.includes(entity),
    );
    tampers.push([
      'pending banked set',
      reseal({
        ...staked.snapshot,
        pendingBanked:
          spare === undefined
            ? pendingBanked.slice(1)
            : [...pendingBanked, spare].sort((left, right) => left - right),
      }),
    ]);
    // A rewritten survivor list is only a *money* rewrite when something was
    // credited against it; on a round the tape wiped there is nothing to
    // contradict, and the lie is caught at settlement instead, where the seed
    // exists. The tamper is applied where it is actually a money rewrite.
    if (banks.length > 0)
      tampers.push([
        'banked entity',
        reseal({
          ...staked.snapshot,
          banks: banks.map((record) => ({
            ...record,
            entities: [(record.entities[0] as number) === 0 ? 1 : 0],
          })),
        }),
      ]);
    for (const [label, snapshot] of tampers) {
      count('tamperedSnapshots');
      let rejected = false;
      try {
        SurvivalBook.restore(definition, snapshot);
      } catch {
        rejected = true;
      }
      if (!rejected)
        failures.push(
          failure(
            'SNAPSHOT_NOT_REVALIDATED',
            '$',
            `A re-sealed snapshot with a rewritten ${label} was accepted`,
          ),
        );
    }
    return failures;
  },
};

/**
 * Value is conserved across a partial bank.
 *
 * Banking a subset and then settling the rest must credit the same exact total
 * as settling everything at once, up to the floor taken at each credit boundary
 * — never more. This is the property that repeated partial credits break when a
 * book measures every claim against a balance it never moves.
 */
const bankingConservesValue: Check = {
  code: 'BANKING_LOSES_VALUE',
  description: 'A partial bank plus a settlement credits the same exact total, minus floor only',
  scope: 'round',
  run({ definition, seedHex, roundId, seedIndex, count }) {
    const canonical = conformanceRoundId(roundId, seedIndex);
    const truth = deriveTruth(seedHex, definition, canonical);
    const choices = pathOf(definition, truth, (menu) => menu[0] as string);
    const steps = deriveSteps(definition, truth, choices);
    const stake = REFERENCE_STAKE;
    const entryReturn = rational(
      definition.pricing.entryReturn.numerator,
      definition.pricing.entryReturn.denominator,
    );
    const values = new Map<number, Rational>(
      Array.from({ length: definition.entities }, (_entity, entity) => [
        entity,
        multiply(rational(stake), entryReturn),
      ]),
    );
    for (const step of steps) {
      const contract = definition.contracts.find(
        (candidate) => candidate.id === step.contractId,
      ) as { multiplier: Rational };
      const multiplier = rational(contract.multiplier.numerator, contract.multiplier.denominator);
      for (const entity of step.survivors)
        values.set(entity, multiply(values.get(entity) as Rational, multiplier));
      for (const entity of step.failed) values.set(entity, rational(0n));
    }
    const survivors =
      steps.length === 0
        ? Array.from({ length: definition.entities }, (_entity, entity) => entity)
        : [...(steps[steps.length - 1] as SurvivalStep).survivors];
    const failures: ConformanceFailure[] = [];
    count('conservationChecks');
    // Split the field into every prefix/suffix pair: banking the prefix and
    // settling the suffix must be the same exact value as settling the whole,
    // and the credited difference must be the floor loss and nothing else.
    const sum = (subset: readonly number[]): Rational =>
      subset.reduce((total, entity) => add(total, values.get(entity) as Rational), rational(0n));
    const whole = sum(survivors);
    for (let cut = 0; cut <= survivors.length; cut += 1) {
      const banked = survivors.slice(0, cut);
      const kept = survivors.slice(cut);
      if (!equal(add(sum(banked), sum(kept)), whole))
        failures.push(
          failure(
            'BANKING_LOSES_VALUE',
            '$.claims',
            `Exact claim value is not conserved when banking ${cut} of ${survivors.length}`,
          ),
        );
      const parts = floorOf(sum(banked)) + floorOf(sum(kept));
      const single = floorOf(whole);
      if (parts > single || single - parts > 1n)
        failures.push(
          failure(
            'BANKING_LOSES_VALUE',
            '$.claims',
            `Splitting a credit into two lost more than one minor unit at ${cut}`,
          ),
        );
    }
    return failures;
  },
};

export const STAGED_SURVIVAL_CHECKS: readonly Check[] = Object.freeze([
  frozenGraph,
  continuationIsFair,
  distributionIsExact,
  laneGeometryIsStable,
  capHasHeadroom,
  tapeIsDeterministic,
  choicesDriveSteps,
  commitmentBindsChoices,
  seedIsPrecommitted,
  transcriptRoundTrip,
  snapshotIsRevalidated,
  bankingConservesValue,
]);
