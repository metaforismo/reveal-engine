/**
 * Test-only lifecycle module: evidence that the contract carries a round whose
 * transcript is a function of (seed-committed random tape + logged player
 * choices), which the progressive market and the ordering fixture do not have.
 *
 * - `choiceTiming: 'before-step'` — the player picks a contract for a stage
 *   *before* that stage resolves, and the choice is an input to step derivation;
 * - the truth is the `RandomTape` itself: every draw is fixed by the seed alone,
 *   so no decision can change what the tape says, only what it means;
 * - the commitment body binds the choice log, so one published commitment cannot
 *   be re-settled under a different set of decisions;
 * - a seed pre-commitment is published *before* the first choice exists, which
 *   is the only thing that makes a choice-timed round fair — the body
 *   commitment cannot be, because the body does not exist yet;
 * - N entities carry independent partial claims that can be banked in subsets
 *   between stages, each externally funded and each growing the round's cap
 *   basis.
 *
 * It is deliberately not registered in `src/modules/index.ts` and is not a game.
 */
import { fail } from '../../src/api/errors.js';
import {
  constantTimeHexEqual,
  sealCommitment,
  sealSeedCommitment,
} from '../../src/core/commitment.js';
import {
  CommandLedger,
  commandFingerprint,
  fromWireReceipt,
  toWireReceipt,
  type Receipt as LedgerReceipt,
  type StoredReceipt,
  type WireReceipt,
} from '../../src/core/ledger.js';
import {
  assertClaimBudget,
  assertLoggedChoices,
  defineLifecycleModule,
  samplerScopeOf,
  type ConformanceFailure,
  type LifecycleModule,
  type LifecycleShape,
  type ModuleConformanceCheck,
  type RoundIdentity,
} from '../../src/core/module.js';
import { RandomTape, type TapeDraw } from '../../src/core/random.js';
import { floor, multiply, rational, type Rational } from '../../src/core/rational.js';
import {
  assertSnapshotKeys,
  assertSnapshotRecord,
  assertSnapshotSize,
  assertWireHex,
  assertWireString,
  parseSnapshotJson,
  parseWireBigInt,
  snapshotHash,
} from '../../src/core/snapshot.js';
import {
  classifyVerificationError,
  verificationFailure,
  verificationSuccess,
} from '../../src/core/verification.js';
import { COMMITMENT_VERSION, MODULE_API_VERSION } from '../../src/core/versions.js';
import { weightVector, type WeightVector } from '../../src/core/weights.js';
import { encodeFields, type CanonicalField } from '../../src/internal/canonical.js';

const MODULE_ID = 'staged-survival-fixture';
const MODULE_VERSION = '0.0.1';
const TRANSCRIPT_SCHEMA = 'staged-survival-fixture/transcript-v1' as const;
const SNAPSHOT_SCHEMA = 'staged-survival-fixture/book-v1' as const;
const ACTIONS = Object.freeze(['enter', 'choose', 'bank', 'settle'] as const);

export interface SurvivalContract {
  readonly id: string;
  /** Exact survival probability applied to every live entity in the stage. */
  readonly survival: Rational;
  /** Exact multiplier applied to a surviving entity's accrued value. */
  readonly multiplier: Rational;
}

export interface SurvivalDefinition {
  readonly id: string;
  readonly version: string;
  readonly entities: number;
  readonly stages: number;
  readonly contracts: readonly SurvivalContract[];
  /**
   * Modulus of every tape draw. Every contract denominator must divide it, so
   * the survival test is an exact rational comparison rather than a rounded one
   * — and, critically, the modulus does not depend on the contract the player
   * picks, so the tape stays a pure function of the seed.
   */
  readonly drawModulus: bigint;
  readonly maxWinMultiple: bigint;
}

/** The truth is the tape: fixed by the seed, before and regardless of any choice. */
export interface SurvivalTruth {
  readonly draws: readonly TapeDraw[];
  readonly digest: string;
}

export interface SurvivalStep {
  readonly index: number;
  readonly contractId: string;
  readonly survivors: readonly number[];
  readonly failed: readonly number[];
}

export interface SurvivalTranscript {
  readonly schema: typeof TRANSCRIPT_SCHEMA;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly roundId: string;
  /** Published before the round opened, when no choice existed yet. */
  readonly seedCommitment: string;
  readonly tapeDigest: string;
  readonly choices: readonly string[];
  readonly steps: readonly SurvivalStep[];
  readonly commitment: string;
}

export interface SurvivalShape extends LifecycleShape {
  readonly definition: SurvivalDefinition;
  readonly truth: SurvivalTruth;
  readonly step: SurvivalStep;
  /** A logged decision: which contract governs the next stage. */
  readonly choice: string;
  readonly claim: { readonly entity: number; readonly contractId: string };
  readonly transcript: SurvivalTranscript;
  readonly book: SurvivalBook;
}

function roundOf(definition: SurvivalDefinition, roundId: string): RoundIdentity {
  return Object.freeze({
    moduleId: MODULE_ID,
    definitionId: definition.id,
    roundId,
    proofVersion: COMMITMENT_VERSION,
  });
}

function assertDefinition(value: unknown, path = '$'): asserts value is SurvivalDefinition {
  const definition = value as SurvivalDefinition;
  if (
    typeof definition !== 'object' ||
    definition === null ||
    typeof definition.id !== 'string' ||
    typeof definition.version !== 'string' ||
    !Number.isSafeInteger(definition.entities) ||
    definition.entities < 1 ||
    !Number.isSafeInteger(definition.stages) ||
    definition.stages < 1 ||
    !Array.isArray(definition.contracts) ||
    definition.contracts.length === 0 ||
    typeof definition.drawModulus !== 'bigint' ||
    definition.drawModulus <= 0n ||
    typeof definition.maxWinMultiple !== 'bigint'
  )
    fail('INVALID_ADAPTER', 'Invalid survival definition', path);
  for (const contract of definition.contracts)
    if (
      typeof contract?.id !== 'string' ||
      contract.survival.numerator <= 0n ||
      contract.survival.numerator > contract.survival.denominator ||
      definition.drawModulus % contract.survival.denominator !== 0n
    )
      fail(
        'INVALID_ADAPTER',
        'Contract survival must be in (0,1] and divide the draw modulus exactly',
        `${path}.contracts`,
      );
}

function contractOf(definition: SurvivalDefinition, id: unknown): SurvivalContract {
  const contract = definition.contracts.find((candidate) => candidate.id === id);
  if (!contract) fail('INVALID_CHOICE', 'Unknown stage contract', '$.choice');
  return contract;
}

function identityFields(definition: SurvivalDefinition): CanonicalField[] {
  return [
    MODULE_ID,
    definition.id,
    definition.version,
    definition.entities,
    definition.stages,
    definition.drawModulus,
    definition.maxWinMultiple,
    definition.contracts.length,
    ...definition.contracts.flatMap((contract): CanonicalField[] => [
      contract.id,
      contract.survival.numerator,
      contract.survival.denominator,
      contract.multiplier.numerator,
      contract.multiplier.denominator,
    ]),
  ];
}

function fingerprint(definition: SurvivalDefinition): string {
  assertDefinition(definition);
  return sealCommitment('00'.repeat(32), encodeFields(identityFields(definition)));
}

/**
 * Expands the seed into the whole round's random tape, up front.
 *
 * The tape is derived before any decision is made and cannot be influenced by
 * one: `(stage, entity)` addresses a draw, and the modulus is a declared
 * constant of the definition. What the choices decide is how each draw is
 * *read*, never what it is.
 */
function deriveTruth(
  seedHex: string,
  definition: SurvivalDefinition,
  roundId: string,
): SurvivalTruth {
  assertDefinition(definition);
  const tape = new RandomTape(seedHex, samplerScopeOf(roundOf(definition, roundId)));
  for (let stage = 0; stage < definition.stages; stage += 1)
    for (let entity = 0; entity < definition.entities; entity += 1)
      tape.draw(`stage-${stage}`, entity, definition.drawModulus);
  return Object.freeze({ draws: tape.draws, digest: tape.digest() });
}

function drawFor(
  definition: SurvivalDefinition,
  truth: SurvivalTruth,
  stage: number,
  entity: number,
): bigint {
  const draw = truth.draws[stage * definition.entities + entity];
  if (draw === undefined) fail('DERIVATION_FAILED', 'Tape is shorter than the schedule', '$.truth');
  return draw.value;
}

/** Exact: `draw < numerator * (modulus / denominator)` has probability `numerator/denominator`. */
function survives(
  definition: SurvivalDefinition,
  contract: SurvivalContract,
  draw: bigint,
): boolean {
  return (
    draw < contract.survival.numerator * (definition.drawModulus / contract.survival.denominator)
  );
}

/**
 * Steps are a pure function of (tape, logged choices).
 *
 * The transcript is exactly as long as the decision log: a round the player
 * stopped after two stages has two steps, and re-deriving it needs those two
 * decisions and nothing else.
 */
function deriveSteps(
  definition: SurvivalDefinition,
  truth: SurvivalTruth,
  choices: readonly string[],
): SurvivalStep[] {
  assertDefinition(definition);
  if (choices.length > definition.stages)
    fail('INVALID_CHOICE', 'More choices than the definition has stages', '$.choices');
  const steps: SurvivalStep[] = [];
  let live = Array.from({ length: definition.entities }, (_entity, index) => index);
  for (const [stage, choice] of choices.entries()) {
    const contract = contractOf(definition, choice);
    const survivors: number[] = [];
    const failed: number[] = [];
    for (const entity of live)
      (survives(definition, contract, drawFor(definition, truth, stage, entity))
        ? survivors
        : failed
      ).push(entity);
    steps.push(
      Object.freeze({
        index: stage,
        contractId: contract.id,
        survivors: Object.freeze([...survivors]),
        failed: Object.freeze([...failed]),
      }),
    );
    live = survivors;
  }
  return steps;
}

/**
 * Marginal belief: which entities are still live, plus a terminal "field is
 * empty" slot so a round where everything failed is a legal state rather than
 * an impossible weight vector. Claims are priced through `price()`.
 */
function belief(definition: SurvivalDefinition, steps: readonly SurvivalStep[]): WeightVector {
  const last = steps[steps.length - 1];
  const live = new Set(
    last ? last.survivors : Array.from({ length: definition.entities }, (_e, i) => i),
  );
  const weights = Array.from({ length: definition.entities }, (_entity, index) =>
    live.has(index) ? 1n : 0n,
  );
  weights.push(live.size === 0 ? 1n : 0n);
  return weightVector(weights);
}

/** Exact probability that a live entity survives the next stage under a contract. */
function price(
  definition: SurvivalDefinition,
  steps: readonly SurvivalStep[],
  claim: SurvivalShape['claim'],
): Rational {
  assertDefinition(definition);
  const contract = contractOf(definition, claim?.contractId);
  const last = steps[steps.length - 1];
  const live = last
    ? last.survivors
    : Array.from({ length: definition.entities }, (_entity, index) => index);
  if (!live.includes(claim.entity)) return rational(0n);
  return rational(contract.survival.numerator, contract.survival.denominator);
}

/**
 * Canonical body.
 *
 * It binds the choice log as well as the truth and the steps. Without that, an
 * operator holding one published commitment could re-settle the round under a
 * different set of decisions and both settlements would verify.
 */
function commitmentBody(
  definition: SurvivalDefinition,
  round: RoundIdentity,
  truth: SurvivalTruth,
  steps: readonly SurvivalStep[],
  choices: readonly string[],
): Buffer {
  return encodeFields([
    'staged-survival-fixture commitment',
    COMMITMENT_VERSION,
    round.moduleId,
    ...identityFields(definition),
    fingerprint(definition),
    round.roundId,
    truth.digest,
    truth.draws.length,
    choices.length,
    ...choices,
    steps.length,
    ...steps.flatMap((step): CanonicalField[] => [
      step.index,
      step.contractId,
      step.survivors.length,
      ...step.survivors,
      step.failed.length,
      ...step.failed,
    ]),
  ]);
}

function seedCommitment(
  seedHex: string,
  definition: SurvivalDefinition,
  round: RoundIdentity,
): string {
  return sealSeedCommitment(seedHex, {
    moduleId: round.moduleId,
    definitionId: definition.id,
    definitionFingerprint: fingerprint(definition),
    roundId: round.roundId,
    proofVersion: round.proofVersion,
  });
}

function build(
  seedHex: string,
  definition: SurvivalDefinition,
  roundId: string,
  choices: readonly string[] = [],
): SurvivalTranscript {
  assertDefinition(definition);
  const round = roundOf(definition, roundId);
  const truth = deriveTruth(seedHex, definition, roundId);
  const steps = deriveSteps(definition, truth, choices);
  return Object.freeze({
    schema: TRANSCRIPT_SCHEMA,
    definitionId: definition.id,
    definitionVersion: definition.version,
    roundId,
    seedCommitment: seedCommitment(seedHex, definition, round),
    tapeDigest: truth.digest,
    choices: Object.freeze([...choices]),
    steps: Object.freeze(steps),
    commitment: sealCommitment(seedHex, commitmentBody(definition, round, truth, steps, choices)),
  });
}

function fromWire(input: unknown): SurvivalTranscript {
  const value = input as SurvivalTranscript;
  if (
    typeof value !== 'object' ||
    value === null ||
    value.schema !== TRANSCRIPT_SCHEMA ||
    typeof value.roundId !== 'string' ||
    typeof value.commitment !== 'string' ||
    typeof value.seedCommitment !== 'string' ||
    typeof value.tapeDigest !== 'string' ||
    !Array.isArray(value.choices) ||
    !Array.isArray(value.steps) ||
    value.choices.some((choice) => typeof choice !== 'string')
  )
    fail('INVALID_TRANSCRIPT', 'Invalid survival transcript', '$.schema');
  return value;
}

function stepsEqual(left: readonly SurvivalStep[], right: readonly SurvivalStep[]): boolean {
  const same = (a: readonly number[], b: readonly number[]): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  return (
    left.length === right.length &&
    left.every((step, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        step.index === other.index &&
        step.contractId === other.contractId &&
        same(step.survivors, other.survivors) &&
        same(step.failed, other.failed)
      );
    })
  );
}

export type SurvivalAction = (typeof ACTIONS)[number];

export interface SurvivalClaim {
  readonly entity: number;
  readonly stake: bigint;
  readonly value: Rational;
  readonly live: boolean;
  readonly banked: boolean;
}

/**
 * Multi-claim book with partial settlement.
 *
 * Every entity carries its own claim. A stage is chosen before it resolves, so
 * `choose()` logs the decision as a fenced, idempotent command and `resolve()`
 * applies the step the module derived from (tape, choices). Between stages a
 * player may bank any subset of live entities; each banked subset is a partial
 * credit against the shared round cap.
 */
export class SurvivalBook {
  readonly #ledger: CommandLedger;
  readonly #claims = new Map<number, SurvivalClaim>();
  readonly #choices: string[] = [];
  #stageRevision = 0;
  #terminal = false;

  constructor(readonly definition: SurvivalDefinition) {
    assertDefinition(definition);
    this.#ledger = new CommandLedger({ maxWinMultiple: definition.maxWinMultiple });
  }

  get claims(): readonly SurvivalClaim[] {
    return Object.freeze([...this.#claims.values()]);
  }
  get choices(): readonly string[] {
    return Object.freeze([...this.#choices]);
  }
  get stageRevision(): number {
    return this.#stageRevision;
  }
  get liquidBalance(): bigint {
    return this.#ledger.liquidBalance;
  }
  get capBasisStake(): bigint | undefined {
    return this.#ledger.capBasisStake;
  }
  get terminal(): boolean {
    return this.#terminal;
  }

  /** One externally funded claim per entity; each one raises the round ceiling. */
  async enter(key: string, entity: number, stake: bigint): Promise<LedgerReceipt<SurvivalAction>> {
    const fp = commandFingerprint('enter', [entity, stake]);
    return this.#ledger.execute<SurvivalAction>(key, fp, () => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is terminal');
      if (this.#stageRevision !== 0) fail('CLAIM_REJECTED', 'Entries close at the first stage');
      if (!Number.isSafeInteger(entity) || entity < 0 || entity >= this.definition.entities)
        fail('CLAIM_REJECTED', 'Unknown entity', '$.entity');
      if (this.#claims.has(entity)) fail('CLAIM_REJECTED', 'Entity already entered', '$.entity');
      assertClaimBudget(this.#claims.size, this.definition.entities);
      const receipt = this.#ledger.mint(key, fp, 'enter', this.#stageRevision, stake, 0n, false);
      this.#ledger.fundStake(stake, 'external');
      this.#claims.set(
        entity,
        Object.freeze({ entity, stake, value: rational(stake), live: true, banked: false }),
      );
      return receipt;
    });
  }

  /** Logs the decision for the next stage, before that stage resolves. */
  async choose(key: string, contractId: string): Promise<LedgerReceipt<SurvivalAction>> {
    const fp = commandFingerprint('choose', [this.#stageRevision, contractId]);
    return this.#ledger.execute<SurvivalAction>(key, fp, () => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is terminal');
      if (this.#choices.length !== this.#stageRevision)
        fail('CLAIM_REJECTED', 'A choice for this stage is already logged', '$.choice');
      if (this.#stageRevision >= this.definition.stages)
        fail('CLAIM_REJECTED', 'Every stage has resolved', '$.choice');
      if (this.#claims.size === 0) fail('CLAIM_REJECTED', 'Round has no claims', '$.choice');
      contractOf(this.definition, contractId);
      const receipt = this.#ledger.mint(key, fp, 'choose', this.#stageRevision, 0n, 0n, false);
      this.#choices.push(contractId);
      return receipt;
    });
  }

  /** Applies the step the module derived from (tape, logged choices). */
  async resolve(step: SurvivalStep): Promise<number> {
    return this.#ledger.serial(() => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is terminal');
      if (step.index !== this.#stageRevision)
        fail('STALE_FRAME', 'Stage step is out of order', '$.step.index');
      if (this.#choices[step.index] !== step.contractId)
        fail('TRANSCRIPT_MISMATCH', 'Step contract differs from the logged choice', '$.step');
      const contract = contractOf(this.definition, step.contractId);
      const survivors = new Set(step.survivors);
      for (const claim of this.claims) {
        if (!claim.live) continue;
        this.#claims.set(
          claim.entity,
          Object.freeze({
            ...claim,
            live: survivors.has(claim.entity),
            value: survivors.has(claim.entity)
              ? multiply(claim.value, contract.multiplier)
              : rational(0n),
          }),
        );
      }
      this.#stageRevision += 1;
      return this.#stageRevision;
    });
  }

  /** Partial settlement: bank a subset of live entities and leave the rest at risk. */
  async bank(key: string, entities: readonly number[]): Promise<LedgerReceipt<SurvivalAction>> {
    const chosen = [...entities].sort((left, right) => left - right);
    const fp = commandFingerprint('bank', [this.#stageRevision, chosen.length, ...chosen]);
    return this.#ledger.execute<SurvivalAction>(key, fp, () => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is terminal');
      if (chosen.length === 0) fail('CLAIM_REJECTED', 'Nothing to bank', '$.entities');
      let total = rational(0n);
      for (const entity of chosen) {
        const claim = this.#claims.get(entity);
        if (!claim || !claim.live || claim.banked)
          fail('CLAIM_REJECTED', 'Entity is not bankable', '$.entities');
        total = rational(
          total.numerator * claim.value.denominator + claim.value.numerator * total.denominator,
          total.denominator * claim.value.denominator,
        );
      }
      const result = this.#ledger.creditWithinCap(total);
      const receipt = this.#ledger.mint(
        key,
        fp,
        'bank',
        this.#stageRevision,
        0n,
        result.credited,
        result.capped,
      );
      for (const entity of chosen) {
        const claim = this.#claims.get(entity) as SurvivalClaim;
        this.#claims.set(entity, Object.freeze({ ...claim, live: false, banked: true }));
      }
      this.#ledger.applyCredit(result.credited);
      if (this.claims.every((claim) => !claim.live)) this.#terminal = true;
      return receipt;
    });
  }

  /**
   * Settles what is still at risk against the revealed proof.
   *
   * The transcript must be this round's: same choice log, same resolved steps.
   * A settlement proof for a different decision sequence is refused here even
   * though it verifies on its own, because it is not what this book played.
   */
  async settle(
    key: string,
    revealedSeed: string,
    transcript: SurvivalTranscript,
  ): Promise<LedgerReceipt<SurvivalAction>> {
    const fp = commandFingerprint('settle', [transcript.commitment]);
    return this.#ledger.execute<SurvivalAction>(key, fp, () => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is already terminal');
      const verification = stagedSurvivalFixtureModule.verify(
        revealedSeed,
        this.definition,
        transcript,
      );
      if (!verification.ok)
        fail('INVALID_TRANSCRIPT', verification.message, verification.path, {
          verificationCode: verification.code,
        });
      if (
        transcript.choices.length !== this.#choices.length ||
        transcript.choices.some((choice, index) => choice !== this.#choices[index]) ||
        transcript.steps.length !== this.#stageRevision
      )
        fail(
          'TRANSCRIPT_MISMATCH',
          'Settlement proof is for a different decision log',
          '$.choices',
        );
      let total = rational(0n);
      for (const claim of this.claims)
        if (claim.live)
          total = rational(
            total.numerator * claim.value.denominator + claim.value.numerator * total.denominator,
            total.denominator * claim.value.denominator,
          );
      const result =
        this.#ledger.capBasisStake === undefined
          ? Object.freeze({ theoretical: total, credited: 0n, capped: false })
          : this.#ledger.creditWithinCap(total);
      const receipt = this.#ledger.mint(
        key,
        fp,
        'settle',
        this.#stageRevision,
        0n,
        result.credited,
        result.capped,
      );
      for (const claim of this.claims)
        this.#claims.set(claim.entity, Object.freeze({ ...claim, live: false }));
      this.#terminal = true;
      this.#ledger.applyCredit(result.credited);
      return receipt;
    });
  }

  snapshot(): object {
    const capBasisStake = this.#ledger.capBasisStake;
    const base = {
      schema: SNAPSHOT_SCHEMA,
      definition: { id: this.definition.id, fingerprint: fingerprint(this.definition) },
      terminal: this.#terminal,
      stageRevision: this.#stageRevision,
      ledgerRevision: this.#ledger.ledgerRevision,
      choices: [...this.#choices],
      liquidBalance: String(this.#ledger.liquidBalance),
      capBasisStake: capBasisStake === undefined ? null : String(capBasisStake),
      claims: this.claims.map((claim) => ({
        entity: claim.entity,
        stake: String(claim.stake),
        value: {
          numerator: String(claim.value.numerator),
          denominator: String(claim.value.denominator),
        },
        live: claim.live,
        banked: claim.banked,
      })),
      receipts: this.#ledger.entries().map((stored) => ({
        fingerprint: stored.fingerprint,
        receipt: toWireReceipt(stored.receipt),
      })),
    };
    return Object.freeze({ ...base, snapshotHash: snapshotHash(base) });
  }

  /**
   * Re-validates a reconnect snapshot rather than trusting it.
   *
   * The decision log is part of the state that must survive: a round that loses
   * its choices cannot be settled at all, because the settlement proof is a
   * function of them. So the log is restored, re-checked against the resolved
   * stage count, and reconciled with the receipt sequence — a `choose` receipt
   * per logged decision, in order.
   */
  static restore(definition: SurvivalDefinition, input: string | object): SurvivalBook {
    assertDefinition(definition);
    const raw = parseSurvivalSnapshot(input);
    if (raw.snapshotHash !== snapshotHash({ ...raw, snapshotHash: undefined }))
      fail('INVALID_SNAPSHOT', 'Snapshot hash is invalid', '$.snapshotHash');
    if (
      raw.definition.id !== definition.id ||
      raw.definition.fingerprint !== fingerprint(definition)
    )
      fail('DEFINITION_MISMATCH', 'Snapshot belongs to another definition', '$.definition');

    const book = new SurvivalBook(definition);
    book.#terminal = raw.terminal;
    book.#stageRevision = raw.stageRevision;
    if (raw.stageRevision > definition.stages || raw.choices.length < raw.stageRevision)
      fail('INVALID_SNAPSHOT', 'Stage revision outruns the decision log', '$.stageRevision');
    for (const choice of raw.choices) {
      contractOf(definition, choice);
      book.#choices.push(choice);
    }
    for (const claim of raw.claims) {
      if (
        !Number.isSafeInteger(claim.entity) ||
        claim.entity < 0 ||
        claim.entity >= definition.entities
      )
        fail('INVALID_SNAPSHOT', 'Unknown entity in snapshot', '$.claims');
      book.#claims.set(
        claim.entity,
        Object.freeze({
          entity: claim.entity,
          stake: parseWireBigInt(claim.stake, '$.claims[].stake'),
          value: rational(
            parseWireBigInt(claim.value.numerator, '$.claims[].value.numerator', true),
            parseWireBigInt(claim.value.denominator, '$.claims[].value.denominator'),
          ),
          live: claim.live,
          banked: claim.banked,
        }),
      );
    }
    if (book.#claims.size !== raw.claims.length)
      fail('INVALID_SNAPSHOT', 'Snapshot claim keys are not unique', '$.claims');

    let staked = 0n;
    let entries = 0;
    let chooses = 0;
    let credited = 0n;
    let settled = false;
    const stored: StoredReceipt<SurvivalAction>[] = raw.receipts.map((entry) => ({
      fingerprint: entry.fingerprint,
      receipt: fromWireReceipt<SurvivalAction>(entry.receipt, ACTIONS),
    }));
    book.#ledger.install(stored, book.#stageRevision, (receipt) => {
      if (settled) fail('INVALID_SNAPSHOT', 'Receipts continue past settlement');
      if (receipt.action === 'enter') {
        if (chooses > 0 || receipt.debited <= 0n || receipt.credited !== 0n)
          fail('INVALID_SNAPSHOT', 'Receipt sequence violates the round state machine');
        // The receipt fingerprint pins the entity and the stake, so a rewritten
        // claim list cannot survive its own receipt log.
        const claim = raw.claims[entries];
        if (
          claim === undefined ||
          receipt.commandFingerprint !==
            commandFingerprint('enter', [claim.entity, parseWireBigInt(claim.stake, '$.claims')])
        )
          fail('INVALID_SNAPSHOT', 'Receipt does not match the restored claim', '$.claims');
        staked += receipt.debited;
        entries += 1;
      } else if (receipt.action === 'choose') {
        if (receipt.debited !== 0n || receipt.credited !== 0n)
          fail('INVALID_SNAPSHOT', 'A logged decision must not move money');
        // Same for decisions: the choice log is only as trustworthy as the
        // receipts that recorded it, so re-derive the fingerprint and compare.
        if (
          receipt.commandFingerprint !==
          commandFingerprint('choose', [chooses, book.#choices[chooses] as string])
        )
          fail('INVALID_SNAPSHOT', 'Receipt does not match the logged decision', '$.choices');
        chooses += 1;
      } else {
        if (receipt.debited !== 0n)
          fail('INVALID_SNAPSHOT', 'Receipt sequence violates the round state machine');
        credited += receipt.credited;
        settled = receipt.action === 'settle';
      }
    });
    const capBasisStake =
      raw.capBasisStake === null
        ? undefined
        : parseWireBigInt(raw.capBasisStake, '$.capBasisStake');
    if (
      entries !== book.#claims.size ||
      chooses !== book.#choices.length ||
      (entries === 0) !== (capBasisStake === undefined) ||
      (capBasisStake !== undefined && capBasisStake !== staked)
    )
      fail('INVALID_SNAPSHOT', 'Snapshot state invariants failed');
    if (credited !== parseWireBigInt(raw.liquidBalance, '$.liquidBalance', true))
      fail('INVALID_SNAPSHOT', 'Snapshot accounting does not conserve liquid value');
    book.#ledger.restoreBalances({
      ledgerRevision: raw.ledgerRevision,
      liquidBalance: credited,
      capBasisStake,
    });
    return book;
  }

  /** Exact banked value of one claim, floored at the credit boundary only. */
  static bankableAmount(claim: SurvivalClaim): bigint {
    return floor(claim.value);
  }
}

interface SurvivalSnapshot {
  readonly schema: typeof SNAPSHOT_SCHEMA;
  readonly definition: { readonly id: string; readonly fingerprint: string };
  readonly terminal: boolean;
  readonly stageRevision: number;
  readonly ledgerRevision: number;
  readonly choices: readonly string[];
  readonly liquidBalance: string;
  readonly capBasisStake: string | null;
  readonly claims: readonly {
    readonly entity: number;
    readonly stake: string;
    readonly value: { readonly numerator: string; readonly denominator: string };
    readonly live: boolean;
    readonly banked: boolean;
  }[];
  readonly receipts: readonly { readonly fingerprint: string; readonly receipt: WireReceipt }[];
  readonly snapshotHash: string;
}

function parseSurvivalSnapshot(input: string | object): SurvivalSnapshot {
  const value: unknown = typeof input === 'string' ? parseSnapshotJson(input) : input;
  const candidate = assertSnapshotRecord(value, '$');
  assertSnapshotKeys(
    candidate,
    [
      'schema',
      'definition',
      'terminal',
      'stageRevision',
      'ledgerRevision',
      'choices',
      'liquidBalance',
      'capBasisStake',
      'claims',
      'receipts',
      'snapshotHash',
    ],
    '$',
  );
  if (
    candidate.schema !== SNAPSHOT_SCHEMA ||
    typeof candidate.terminal !== 'boolean' ||
    !Number.isSafeInteger(candidate.stageRevision) ||
    !Number.isSafeInteger(candidate.ledgerRevision) ||
    !Array.isArray(candidate.claims) ||
    !Array.isArray(candidate.receipts)
  )
    fail('INVALID_SNAPSHOT', 'Snapshot scalar fields are invalid', '$');
  const definition = assertSnapshotRecord(candidate.definition, '$.definition');
  assertSnapshotKeys(definition, ['id', 'fingerprint'], '$.definition');
  assertWireString(definition.id, '$.definition.id');
  assertWireHex(definition.fingerprint, '$.definition.fingerprint');
  assertWireString(candidate.liquidBalance, '$.liquidBalance');
  if (candidate.capBasisStake !== null)
    assertWireString(candidate.capBasisStake, '$.capBasisStake');
  assertLoggedChoices(candidate.choices as readonly unknown[], 'before-step', '$.choices');
  (candidate.choices as readonly unknown[]).forEach((choice, index) =>
    assertWireString(choice, `$.choices[${index}]`),
  );
  candidate.claims.forEach((item, index) => {
    const claim = assertSnapshotRecord(item, `$.claims[${index}]`);
    assertSnapshotKeys(claim, ['entity', 'stake', 'value', 'live', 'banked'], `$.claims[${index}]`);
    assertWireString(claim.stake, `$.claims[${index}].stake`);
    if (typeof claim.live !== 'boolean' || typeof claim.banked !== 'boolean')
      fail('INVALID_SNAPSHOT', 'Claim flags must be booleans', `$.claims[${index}]`);
    const value = assertSnapshotRecord(claim.value, `$.claims[${index}].value`);
    assertSnapshotKeys(value, ['numerator', 'denominator'], `$.claims[${index}].value`);
    assertWireString(value.numerator, `$.claims[${index}].value.numerator`);
    assertWireString(value.denominator, `$.claims[${index}].value.denominator`);
  });
  candidate.receipts.forEach((item, index) => {
    const entry = assertSnapshotRecord(item, `$.receipts[${index}]`);
    assertSnapshotKeys(entry, ['fingerprint', 'receipt'], `$.receipts[${index}]`);
    assertWireHex(entry.fingerprint, `$.receipts[${index}].fingerprint`);
  });
  assertWireHex(candidate.snapshotHash, '$.snapshotHash');
  assertSnapshotSize(candidate);
  return candidate as unknown as SurvivalSnapshot;
}

const tapeIsDeterministic: ModuleConformanceCheck<SurvivalShape> = {
  code: 'TAPE_NOT_DETERMINISTIC',
  description: 'The random tape is a pure function of the seed and the definition',
  scope: 'round',
  run({ definition, seedHex, roundId, count }): readonly ConformanceFailure[] {
    const first = deriveTruth(seedHex, definition, roundId);
    const second = deriveTruth(seedHex, definition, roundId);
    count('tapes', 2);
    if (
      first.digest !== second.digest ||
      first.draws.length !== definition.stages * definition.entities
    )
      return [
        {
          code: 'TAPE_NOT_DETERMINISTIC',
          path: '$.truth',
          message: 'Tape derivation is not deterministic or is the wrong length',
        },
      ];
    return [];
  },
};

const choicesDriveSteps: ModuleConformanceCheck<SurvivalShape> = {
  code: 'CHOICES_DO_NOT_DRIVE_STEPS',
  description: 'Steps are a pure function of (tape, logged choices) and change when choices change',
  scope: 'round',
  run({ definition, seedHex, roundId, count }): readonly ConformanceFailure[] {
    const [safe, risky] = definition.contracts;
    if (!safe || !risky) return [];
    const truth = deriveTruth(seedHex, definition, roundId);
    const one = deriveSteps(definition, truth, [safe.id, safe.id]);
    const again = deriveSteps(definition, truth, [safe.id, safe.id]);
    const other = deriveSteps(definition, truth, [risky.id, risky.id]);
    count('choiceLogs', 3);
    const failures: ConformanceFailure[] = [];
    if (!stepsEqual(one, again))
      failures.push({
        code: 'CHOICES_DO_NOT_DRIVE_STEPS',
        path: '$.steps',
        message: 'The same seed and choice log produced different steps',
      });
    if (one.every((step, index) => step.contractId === other[index]?.contractId))
      failures.push({
        code: 'CHOICES_DO_NOT_DRIVE_STEPS',
        path: '$.steps',
        message: 'A different choice log produced the same contracts',
      });
    return failures;
  },
};

const commitmentBindsChoices: ModuleConformanceCheck<SurvivalShape> = {
  code: 'COMMITMENT_IGNORES_CHOICES',
  description: 'The commitment body binds the choice log, so one seal fits one decision sequence',
  scope: 'round',
  run({ definition, seedHex, roundId, round, count }): readonly ConformanceFailure[] {
    const [safe, risky] = definition.contracts;
    if (!safe || !risky) return [];
    const truth = deriveTruth(seedHex, definition, roundId);
    const steps = deriveSteps(definition, truth, [safe.id]);
    const sealed = sealCommitment(
      seedHex,
      commitmentBody(definition, round, truth, steps, [safe.id]),
    );
    const relabelled = sealCommitment(
      seedHex,
      commitmentBody(definition, round, truth, steps, [risky.id]),
    );
    count('commitmentBodies', 2);
    return sealed === relabelled
      ? [
          {
            code: 'COMMITMENT_IGNORES_CHOICES',
            path: '$.commitment',
            message: 'Two different choice logs sealed to the same commitment',
          },
        ]
      : [];
  },
};

const seedIsPrecommitted: ModuleConformanceCheck<SurvivalShape> = {
  code: 'SEED_PRECOMMITMENT_BROKEN',
  description: 'The seed pre-commitment re-derives from the revealed seed and is seed-specific',
  scope: 'round',
  run({ definition, seedHex, roundId, round, seedIndex, count }): readonly ConformanceFailure[] {
    const published = seedCommitment(seedHex, definition, round);
    const transcript = build(seedHex, definition, roundId, [
      (definition.contracts[0] as SurvivalContract).id,
    ]);
    const otherSeed = (seedIndex + 1).toString(16).padStart(64, '0');
    count('seedCommitments', 2);
    const failures: ConformanceFailure[] = [];
    if (!constantTimeHexEqual(published, transcript.seedCommitment))
      failures.push({
        code: 'SEED_PRECOMMITMENT_BROKEN',
        path: '$.seedCommitment',
        message: 'Transcript seed commitment does not re-derive from the revealed seed',
      });
    if (seedCommitment(otherSeed, definition, round) === published)
      failures.push({
        code: 'SEED_PRECOMMITMENT_BROKEN',
        path: '$.seedCommitment',
        message: 'Two different seeds share a pre-commitment',
      });
    return failures;
  },
};

export const stagedSurvivalFixtureDefinition: SurvivalDefinition = Object.freeze({
  id: 'staged-survival-fixture-v1',
  version: '1.0.0',
  entities: 4,
  stages: 3,
  contracts: Object.freeze([
    Object.freeze({ id: 'steady', survival: rational(4n, 5n), multiplier: rational(6n, 5n) }),
    Object.freeze({ id: 'bold', survival: rational(1n, 2n), multiplier: rational(19n, 10n) }),
  ]),
  drawModulus: 1_000_000n,
  maxWinMultiple: 500n,
});

export const stagedSurvivalFixtureModule: LifecycleModule<SurvivalShape> =
  defineLifecycleModule<SurvivalShape>({
    moduleApiVersion: MODULE_API_VERSION,
    id: MODULE_ID,
    version: MODULE_VERSION,
    summary:
      'Test-only contract fixture: seed-committed tape, per-stage choices logged before resolution, per-entity partial claims.',
    definitions: {
      define: (input) =>
        Object.freeze({ ...input, contracts: Object.freeze([...input.contracts]) }),
      assert: assertDefinition,
      fingerprint,
      identity: (definition) =>
        Object.freeze({
          moduleId: MODULE_ID,
          moduleVersion: MODULE_VERSION,
          definitionId: definition.id,
          definitionVersion: definition.version,
          fingerprint: fingerprint(definition),
        }),
    },
    truth: {
      kind: 'composite',
      derive: deriveTruth,
      encode: (truth) => [truth.digest, truth.draws.length],
      equal: (left, right) => left.digest === right.digest,
    },
    steps: {
      maxSteps: 64,
      choiceTiming: 'before-step',
      beliefSpace: 'marginal',
      count: (definition) => definition.stages,
      derive: (_seedHex, definition, _round, truth, choices) =>
        deriveSteps(definition, truth, choices),
      encode: (step) => [step.index, step.contractId, step.survivors.length, ...step.survivors],
      equal: stepsEqual,
      belief,
      price,
    },
    transcript: {
      schema: TRANSCRIPT_SCHEMA,
      acceptedSchemas: [TRANSCRIPT_SCHEMA],
      build,
      commitmentBody,
      seedCommitment,
      toWire: (transcript) => ({ ...transcript }),
      fromWire,
    },
    book: {
      snapshotSchema: SNAPSHOT_SCHEMA,
      positions: 'multi',
      settlement: 'partial',
      maxOpenClaims: 8,
      actions: ACTIONS,
      create: (definition) => new SurvivalBook(definition),
      restore: (definition, snapshot) => SurvivalBook.restore(definition, snapshot),
      snapshot: (book) => book.snapshot(),
    },
    conformance: {
      defaultSeeds: 4,
      checks: [tapeIsDeterministic, choicesDriveSteps, commitmentBindsChoices, seedIsPrecommitted],
      references: [
        { id: stagedSurvivalFixtureDefinition.id, definition: stagedSurvivalFixtureDefinition },
      ],
    },
    verify(seedHex, definition, input) {
      try {
        assertDefinition(definition);
        const transcript = fromWire(input);
        if (
          transcript.definitionId !== definition.id ||
          transcript.definitionVersion !== definition.version
        )
          return verificationFailure(
            'DEFINITION_MISMATCH',
            'Transcript definition does not match verifier',
            '$.definitionId',
          );
        const round = roundOf(definition, transcript.roundId);
        if (
          !constantTimeHexEqual(
            seedCommitment(seedHex, definition, round),
            transcript.seedCommitment,
          )
        )
          return verificationFailure(
            'COMMITMENT_MISMATCH',
            'Seed pre-commitment does not match the revealed seed',
            '$.seedCommitment',
          );
        const truth = deriveTruth(seedHex, definition, transcript.roundId);
        if (truth.digest !== transcript.tapeDigest)
          return verificationFailure('TRANSCRIPT_MISMATCH', 'Tape digest differs', '$.tapeDigest');
        const steps = deriveSteps(definition, truth, transcript.choices);
        if (!stepsEqual(steps, transcript.steps))
          return verificationFailure(
            'TRANSCRIPT_MISMATCH',
            'Steps differ from the logged decisions',
            '$.steps',
          );
        const expected = sealCommitment(
          seedHex,
          commitmentBody(definition, round, truth, steps, transcript.choices),
        );
        if (!constantTimeHexEqual(expected, transcript.commitment))
          return verificationFailure(
            'COMMITMENT_MISMATCH',
            'Commitment does not match revealed seed',
            '$.commitment',
          );
        return verificationSuccess(COMMITMENT_VERSION, expected);
      } catch (error) {
        return classifyVerificationError(error);
      }
    },
  });
