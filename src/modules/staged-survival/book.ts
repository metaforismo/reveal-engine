import { RevealEngineError, fail } from '../../api/errors.js';
import {
  CommandLedger,
  commandFingerprint,
  fromWireReceipt,
  toWireReceipt,
  type Receipt,
  type StoredReceipt,
  type WireReceipt,
} from '../../core/ledger.js';
import { assertClaimBudget } from '../../core/module.js';
import { payableWithinCap, type Payable } from '../../core/payments.js';
import { add, floor, multiply, rational, type Rational } from '../../core/rational.js';
import {
  assertSnapshotKeys,
  assertSnapshotRecord,
  assertSnapshotSize,
  assertWireHex,
  assertWireString,
  parseSnapshotJson,
  parseWireBigInt,
  snapshotHash,
} from '../../core/snapshot.js';
import { assertRational, isRecord } from '../../core/validation.js';
import { survivalFingerprint } from './adapter.js';
import { lanePartition } from './distribution.js';
import {
  SURVIVAL_ACTIONS,
  SURVIVAL_BOOK_SCHEMA,
  type SurvivalAction,
  type SurvivalChoice,
  type SurvivalDefinition,
  type SurvivalStep,
  type SurvivalTranscript,
} from './contracts.js';
import { choicesEqual, liveAfter, stepsEqual, verifySurvivalTranscript } from './fairness.js';
import {
  deserializeTranscript,
  parseEntityList,
  parseWireChoiceList,
  parseWireStepList,
  transcriptToWire,
} from './transcript.js';
import { assertSurvivalDefinition, assertSurvivalStake, contractFor } from './validation.js';

/**
 * Per-entity contingent claim.
 *
 * `value` is exact and unrounded for the whole round: it is floored **only** at
 * a credit boundary, never between stages, so a long ride loses nothing to
 * repeated rounding.
 */
export interface SurvivalClaim {
  readonly entity: number;
  readonly stake: bigint;
  readonly value: Rational;
  /** Still running: not failed, not banked. */
  readonly live: boolean;
  readonly banked: boolean;
}

interface EntryRecord {
  readonly entity: number;
  readonly stake: bigint;
}

interface BankRecord {
  /** Stage revision the bank was fenced to. */
  readonly stage: number;
  readonly entities: readonly number[];
}

/** Own, non-inherited property, in the shape the wire boundary also insists on. */
function ownArray(value: object, key: string): readonly unknown[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  const held = (value as Record<string, unknown>)[key];
  return Array.isArray(held) ? held : undefined;
}

function isEntityList(value: readonly unknown[] | undefined): value is readonly number[] {
  return value !== undefined && value.every((entity) => Number.isSafeInteger(entity));
}

/**
 * The structural shape of a step, before anything reads a field off it.
 *
 * `resolve()` is the one entry point that takes a step as a **raw object** from
 * its caller rather than through `parseWireStepList`, so it is the one place
 * where a missing or mistyped field would otherwise surface as a bare
 * `TypeError` from a spread or a `.length` — an untyped throw out of a
 * money-bearing command, which is exactly what this module promises not to do.
 * Driven before this existed: `{ ...step, survivors: undefined }`,
 * `failed: undefined`, `failed: 3` and `banked: undefined` all threw `TypeError`
 * rather than a typed refusal.
 *
 * Every field is read as an **own** property. A step assembled with its `lanes`
 * on a prototype was accepted before, and while the stored copy is rebuilt field
 * by field so nothing dangerous survived, the transcript wire boundary already
 * refuses inherited keys and there is no reason for the command surface to be
 * laxer than the wire.
 *
 * `restore()` does not call this: its steps arrive through `parseWireStepList`,
 * which enforces this shape and more (entity ranges, ordering, wire bounds). The
 * asymmetry is deliberate and is stated here rather than left to be rediscovered.
 */
function assertStepShape(step: unknown, path: string): asserts step is SurvivalStep {
  if (typeof step !== 'object' || step === null)
    fail('TRANSCRIPT_MISMATCH', 'Step must be an object', path);
  if (typeof (step as { contractId?: unknown }).contractId !== 'string')
    fail('TRANSCRIPT_MISMATCH', 'Step must name its contract', `${path}.contractId`);
  for (const key of ['banked', 'survivors', 'failed'] as const)
    if (!isEntityList(ownArray(step, key)))
      fail('TRANSCRIPT_MISMATCH', 'Step field must be an entity array', `${path}.${key}`);
  const lanes = ownArray(step, 'lanes');
  if (lanes === undefined)
    fail('TRANSCRIPT_MISMATCH', 'Step must carry its lane partition', `${path}.lanes`);
  for (const lane of lanes) {
    if (typeof lane !== 'object' || lane === null)
      fail('TRANSCRIPT_MISMATCH', 'Each lane must be an object', `${path}.lanes`);
    if (!isEntityList(ownArray(lane, 'entities')))
      fail('TRANSCRIPT_MISMATCH', 'Each lane must carry an entity array', `${path}.lanes`);
    if (typeof (lane as { collapsed?: unknown }).collapsed !== 'boolean')
      fail('TRANSCRIPT_MISMATCH', 'Each lane must declare whether it collapsed', `${path}.lanes`);
  }
}

/**
 * Everything about a step that can be checked **without the seed**, in one
 * place, for both callers.
 *
 * `resolve()` and `restore()` admit steps into the same money-bearing state, so
 * they owe the same admission test. Keeping the test in two hand-written copies
 * is what let them drift once already: `resolve()` checked the resolved set and
 * skipped the lane geometry that `restore()` re-derives, so the live path
 * accepted steps whose books could take a `bank()` credit and then never
 * reconnect. One function, two call sites, one order of checks — the drift is
 * now a compile-time impossibility rather than a review obligation.
 *
 * What is checked here is the whole seed-free part of a step:
 *
 * 1. the resolved set is exactly the running field, from both sides;
 * 2. the lane partition is exactly `lanePartition(contract, field)` — the
 *    geometry is a function of the contract and the field, never a free
 *    variable the caller supplies;
 * 3. a collapsed lane takes every entity in it, which is the lane model's
 *    defining rule (§2 of the module doc).
 *
 * What is **not** checked here is the only thing left: the committed draw bits
 * that decide which non-collapsed entities cleared. Those need the seed, and
 * neither caller holds one — `settle()` does, and that is where they are
 * checked. Both callers are documented as making that trade deliberately.
 */
function assertStepGeometry(
  definition: SurvivalDefinition,
  step: SurvivalStep,
  field: readonly number[],
  code: 'TRANSCRIPT_MISMATCH' | 'INVALID_SNAPSHOT',
  path: string,
): void {
  const running = new Set(field);
  const survivors = new Set(step.survivors);
  const failed = new Set(step.failed);
  // Set equality is established from both sides — the counts match, and every
  // resolved entity is running — so a step cannot quietly swap a banked entity
  // in for a live one, and cannot name one entity twice to cover a missing one.
  if (
    survivors.size !== step.survivors.length ||
    failed.size !== step.failed.length ||
    survivors.size + failed.size !== running.size ||
    [...survivors, ...failed].some((entity) => !running.has(entity))
  )
    fail(code, 'Step does not resolve exactly the running field', path);
  const contract = contractFor(definition, step.contractId, field.length);
  const lanes = lanePartition(contract, field);
  if (
    step.lanes.length !== lanes.length ||
    step.lanes.some((lane, laneIndex) => {
      const expected = lanes[laneIndex] as readonly number[];
      return (
        lane.entities.length !== expected.length ||
        lane.entities.some((entity, position) => entity !== expected[position])
      );
    })
  )
    fail(code, 'Lane partition does not match the chosen geometry', `${path}.lanes`);
  for (const lane of step.lanes)
    if (lane.collapsed && lane.entities.some((entity) => !failed.has(entity)))
      fail(code, 'A collapsed lane reports a survivor', `${path}.lanes`);
}

/** Value of every entity after `stageCount` resolved stages. Exact, never floored. */
function replayValues(
  definition: SurvivalDefinition,
  steps: readonly SurvivalStep[],
  entries: readonly EntryRecord[],
  stageCount: number,
): Map<number, Rational> {
  const entry = rational(
    definition.pricing.entryReturn.numerator,
    definition.pricing.entryReturn.denominator,
  );
  const values = new Map<number, Rational>(
    entries.map((record) => [record.entity, multiply(rational(record.stake), entry)]),
  );
  for (let stage = 0; stage < stageCount; stage += 1) {
    const step = steps[stage];
    if (step === undefined) fail('INVALID_SNAPSHOT', 'Step log is shorter than the stage count');
    const contract = contractFor(
      definition,
      step.contractId,
      step.survivors.length + step.failed.length,
    );
    const multiplier = rational(contract.multiplier.numerator, contract.multiplier.denominator);
    for (const entity of step.survivors) {
      const current = values.get(entity);
      if (current !== undefined) values.set(entity, multiply(current, multiplier));
    }
    for (const entity of step.failed) if (values.has(entity)) values.set(entity, rational(0n));
  }
  return values;
}

/**
 * Multi-claim book with partial settlement.
 *
 * Every entity carries its own externally funded claim, so every entry raises
 * the round's cap basis and the ceiling is proportional to everything the player
 * risked. A stage is chosen before it resolves, so `choose()` logs the decision
 * as a fenced, idempotent command and `resolve()` applies the step the module
 * derived from (tape, choices). Between stages the player may bank any subset of
 * the entities still running; each banked subset is a partial credit against the
 * one shared round ceiling.
 *
 * `settle()` is required on every path, including a round where everything has
 * already been banked or has failed: it is the only call that takes the revealed
 * seed, and a round whose seed is never revealed is a round nobody can verify.
 */
export class SurvivalBook {
  readonly #ledger: CommandLedger;
  readonly #claims = new Map<number, SurvivalClaim>();
  readonly #entries: EntryRecord[] = [];
  readonly #choices: SurvivalChoice[] = [];
  readonly #steps: SurvivalStep[] = [];
  readonly #banks: BankRecord[] = [];
  #pendingBanked: number[] = [];
  #stageRevision = 0;
  #terminal = false;
  #settlementCommitment: string | undefined;

  constructor(readonly definition: SurvivalDefinition) {
    assertSurvivalDefinition(definition);
    this.#ledger = new CommandLedger({ maxWinMultiple: definition.risk.maxWinMultiple });
  }

  get claims(): readonly SurvivalClaim[] {
    return Object.freeze(
      [...this.#claims.values()].sort((left, right) => left.entity - right.entity),
    );
  }
  get choices(): readonly SurvivalChoice[] {
    return Object.freeze([...this.#choices]);
  }
  get steps(): readonly SurvivalStep[] {
    return Object.freeze([...this.#steps]);
  }
  get stageRevision(): number {
    return this.#stageRevision;
  }
  get ledgerRevision(): number {
    return this.#ledger.ledgerRevision;
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
  /** Entities still running: entered, not failed, not banked. */
  get live(): readonly number[] {
    return Object.freeze(this.claims.filter((claim) => claim.live).map((claim) => claim.entity));
  }

  #assertEntity(entity: unknown, path: string): asserts entity is number {
    if (
      typeof entity !== 'number' ||
      !Number.isSafeInteger(entity) ||
      entity < 0 ||
      entity >= this.definition.entities
    )
      fail('CLAIM_REJECTED', 'Unknown entity', path);
  }

  /** Contracts the menu offers right now. Empty when the field is empty. */
  menu(): readonly string[] {
    const liveCount = this.live.length;
    return Object.freeze(
      this.definition.contracts
        .filter((contract) => contract.minEntities <= liveCount)
        .map((contract) => contract.id),
    );
  }

  /**
   * One externally funded claim per entity. Every entity must be funded before
   * the round's first decision: the field is the definition's whole entity set,
   * and step derivation starts from it.
   *
   * An entry can never follow a bank either, and that is a consequence rather
   * than a second guard: `bank()` refuses until every entity is funded, at which
   * point every entity id is taken and the duplicate check below refuses. That
   * is what lets `restore()` reject an `enter` receipt seen after a `bank` one
   * without rejecting a state the live path can actually produce.
   */
  async enter(key: string, entity: number, stake: bigint): Promise<Receipt<SurvivalAction>> {
    // Arguments are validated **before** the fingerprint is computed, not inside
    // the guarded operation. `commandFingerprint` runs the canonical encoder,
    // and a hostile argument that reaches it surfaces the encoder's taxonomy
    // instead of the book's — a typed `CLAIM_REJECTED` turning into whatever the
    // encoder happened to raise.
    this.#assertEntity(entity, '$.entity');
    assertSurvivalStake(stake, '$.stake');
    const fingerprint = commandFingerprint('enter', [entity, stake]);
    return this.#ledger.execute<SurvivalAction>(key, fingerprint, () => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is terminal');
      if (this.#stageRevision !== 0 || this.#choices.length !== 0)
        fail('CLAIM_REJECTED', 'Entries close once the first decision is logged');
      if (this.#claims.has(entity)) fail('CLAIM_REJECTED', 'Entity already entered', '$.entity');
      assertClaimBudget(this.#claims.size, this.definition.entities);
      const receipt = this.#ledger.mint(
        key,
        fingerprint,
        'enter',
        this.#stageRevision,
        stake,
        0n,
        false,
      );
      this.#ledger.fundStake(stake, 'external');
      this.#entries.push(Object.freeze({ entity, stake }));
      this.#claims.set(
        entity,
        Object.freeze({
          entity,
          stake,
          // The margin is charged exactly once, here. Every later stage is fair.
          value: multiply(
            rational(stake),
            rational(
              this.definition.pricing.entryReturn.numerator,
              this.definition.pricing.entryReturn.denominator,
            ),
          ),
          live: true,
          banked: false,
        }),
      );
      return receipt;
    });
  }

  /**
   * Logs the decision for the next stage, before that stage resolves.
   *
   * The subset banked since the last resolution is folded into the decision
   * here, because it changes which entities are at risk and therefore the step.
   * Once a stage is chosen, banking for that stage is closed.
   */
  async choose(key: string, contractId: string): Promise<Receipt<SurvivalAction>> {
    if (typeof contractId !== 'string' || contractId.length === 0)
      fail('INVALID_CHOICE', 'Stage contract id must be a string', '$.contractId');
    const banked = Object.freeze([...this.#pendingBanked].sort((left, right) => left - right));
    const fingerprint = commandFingerprint('choose', [
      this.#stageRevision,
      contractId,
      banked.length,
      ...banked,
    ]);
    return this.#ledger.execute<SurvivalAction>(key, fingerprint, () => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is terminal');
      if (this.#choices.length !== this.#stageRevision)
        fail('CLAIM_REJECTED', 'A decision for this stage is already logged', '$.choice');
      if (this.#stageRevision >= this.definition.stages)
        fail('CLAIM_REJECTED', 'Every stage has resolved', '$.choice');
      if (this.#claims.size !== this.definition.entities)
        fail('CLAIM_REJECTED', 'Every entity must be funded before the first decision', '$.claims');
      contractFor(this.definition, contractId, this.live.length);
      const receipt = this.#ledger.mint(
        key,
        fingerprint,
        'choose',
        this.#stageRevision,
        0n,
        0n,
        false,
      );
      this.#choices.push(Object.freeze({ contractId, banked }));
      this.#pendingBanked = [];
      return receipt;
    });
  }

  /**
   * Applies the step the module derived from (tape, logged choices).
   *
   * The step is checked against the decision it claims to resolve — same stage,
   * same contract, same banked subset — so a step derived from a different log
   * cannot be walked into this book.
   */
  async resolve(step: SurvivalStep): Promise<number> {
    return this.#ledger.serial(() => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is terminal');
      const choice = this.#choices[this.#stageRevision];
      if (choice === undefined)
        fail('CLAIM_REJECTED', 'No decision is logged for this stage', '$.step');
      if (step?.index !== this.#stageRevision)
        fail('STALE_FRAME', 'Stage step is out of order', '$.step.index');
      // Shape before semantics: every later check reads fields off this object,
      // and a raw object is what this entry point accepts.
      assertStepShape(step, '$.step');
      if (!choicesEqual([choice], [{ contractId: step.contractId, banked: step.banked }]))
        fail('TRANSCRIPT_MISMATCH', 'Step does not resolve the logged decision', '$.step');
      // Compute before mutate: the whole step is checked against the running
      // field first — the resolved set, the lane geometry and the collapsed-lane
      // rule, exactly what `restore()` re-derives — so a step that resolves the
      // wrong set, or reports a geometry the chosen contract does not produce,
      // leaves the book untouched instead of half-applied. Sharing
      // `assertStepGeometry` with `restore()` is the point: a step this call
      // accepts is a step a later `restore()` accepts, so a round can never be
      // credited into a state it cannot be reconnected from.
      const field = this.live;
      assertStepGeometry(this.definition, step, field, 'TRANSCRIPT_MISMATCH', '$.step');
      const contract = contractFor(this.definition, step.contractId, field.length);
      const survivors = new Set(step.survivors);

      const multiplier = rational(contract.multiplier.numerator, contract.multiplier.denominator);
      for (const claim of this.claims) {
        if (!claim.live) continue;
        this.#claims.set(
          claim.entity,
          Object.freeze(
            survivors.has(claim.entity)
              ? { ...claim, value: multiply(claim.value, multiplier) }
              : { ...claim, live: false, value: rational(0n) },
          ),
        );
      }
      // Stored as a canonical frozen copy rather than as the caller's object: it
      // becomes part of the book's money-bearing state, and a caller that could
      // mutate it afterwards could rewrite a settled round's history.
      this.#steps.push(
        Object.freeze({
          index: step.index,
          contractId: step.contractId,
          banked: Object.freeze([...step.banked]),
          lanes: Object.freeze(
            step.lanes.map((lane) =>
              Object.freeze({
                entities: Object.freeze([...lane.entities]),
                collapsed: lane.collapsed,
              }),
            ),
          ),
          survivors: Object.freeze([...step.survivors]),
          failed: Object.freeze([...step.failed]),
        }),
      );
      this.#stageRevision += 1;
      return this.#stageRevision;
    });
  }

  /**
   * Partial settlement: bank a subset of the entities still running.
   *
   * Banking happens repeatedly inside one round, which is exactly the shape that
   * punishes a forgotten `applyCredit`. `creditClaim` makes the pair one call,
   * so every banked subset is measured against the balance the last one left
   * behind, and the round ceiling holds across the whole chain.
   *
   * It carries the same full-funding guard as `choose()`, and for the same
   * reason: banking is a money-bearing command, so the moment one succeeds the
   * round has a credited receipt and entries must already be closed. Without the
   * guard `enter -> bank -> enter` is accepted here and is a state `restore()`
   * refuses for the rest of the round's life — a round holding real credit that
   * no reconnect can reconstitute.
   */
  async bank(key: string, entities: readonly number[]): Promise<Receipt<SurvivalAction>> {
    if (!Array.isArray(entities) || entities.length > this.definition.entities)
      fail('CLAIM_REJECTED', 'Bank subset is not a bounded array', '$.entities');
    for (const entity of entities) this.#assertEntity(entity, '$.entities');
    const chosen = Object.freeze([...entities].sort((left, right) => left - right));
    const fingerprint = commandFingerprint('bank', [this.#stageRevision, chosen.length, ...chosen]);
    return this.#ledger.execute<SurvivalAction>(key, fingerprint, () => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is terminal');
      if (this.#choices.length !== this.#stageRevision)
        fail('CLAIM_REJECTED', 'This stage is already committed; banking is closed', '$.entities');
      if (this.#claims.size !== this.definition.entities)
        fail('CLAIM_REJECTED', 'Every entity must be funded before the first bank', '$.claims');
      if (chosen.length === 0) fail('CLAIM_REJECTED', 'Nothing to bank', '$.entities');
      let previous = -1;
      let total = rational(0n);
      for (const entity of chosen) {
        if (entity === previous) fail('CLAIM_REJECTED', 'Duplicate entity', '$.entities');
        previous = entity;
        const claim = this.#claims.get(entity);
        if (!claim || !claim.live || claim.banked)
          fail('CLAIM_REJECTED', 'Entity is not bankable', '$.entities');
        total = add(total, claim.value);
      }
      return this.#ledger.creditClaim(total, (result) => {
        const receipt = this.#ledger.mint(
          key,
          fingerprint,
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
        this.#banks.push(Object.freeze({ stage: this.#stageRevision, entities: chosen }));
        this.#pendingBanked = [...this.#pendingBanked, ...chosen];
        return receipt;
      });
    });
  }

  /**
   * Settles what is still at risk against the revealed proof.
   *
   * The transcript must be *this* round's: same decision log, same resolved
   * steps. A settlement proof for a different decision sequence is refused here
   * even though it verifies on its own, because it is not what this book played.
   */
  async settle(
    key: string,
    revealedSeed: string,
    transcript: SurvivalTranscript,
  ): Promise<Receipt<SurvivalAction>> {
    const commitment = typeof transcript?.commitment === 'string' ? transcript.commitment : '';
    const fingerprint = commandFingerprint('settle', [commitment]);
    return this.#ledger.execute<SurvivalAction>(key, fingerprint, () => {
      if (this.#terminal) fail('ROUND_TERMINAL', 'Round is already terminal');
      if (this.#claims.size === 0) fail('CLAIM_REJECTED', 'Round has taken no stake', '$.claims');
      if (this.#choices.length !== this.#stageRevision)
        fail('CLAIM_REJECTED', 'A logged decision has not been resolved', '$.choices');
      // The proof is re-derived through the module's own verifier, on the **wire**
      // form, so settlement is held to exactly what a third party would check —
      // not to a privileged in-memory object the book happens to hold.
      const verification = verifySurvivalTranscript(
        revealedSeed,
        this.definition,
        transcriptToWire(transcript),
        deserializeTranscript,
      );
      if (!verification.ok)
        fail('INVALID_TRANSCRIPT', verification.message, verification.path, {
          verificationCode: verification.code,
        });
      if (
        !choicesEqual(transcript.choices, this.#choices) ||
        !stepsEqual(transcript.steps, this.#steps)
      )
        fail(
          'TRANSCRIPT_MISMATCH',
          'Settlement proof is for a different decision log',
          '$.choices',
        );
      let total = rational(0n);
      for (const claim of this.claims) if (claim.live) total = add(total, claim.value);
      return this.#ledger.creditClaim(total, (result) => {
        const receipt = this.#ledger.mint(
          key,
          fingerprint,
          'settle',
          this.#stageRevision,
          0n,
          result.credited,
          result.capped,
        );
        for (const claim of this.claims)
          this.#claims.set(claim.entity, Object.freeze({ ...claim, live: false }));
        this.#settlementCommitment = transcript.commitment;
        this.#terminal = true;
        return receipt;
      });
    });
  }

  snapshot(): object {
    const capBasisStake = this.#ledger.capBasisStake;
    const base = {
      schema: SURVIVAL_BOOK_SCHEMA,
      definition: { id: this.definition.id, fingerprint: survivalFingerprint(this.definition) },
      terminal: this.#terminal,
      stageRevision: this.#stageRevision,
      ledgerRevision: this.#ledger.ledgerRevision,
      // The two logs a reconnect must not lose: the settlement proof is a
      // function of the decisions, and every claim value is a function of the
      // steps, so both are money-bearing state and both are re-validated.
      choices: this.#choices.map((choice) => ({
        contractId: choice.contractId,
        banked: [...choice.banked],
      })),
      steps: this.#steps.map((step) => ({
        index: step.index,
        contractId: step.contractId,
        banked: [...step.banked],
        lanes: step.lanes.map((lane) => ({
          entities: [...lane.entities],
          collapsed: lane.collapsed,
        })),
        survivors: [...step.survivors],
        failed: [...step.failed],
      })),
      pendingBanked: [...this.#pendingBanked].sort((left, right) => left - right),
      entries: this.#entries.map((entry) => ({ entity: entry.entity, stake: String(entry.stake) })),
      banks: this.#banks.map((entry) => ({ stage: entry.stage, entities: [...entry.entities] })),
      settlementCommitment: this.#settlementCommitment ?? null,
      liquidBalance: String(this.#ledger.liquidBalance),
      capBasisStake: capBasisStake === undefined ? null : String(capBasisStake),
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
   * Nothing money-bearing is read out of the snapshot. Every claim's value and
   * liveness are **re-derived** from the entry stakes and the replayed steps;
   * every credited figure is **recomputed** with the same cap arithmetic the
   * live path used and compared against its receipt; and every receipt's
   * `commandFingerprint` is recomputed from the restored state, so a rewritten
   * entry, decision, or bank subset cannot survive its own ledger under a
   * freshly computed checksum.
   */
  static restore(definition: SurvivalDefinition, input: string | object): SurvivalBook {
    assertSurvivalDefinition(definition);
    const raw = parseSurvivalSnapshot(input);
    if (
      raw.definition.id !== definition.id ||
      raw.definition.fingerprint !== survivalFingerprint(definition)
    )
      fail('DEFINITION_MISMATCH', 'Snapshot belongs to another definition', '$.definition');

    const book = new SurvivalBook(definition);
    book.#terminal = raw.terminal;
    book.#stageRevision = raw.stageRevision;
    book.#settlementCommitment = raw.settlementCommitment ?? undefined;
    if (
      raw.stageRevision > definition.stages ||
      raw.steps.length !== raw.stageRevision ||
      raw.choices.length < raw.stageRevision ||
      raw.choices.length > raw.stageRevision + 1 ||
      raw.choices.length > definition.stages
    )
      fail('INVALID_SNAPSHOT', 'Stage revision does not match the decision log', '$.stageRevision');
    if (raw.terminal !== (raw.settlementCommitment !== null))
      fail('INVALID_SNAPSHOT', 'A terminal round is exactly a settled round', '$.terminal');

    // The steps must be the resolutions of the decisions, contract for contract
    // and banked subset for banked subset, before a single value is derived.
    //
    // Everything about a step that does not need the seed is re-derived here:
    // the field it ran, the lane partition that field produces under the chosen
    // contract, and the rule that a collapsed lane takes every entity in it. The
    // only free variables left are the committed draw bits themselves, and those
    // are checked at settlement against the revealed seed — `restore()` does not
    // hold one, and does not pretend to.
    let field: readonly number[] = Object.freeze(
      Array.from({ length: definition.entities }, (_entity, index) => index),
    );
    raw.steps.forEach((step, index) => {
      const path = `$.steps[${index}]`;
      const choice = raw.choices[index];
      if (
        choice === undefined ||
        !choicesEqual([choice], [{ contractId: step.contractId, banked: step.banked }])
      )
        fail('INVALID_SNAPSHOT', 'Step does not resolve its logged decision', path);
      const running = new Set(field);
      for (const entity of step.banked) {
        if (!running.has(entity))
          fail('INVALID_SNAPSHOT', 'A banked entity was not running', `${path}.banked`);
        running.delete(entity);
      }
      field = Object.freeze([...running].sort((left, right) => left - right));
      if (field.length === 0) fail('INVALID_SNAPSHOT', 'A step resolved an empty field', path);
      assertStepGeometry(definition, step, field, 'INVALID_SNAPSHOT', path);
      book.#choices.push(choice);
      book.#steps.push(step);
      field = step.survivors;
    });
    // The trailing decision — logged, not yet resolved — is the one choice in
    // the snapshot that no step is checked against, so nothing above has
    // re-validated it. It has to run the admission test `choose()` runs, from
    // the same call, or `restore()` admits a state the live path refuses.
    //
    // What that costs is availability on a round holding money, which is this
    // module's recurring failure shape and the one §7.3 promises against: a
    // pending decision naming an unknown contract, or one the menu does not
    // offer at the field it faces, restores with its credit already standing and
    // then has no legal move left — `resolve()` fails on the contract,
    // `settle()` refuses because a decision is unresolved, and `bank()` refuses
    // because one is pending. No value is created and the cap is untouched; the
    // round simply cannot be finished.
    //
    // The field is derived the way `deriveSteps()` derives it: the survivors of
    // the last resolved step, minus the subset this decision withdrew.
    const pending = raw.choices[raw.stageRevision];
    if (pending !== undefined) {
      const path = `$.choices[${raw.stageRevision}]`;
      const running = new Set(field);
      for (const entity of pending.banked) {
        if (!running.has(entity))
          fail(
            'INVALID_SNAPSHOT',
            'A pending decision banks an entity that was not running',
            `${path}.banked`,
          );
        running.delete(entity);
      }
      try {
        contractFor(definition, pending.contractId, running.size);
      } catch (error) {
        fail(
          'INVALID_SNAPSHOT',
          error instanceof RevealEngineError
            ? error.message
            : 'Pending decision does not name a contract of this definition',
          `${path}.contractId`,
        );
      }
      book.#choices.push(pending);
    }

    const seen = new Set<number>();
    for (const entry of raw.entries) {
      if (
        !Number.isSafeInteger(entry.entity) ||
        entry.entity < 0 ||
        entry.entity >= definition.entities ||
        seen.has(entry.entity)
      )
        fail('INVALID_SNAPSHOT', 'Entry list is not a distinct entity set', '$.entries');
      // Held to exactly the width `enter()` accepts. The snapshot codec bounds a
      // wire BigInt by the engine limit, which is far wider than any stake this
      // module will take — and a restored entry wider than that would overflow
      // in `replayValues()` below, surfacing as `INVALID_RATIONAL` rather than
      // as the rejected snapshot it is.
      assertSurvivalStake(entry.stake, '$.entries', 'INVALID_SNAPSHOT');
      seen.add(entry.entity);
      book.#entries.push(Object.freeze({ entity: entry.entity, stake: entry.stake }));
    }
    // Both money-bearing commands close entries, so both imply a fully funded
    // field. `bank` is included because it credits: a snapshot that carries a
    // bank receipt over a partial field is a round the live path cannot open.
    if (
      (book.#choices.length > 0 || raw.banks.length > 0) &&
      book.#entries.length !== definition.entities
    )
      fail(
        'INVALID_SNAPSHOT',
        'A round with a logged decision or bank must have every entity funded',
        '$.entries',
      );

    // Values are derived, never read. `valuesAt[t]` is the exact value of every
    // entity after `t` resolved stages, which is what a bank fenced to stage `t`
    // credited and what a settlement at `stageRevision` credits.
    const valuesAt: Map<number, Rational>[] = [];
    for (let stage = 0; stage <= raw.stageRevision; stage += 1)
      valuesAt.push(replayValues(definition, book.#steps, book.#entries, stage));

    // A decision folds the pending subset into its own banked list and clears
    // it, and `bank()` is closed while a decision is pending. So a snapshot that
    // carries both an unresolved decision and an uncommitted subset is a state
    // the live path cannot reach, and it is refused here rather than restored:
    // followed forward it re-folds the stale entity into the *next* decision,
    // and the round can then never produce a valid transcript or be settled.
    if (raw.pendingBanked.length > 0 && raw.choices.length === raw.stageRevision + 1)
      fail(
        'INVALID_SNAPSHOT',
        'A pending decision has already absorbed the banked subset',
        '$.pendingBanked',
      );

    // The decision log and the ledger both record who was withdrawn, and they
    // are independent artifacts: a rewritten bank subset in one must contradict
    // the other. Every logged decision carries its banked subset, including a
    // decision that has not resolved yet, plus whatever was banked at the
    // current boundary and not yet committed to a decision.
    //
    // The two sources are read as a **disjoint** union, not as a set union: an
    // entity is withdrawn exactly once, so the same entity appearing twice is a
    // contradiction in its own right and must not be allowed to collapse into
    // one element and pass the count check below.
    const bankedFromLog = new Set<number>();
    const withdrawOnce = (entity: number, path: string): void => {
      if (bankedFromLog.has(entity))
        fail('INVALID_SNAPSHOT', 'An entity is withdrawn twice in the decision log', path);
      bankedFromLog.add(entity);
    };
    book.#choices.forEach((choice, index) => {
      for (const entity of choice.banked) withdrawOnce(entity, `$.choices[${index}].banked`);
    });
    for (const entity of raw.pendingBanked) withdrawOnce(entity, '$.pendingBanked');
    const bankedFromLedger = new Set<number>();
    let bankedCount = 0;
    for (const record of raw.banks)
      for (const entity of record.entities) {
        if (bankedFromLedger.has(entity))
          fail('INVALID_SNAPSHOT', 'An entity was banked twice', '$.banks');
        bankedFromLedger.add(entity);
        bankedCount += 1;
      }
    if (
      bankedCount !== bankedFromLog.size ||
      bankedFromLog.size !== bankedFromLedger.size ||
      [...bankedFromLog].some((entity) => !bankedFromLedger.has(entity))
    )
      fail('INVALID_SNAPSHOT', 'Banked entities disagree with the bank command log', '$.banks');

    const finalValues = valuesAt[raw.stageRevision] as Map<number, Rational>;
    const running = new Set(raw.stageRevision === 0 ? seen : liveAfter(definition, book.#steps));
    for (const entry of book.#entries) {
      const banked = bankedFromLedger.has(entry.entity);
      const live = !raw.terminal && !banked && running.has(entry.entity);
      book.#claims.set(
        entry.entity,
        Object.freeze({
          entity: entry.entity,
          stake: entry.stake,
          value: finalValues.get(entry.entity) ?? rational(0n),
          live,
          banked,
        }),
      );
    }

    let staked = 0n;
    let entries = 0;
    let chooses = 0;
    let banks = 0;
    let liquid = 0n;
    let settled = false;
    const basis = book.#entries.reduce((total, entry) => total + entry.stake, 0n);
    const stored: StoredReceipt<SurvivalAction>[] = raw.receipts.map((entry) => ({
      fingerprint: entry.fingerprint,
      receipt: fromWireReceipt<SurvivalAction>(entry.receipt, SURVIVAL_ACTIONS),
    }));
    /**
     * Recomputes a credit with the live path's own cap arithmetic.
     *
     * A round that took no stake has no ceiling, so a credit receipt in one is a
     * contradiction the snapshot has to be rejected for — not an arithmetic
     * error surfaced from the payment primitive.
     */
    const recredit = (theoretical: Rational): Payable => {
      if (basis <= 0n)
        fail('INVALID_SNAPSHOT', 'Snapshot credits a round that took no stake', '$.receipts');
      return payableWithinCap(theoretical, basis, definition.risk.maxWinMultiple, liquid);
    };
    book.#ledger.install(stored, book.#stageRevision, (receipt) => {
      if (settled) fail('INVALID_SNAPSHOT', 'Receipts continue past settlement');
      if (receipt.action === 'enter') {
        const entry = book.#entries[entries];
        if (
          chooses > 0 ||
          banks > 0 ||
          entry === undefined ||
          receipt.credited !== 0n ||
          receipt.debited !== entry.stake ||
          receipt.frameRevision !== 0 ||
          receipt.commandFingerprint !== commandFingerprint('enter', [entry.entity, entry.stake])
        )
          fail('INVALID_SNAPSHOT', 'Receipt does not match the restored entry', '$.entries');
        staked += receipt.debited;
        entries += 1;
      } else if (receipt.action === 'choose') {
        const choice = book.#choices[chooses];
        if (
          choice === undefined ||
          receipt.debited !== 0n ||
          receipt.credited !== 0n ||
          receipt.frameRevision !== chooses ||
          receipt.commandFingerprint !==
            commandFingerprint('choose', [
              chooses,
              choice.contractId,
              choice.banked.length,
              ...choice.banked,
            ])
        )
          fail('INVALID_SNAPSHOT', 'Receipt does not match the logged decision', '$.choices');
        chooses += 1;
      } else if (receipt.action === 'bank') {
        const record = raw.banks[banks];
        if (
          record === undefined ||
          receipt.debited !== 0n ||
          receipt.frameRevision !== record.stage ||
          record.stage > raw.stageRevision ||
          receipt.commandFingerprint !==
            commandFingerprint('bank', [record.stage, record.entities.length, ...record.entities])
        )
          fail('INVALID_SNAPSHOT', 'Receipt does not match the logged bank', '$.banks');
        const stageValues = valuesAt[record.stage] as Map<number, Rational>;
        let theoretical = rational(0n);
        for (const entity of record.entities)
          theoretical = add(theoretical, stageValues.get(entity) ?? rational(0n));
        const expected = recredit(theoretical);
        if (receipt.credited !== expected.credited || receipt.capped !== expected.capped)
          fail(
            'INVALID_SNAPSHOT',
            'Banked credit does not match the replayed claim value',
            '$.banks',
          );
        liquid += expected.credited;
        banks += 1;
      } else {
        let theoretical = rational(0n);
        for (const entity of running)
          if (!bankedFromLedger.has(entity))
            theoretical = add(theoretical, finalValues.get(entity) ?? rational(0n));
        const expected = recredit(theoretical);
        if (
          receipt.debited !== 0n ||
          receipt.frameRevision !== raw.stageRevision ||
          receipt.credited !== expected.credited ||
          receipt.capped !== expected.capped ||
          raw.settlementCommitment === null ||
          receipt.commandFingerprint !== commandFingerprint('settle', [raw.settlementCommitment])
        )
          fail('INVALID_SNAPSHOT', 'Receipt does not match the replayed settlement', '$.receipts');
        liquid += expected.credited;
        settled = true;
      }
    });
    const capBasisStake =
      raw.capBasisStake === null
        ? undefined
        : parseWireBigInt(raw.capBasisStake, '$.capBasisStake');
    if (
      entries !== book.#claims.size ||
      chooses !== book.#choices.length ||
      banks !== raw.banks.length ||
      settled !== raw.terminal ||
      (entries === 0) !== (capBasisStake === undefined) ||
      (capBasisStake !== undefined && capBasisStake !== staked)
    )
      fail('INVALID_SNAPSHOT', 'Snapshot state invariants failed');
    if (liquid !== parseWireBigInt(raw.liquidBalance, '$.liquidBalance', true))
      fail('INVALID_SNAPSHOT', 'Snapshot accounting does not conserve liquid value');
    for (const record of raw.banks) book.#banks.push(record);
    book.#pendingBanked = [...raw.pendingBanked];
    book.#ledger.restoreBalances({
      ledgerRevision: raw.ledgerRevision,
      liquidBalance: liquid,
      capBasisStake,
    });
    return book;
  }

  /** Exact banked value of one claim, floored at the credit boundary only. */
  static bankableAmount(claim: SurvivalClaim): bigint {
    if (!isRecord(claim)) fail('CLAIM_REJECTED', 'Expected a claim', '$.claim');
    assertRational(claim.value, '$.claim.value');
    return floor(claim.value);
  }
}

interface SurvivalSnapshot {
  readonly schema: typeof SURVIVAL_BOOK_SCHEMA;
  readonly definition: { readonly id: string; readonly fingerprint: string };
  readonly terminal: boolean;
  readonly stageRevision: number;
  readonly ledgerRevision: number;
  readonly choices: readonly SurvivalChoice[];
  readonly steps: readonly SurvivalStep[];
  readonly pendingBanked: readonly number[];
  readonly entries: readonly EntryRecord[];
  readonly banks: readonly BankRecord[];
  readonly settlementCommitment: string | null;
  readonly liquidBalance: string;
  readonly capBasisStake: string | null;
  readonly receipts: readonly { readonly fingerprint: string; readonly receipt: WireReceipt }[];
  readonly snapshotHash: string;
}

const SNAPSHOT_KEYS = Object.freeze([
  'schema',
  'definition',
  'terminal',
  'stageRevision',
  'ledgerRevision',
  'choices',
  'steps',
  'pendingBanked',
  'entries',
  'banks',
  'settlementCommitment',
  'liquidBalance',
  'capBasisStake',
  'receipts',
  'snapshotHash',
]);

/** Runs a transcript-grade structural parse, reporting failures in snapshot taxonomy. */
function asSnapshotFailure<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof RevealEngineError) fail('INVALID_SNAPSHOT', error.message, error.path);
    throw error;
  }
}

function parseSurvivalSnapshot(input: string | object): SurvivalSnapshot {
  const value: unknown = typeof input === 'string' ? parseSnapshotJson(input) : input;
  const candidate = assertSnapshotRecord(value, '$');
  assertSnapshotKeys(candidate, SNAPSHOT_KEYS, '$');
  // The checksum is compared over the payload as it arrived, before any field is
  // reshaped. It detects corruption and nothing else: anyone who can rewrite a
  // field can recompute the hash over it, which is why every semantic check
  // below is independent of it.
  assertWireHex(candidate.snapshotHash, '$.snapshotHash');
  if (candidate.snapshotHash !== snapshotHash({ ...candidate, snapshotHash: undefined }))
    fail('INVALID_SNAPSHOT', 'Snapshot hash is invalid', '$.snapshotHash');
  if (
    candidate.schema !== SURVIVAL_BOOK_SCHEMA ||
    typeof candidate.terminal !== 'boolean' ||
    !Number.isSafeInteger(candidate.stageRevision) ||
    (candidate.stageRevision as number) < 0 ||
    !Number.isSafeInteger(candidate.ledgerRevision) ||
    (candidate.ledgerRevision as number) < 0 ||
    !Array.isArray(candidate.entries) ||
    !Array.isArray(candidate.banks) ||
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
  if (candidate.settlementCommitment !== null)
    assertWireHex(candidate.settlementCommitment, '$.settlementCommitment');

  const choices = asSnapshotFailure(() => parseWireChoiceList(candidate.choices, '$.choices'));
  const steps = asSnapshotFailure(() => parseWireStepList(candidate.steps, '$.steps'));
  const pendingBanked = asSnapshotFailure(() =>
    parseEntityList(candidate.pendingBanked, '$.pendingBanked'),
  );

  const entries = candidate.entries.map((item, index) => {
    const entry = assertSnapshotRecord(item, `$.entries[${index}]`);
    assertSnapshotKeys(entry, ['entity', 'stake'], `$.entries[${index}]`);
    assertWireString(entry.stake, `$.entries[${index}].stake`);
    if (!Number.isSafeInteger(entry.entity) || (entry.entity as number) < 0)
      fail('INVALID_SNAPSHOT', 'Entry entity is invalid', `$.entries[${index}].entity`);
    return Object.freeze({
      entity: entry.entity as number,
      stake: parseWireBigInt(entry.stake as string, `$.entries[${index}].stake`),
    });
  });
  const banks = candidate.banks.map((item, index) => {
    const record = assertSnapshotRecord(item, `$.banks[${index}]`);
    assertSnapshotKeys(record, ['stage', 'entities'], `$.banks[${index}]`);
    if (!Number.isSafeInteger(record.stage) || (record.stage as number) < 0)
      fail('INVALID_SNAPSHOT', 'Bank stage is invalid', `$.banks[${index}].stage`);
    const entities = asSnapshotFailure(() =>
      parseEntityList(record.entities, `$.banks[${index}].entities`),
    );
    if (entities.length === 0)
      fail('INVALID_SNAPSHOT', 'A bank command must name at least one entity', `$.banks[${index}]`);
    return Object.freeze({ stage: record.stage as number, entities });
  });
  candidate.receipts.forEach((item, index) => {
    const entry = assertSnapshotRecord(item, `$.receipts[${index}]`);
    assertSnapshotKeys(entry, ['fingerprint', 'receipt'], `$.receipts[${index}]`);
    assertWireHex(entry.fingerprint, `$.receipts[${index}].fingerprint`);
  });
  assertSnapshotSize(candidate);
  return {
    ...(candidate as unknown as SurvivalSnapshot),
    choices,
    steps,
    pendingBanked,
    entries,
    banks,
  };
}
