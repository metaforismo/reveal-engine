import { fail } from '../../api/errors.js';
import { constantTimeHexEqual, sealCommitment, sealSeedCommitment } from '../../core/commitment.js';
import { samplerScopeOf, type RoundIdentity } from '../../core/module.js';
import { RandomTape } from '../../core/random.js';
import { rational, type Rational } from '../../core/rational.js';
import {
  classifyVerificationError,
  verificationFailure,
  verificationSuccess,
  type VerificationResult,
} from '../../core/verification.js';
import { COMMITMENT_VERSION } from '../../core/versions.js';
import { weightVector, type WeightVector } from '../../core/weights.js';
import { encodeFields, type CanonicalField } from '../../internal/canonical.js';
import { definitionFields, survivalFingerprint } from './adapter.js';
import {
  STAGED_SURVIVAL_MODULE_ID,
  TRANSCRIPT_SCHEMA,
  type SurvivalChoice,
  type SurvivalClaimRef,
  type SurvivalDefinition,
  type SurvivalLane,
  type SurvivalStep,
  type SurvivalTranscript,
  type SurvivalTruth,
} from './contracts.js';
import { lanePartition, marginalSurvival } from './distribution.js';
import {
  assertSurvivalChoice,
  assertSurvivalDefinition,
  contractFor,
  parseRoundRefId,
  roundRefId,
} from './validation.js';

/**
 * Truth derivation, step resolution, and the proof surface.
 *
 * The fairness model in one paragraph: the seed expands into a **counterfactually
 * complete random tape** before the round opens — a draw for every stage, every
 * contract on the menu, every lane slot and every entity, including the routes
 * the player will not take. The tape is a pure function of the seed and the
 * round pair, so no decision can change a draw; a decision only decides which
 * committed draws are *read*, and under which distribution. The transcript is
 * then a deterministic replay of (tape + logged choices), and a verifier
 * recomputes every part of it from the revealed seed and the logged choices
 * alone.
 */

const LANE_LABEL = 'staged-survival/lane';
const ENTITY_LABEL = 'staged-survival/entity';

/** Address of the `(stage, contract)` block inside the flat tape. */
function blockIndex(definition: SurvivalDefinition, stage: number, contractIndex: number): number {
  return (stage * definition.contracts.length + contractIndex) * definition.entities * 2;
}

export function roundIdentityOf(definition: SurvivalDefinition, roundId: string): RoundIdentity {
  return Object.freeze({
    moduleId: STAGED_SURVIVAL_MODULE_ID,
    definitionId: definition.id,
    roundId,
    proofVersion: COMMITMENT_VERSION,
  });
}

/**
 * Expands the seed into the whole round's tape, up front.
 *
 * `roundId` is the canonical round pair `<roundId>|<clientEntropy>`; both halves
 * are inside the sampler scope, so the operator's seed and the player's entropy
 * both enter every draw. Neither side can see the other's contribution when it
 * makes its own: the seed is sealed and published first (see `seedCommitment`),
 * the entropy is chosen second.
 *
 * The tape is complete over the counterfactuals — every contract of the menu
 * gets its own lane and entity draws at every stage — which is what makes the
 * choice a *reading* of committed randomness rather than a request for new
 * randomness. It also leaves the routes the player did not take verifiable after
 * the reveal.
 */
export function deriveTruth(
  seedHex: string,
  definition: SurvivalDefinition,
  roundId: string,
): SurvivalTruth {
  assertSurvivalDefinition(definition);
  parseRoundRefId(roundId);
  const tape = new RandomTape(seedHex, samplerScopeOf(roundIdentityOf(definition, roundId)));
  for (let stage = 0; stage < definition.stages; stage += 1)
    for (let contractIndex = 0; contractIndex < definition.contracts.length; contractIndex += 1) {
      const base = blockIndex(definition, stage, contractIndex);
      for (let slot = 0; slot < definition.entities; slot += 1)
        tape.draw(LANE_LABEL, base + slot, definition.drawModulus);
      for (let slot = 0; slot < definition.entities; slot += 1)
        tape.draw(ENTITY_LABEL, base + definition.entities + slot, definition.drawModulus);
    }
  return Object.freeze({ draws: tape.draws, digest: tape.digest() });
}

/**
 * Reads one committed draw, and refuses to read anything else.
 *
 * The address is recomputed and compared against the draw's own recorded
 * `(label, counter, modulus)`, so a truncated, reordered or hand-assembled truth
 * object fails closed with `DERIVATION_FAILED` instead of silently resolving a
 * stage against the wrong randomness.
 */
function tapeValue(
  definition: SurvivalDefinition,
  truth: SurvivalTruth,
  label: string,
  counter: number,
): bigint {
  // The tape is emitted in one fixed order — lane slots then entity slots, per
  // `(stage, contract)` block — and the counter is that position, so the address
  // is the index. It is still compared field for field rather than trusted.
  const draw = Array.isArray(truth?.draws) ? truth.draws[counter] : undefined;
  if (
    draw === undefined ||
    draw.label !== label ||
    draw.counter !== counter ||
    draw.modulus !== definition.drawModulus ||
    typeof draw.value !== 'bigint' ||
    draw.value < 0n ||
    draw.value >= definition.drawModulus
  )
    fail('DERIVATION_FAILED', 'Tape draw is missing from its declared address', '$.truth.draws');
  return draw.value;
}

/** `draw < numerator * (modulus / denominator)` has probability exactly `numerator/denominator`. */
export function threshold(definition: SurvivalDefinition, value: Rational): bigint {
  const reduced = rational(value.numerator, value.denominator);
  if (definition.drawModulus % reduced.denominator !== 0n)
    fail(
      'DERIVATION_FAILED',
      'Probability denominator does not divide the draw modulus',
      '$.drawModulus',
    );
  return reduced.numerator * (definition.drawModulus / reduced.denominator);
}

export interface StageResolution {
  readonly lanes: readonly SurvivalLane[];
  readonly survivors: readonly number[];
  readonly failed: readonly number[];
}

/**
 * Resolves one stage from raw draws. Pure, and deliberately tape-free.
 *
 * Taking the two draw sources as functions rather than reading a tape is what
 * lets the oracle test enumerate the entire elementary-event space of a stage —
 * every combination of lane shocks and entity clears — and compare this
 * resolver against an independently coded model, exhaustively rather than
 * statistically.
 */
export function resolveStage(
  definition: SurvivalDefinition,
  contractId: string,
  live: readonly number[],
  laneDraw: (laneIndex: number) => bigint,
  entityDraw: (entity: number) => bigint,
): StageResolution {
  assertSurvivalDefinition(definition);
  const contract = contractFor(definition, contractId, live.length);
  const laneThreshold = threshold(definition, contract.profile.laneFailure);
  const entityThreshold = threshold(definition, contract.profile.entitySurvival);
  const lanes: SurvivalLane[] = [];
  const survivors: number[] = [];
  const failed: number[] = [];
  lanePartition(contract, live).forEach((entities, laneIndex) => {
    const collapsed = laneDraw(laneIndex) < laneThreshold;
    lanes.push(Object.freeze({ entities: Object.freeze([...entities]), collapsed }));
    for (const entity of entities)
      (!collapsed && entityDraw(entity) < entityThreshold ? survivors : failed).push(entity);
  });
  return Object.freeze({
    lanes: Object.freeze(lanes),
    survivors: Object.freeze(survivors),
    failed: Object.freeze(failed),
  });
}

/**
 * Steps are a pure function of (tape, logged choices).
 *
 * The transcript is exactly as long as the decision log: a round the player
 * stopped after two stages has two steps, and re-deriving it needs those two
 * decisions and nothing else. Each choice carries the subset banked at that
 * stage boundary, because withdrawing an entity changes which entities are at
 * risk and therefore the step — a log that omitted it would replay a different
 * round from the one that was played.
 */
export function deriveSteps(
  definition: SurvivalDefinition,
  truth: SurvivalTruth,
  choices: readonly SurvivalChoice[],
): readonly SurvivalStep[] {
  assertSurvivalDefinition(definition);
  if (!Array.isArray(choices))
    fail('INVALID_CHOICE', 'Logged choices must be an array', '$.choices');
  if (choices.length > definition.stages)
    fail('INVALID_CHOICE', 'More choices than the definition has stages', '$.choices');
  const steps: SurvivalStep[] = [];
  let live: readonly number[] = Object.freeze(
    Array.from({ length: definition.entities }, (_entity, index) => index),
  );
  for (const [stage, choice] of choices.entries()) {
    assertSurvivalChoice(choice, definition, `$.choices[${stage}]`);
    const running = new Set(live);
    for (const entity of choice.banked) {
      if (!running.has(entity))
        fail('INVALID_CHOICE', 'Banked entity was not running', `$.choices[${stage}].banked`);
      running.delete(entity);
    }
    live = Object.freeze([...running].sort((left, right) => left - right));
    if (live.length === 0)
      fail('INVALID_CHOICE', 'No entity is left to run this stage', `$.choices[${stage}]`);
    const contract = contractFor(definition, choice.contractId, live.length);
    const contractIndex = definition.contracts.indexOf(contract);
    const base = blockIndex(definition, stage, contractIndex);
    const resolution = resolveStage(
      definition,
      contract.id,
      live,
      (laneIndex) => tapeValue(definition, truth, LANE_LABEL, base + laneIndex),
      (entity) => tapeValue(definition, truth, ENTITY_LABEL, base + definition.entities + entity),
    );
    steps.push(
      Object.freeze({
        index: stage,
        contractId: contract.id,
        banked: Object.freeze([...choice.banked]),
        lanes: resolution.lanes,
        survivors: resolution.survivors,
        failed: resolution.failed,
      }),
    );
    live = resolution.survivors;
  }
  return Object.freeze(steps);
}

/** Entities still running after a step prefix; the full field when there is none. */
export function liveAfter(
  definition: SurvivalDefinition,
  steps: readonly SurvivalStep[],
): readonly number[] {
  if (!Array.isArray(steps)) fail('DERIVATION_FAILED', 'Step prefix must be an array', '$.steps');
  const last = steps[steps.length - 1];
  if (last === undefined)
    return Object.freeze(Array.from({ length: definition.entities }, (_entity, index) => index));
  // `belief()` and `price()` are host-facing and reachable with whatever step
  // prefix a caller holds, so the shape is checked rather than assumed: an
  // untyped `TypeError` out of a pricing call is the failure mode this module's
  // taxonomy exists to prevent.
  if (!Array.isArray(last.survivors))
    fail('DERIVATION_FAILED', 'Step is missing its survivor list', '$.steps');
  return last.survivors;
}

/**
 * Marginal belief: which entities are still running, plus a terminal
 * "the field is empty" slot.
 *
 * The extra slot is not decoration. `weightVector` rejects an all-zero vector,
 * and "every entity failed" is a perfectly legal terminal state of this
 * lifecycle — so it is modelled as an outcome of its own rather than as an
 * impossible vector. This view is **not** the pricing space: claims are priced
 * through `price()`, because the joint law over survivor subsets is
 * combinatorial and a flat 64-slot vector is not it.
 */
export function belief(
  definition: SurvivalDefinition,
  steps: readonly SurvivalStep[],
): WeightVector {
  assertSurvivalDefinition(definition);
  const live = new Set(liveAfter(definition, steps));
  const weights = Array.from({ length: definition.entities }, (_entity, index) =>
    live.has(index) ? 1n : 0n,
  );
  weights.push(live.size === 0 ? 1n : 0n);
  return weightVector(weights);
}

/** Exact probability that one running entity survives the next stage under a contract. */
export function price(
  definition: SurvivalDefinition,
  steps: readonly SurvivalStep[],
  claim: SurvivalClaimRef,
): Rational {
  assertSurvivalDefinition(definition);
  if (typeof claim !== 'object' || claim === null)
    fail('INVALID_CHOICE', 'Expected a claim reference', '$.claim');
  const live = liveAfter(definition, steps);
  const contract = contractFor(definition, claim.contractId, live.length);
  return live.includes(claim.entity) ? marginalSurvival(contract) : rational(0n);
}

/**
 * The declared encoders, defined next to the body that composes them.
 *
 * These are the module's `truth.encode` and `steps.encode`, and the commitment
 * body below spreads them rather than restating the layout. A step binds the
 * lane geometry and the failure list as well as the survivors: a body that bound
 * only the survivors would let a lane be re-cut, or a failure re-attributed,
 * under an unchanged commitment.
 */
export function encodeTruth(truth: SurvivalTruth): readonly CanonicalField[] {
  return [truth.digest, truth.draws.length];
}

export function encodeStep(step: SurvivalStep): readonly CanonicalField[] {
  return [
    step.index,
    step.contractId,
    step.banked.length,
    ...step.banked,
    step.lanes.length,
    ...step.lanes.flatMap((lane): CanonicalField[] => [
      lane.entities.length,
      ...lane.entities,
      lane.collapsed ? 1 : 0,
    ]),
    step.survivors.length,
    ...step.survivors,
    step.failed.length,
    ...step.failed,
  ];
}

export function encodeChoice(choice: SurvivalChoice): readonly CanonicalField[] {
  return [choice.contractId, choice.banked.length, ...choice.banked];
}

/**
 * Canonical body.
 *
 * It binds the choice log — contract *and* banked subset — as well as the truth
 * and the steps. Without that, an operator holding one published commitment
 * could re-settle the round under a different set of decisions and both
 * settlements would verify. `round.roundId` is the canonical pair, so the
 * player's entropy is bound here too.
 */
export function commitmentBody(
  definition: SurvivalDefinition,
  round: RoundIdentity,
  truth: SurvivalTruth,
  steps: readonly SurvivalStep[],
  choices: readonly SurvivalChoice[],
): Buffer {
  assertSurvivalDefinition(definition);
  return encodeFields([
    'staged-survival commitment',
    COMMITMENT_VERSION,
    round.moduleId,
    ...definitionFields(definition),
    survivalFingerprint(definition),
    round.roundId,
    ...encodeTruth(truth),
    choices.length,
    ...choices.flatMap((choice) => [...encodeChoice(choice)]),
    steps.length,
    ...steps.flatMap((step) => [...encodeStep(step)]),
  ]);
}

/**
 * Phase 1: the seed pre-commitment, published before the round opens.
 *
 * It binds the **operator** round id and not the client entropy, and that
 * omission is the whole mechanism: the entropy does not exist yet. The operator
 * seals a seed against a round it has already named, the player then contributes
 * entropy the operator could not have predicted, and every draw is a function of
 * both. An operator grinding seeds before publication is grinding against an
 * unknown, so the grind buys nothing.
 */
export function seedCommitment(
  seedHex: string,
  definition: SurvivalDefinition,
  round: RoundIdentity,
): string {
  assertSurvivalDefinition(definition);
  const ref = parseRoundRefId(round.roundId);
  return sealSeedCommitment(seedHex, {
    moduleId: round.moduleId,
    definitionId: definition.id,
    definitionFingerprint: survivalFingerprint(definition),
    roundId: ref.roundId,
    proofVersion: round.proofVersion,
  });
}

/** Phase 2: the settled transcript, sealed under the revealed seed. */
export function makeTranscript(
  seedHex: string,
  definition: SurvivalDefinition,
  roundId: string,
  choices: readonly SurvivalChoice[] = [],
): SurvivalTranscript {
  assertSurvivalDefinition(definition);
  const ref = parseRoundRefId(roundId);
  const round = roundIdentityOf(definition, roundId);
  const truth = deriveTruth(seedHex, definition, roundId);
  const steps = deriveSteps(definition, truth, choices);
  return Object.freeze({
    schema: TRANSCRIPT_SCHEMA,
    definitionId: definition.id,
    definitionVersion: definition.version,
    definitionFingerprint: survivalFingerprint(definition),
    roundId: ref.roundId,
    clientEntropy: ref.clientEntropy,
    seedCommitment: seedCommitment(seedHex, definition, round),
    tapeDigest: truth.digest,
    choices: Object.freeze(
      choices.map((choice) =>
        Object.freeze({
          contractId: choice.contractId,
          banked: Object.freeze([...choice.banked]),
        }),
      ),
    ),
    steps,
    commitment: sealCommitment(seedHex, commitmentBody(definition, round, truth, steps, choices)),
  });
}

const sameList = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export function stepsEqual(left: readonly SurvivalStep[], right: readonly SurvivalStep[]): boolean {
  return (
    left.length === right.length &&
    left.every((step, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        step.index === other.index &&
        step.contractId === other.contractId &&
        sameList(step.banked, other.banked) &&
        sameList(step.survivors, other.survivors) &&
        sameList(step.failed, other.failed) &&
        step.lanes.length === other.lanes.length &&
        step.lanes.every((lane, laneIndex) => {
          const otherLane = other.lanes[laneIndex];
          return (
            otherLane !== undefined &&
            lane.collapsed === otherLane.collapsed &&
            sameList(lane.entities, otherLane.entities)
          );
        })
      );
    })
  );
}

export function choicesEqual(
  left: readonly SurvivalChoice[],
  right: readonly SurvivalChoice[],
): boolean {
  return (
    left.length === right.length &&
    left.every((choice, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        choice.contractId === other.contractId &&
        sameList(choice.banked, other.banked)
      );
    })
  );
}

/**
 * Pure re-derivation verifier, in the contract's required phase order.
 *
 * The wire decode happens in `deserializeTranscript`; everything after it is
 * re-derivation from the revealed seed and the transcript's own logged choices.
 * Every comparison of a digest is constant time, and every failure is one of the
 * public verification codes — an incidental throw is classified, never leaked.
 */
export function verifySurvivalTranscript(
  seedHex: string,
  definition: SurvivalDefinition,
  input: unknown,
  decode: (value: unknown) => SurvivalTranscript,
): VerificationResult {
  try {
    assertSurvivalDefinition(definition);
    const transcript = decode(input);
    const fingerprint = survivalFingerprint(definition);
    if (
      transcript.definitionId !== definition.id ||
      transcript.definitionVersion !== definition.version ||
      !constantTimeHexEqual(transcript.definitionFingerprint, fingerprint)
    )
      return verificationFailure(
        'DEFINITION_MISMATCH',
        'Transcript definition does not match the verifier',
        '$.definitionId',
      );
    const roundId = roundRefId({
      roundId: transcript.roundId,
      clientEntropy: transcript.clientEntropy,
    });
    const round = roundIdentityOf(definition, roundId);
    if (
      !constantTimeHexEqual(seedCommitment(seedHex, definition, round), transcript.seedCommitment)
    )
      return verificationFailure(
        'COMMITMENT_MISMATCH',
        'Seed pre-commitment does not match the revealed seed',
        '$.seedCommitment',
      );
    const truth = deriveTruth(seedHex, definition, roundId);
    if (!constantTimeHexEqual(truth.digest, transcript.tapeDigest))
      return verificationFailure(
        'TRANSCRIPT_MISMATCH',
        'Tape digest differs from the revealed seed',
        '$.tapeDigest',
      );
    const steps = deriveSteps(definition, truth, transcript.choices);
    if (!stepsEqual(steps, transcript.steps))
      return verificationFailure(
        'TRANSCRIPT_MISMATCH',
        'Steps differ from a replay of the logged decisions',
        '$.steps',
      );
    const expected = sealCommitment(
      seedHex,
      commitmentBody(definition, round, truth, steps, transcript.choices),
    );
    if (!constantTimeHexEqual(expected, transcript.commitment))
      return verificationFailure(
        'COMMITMENT_MISMATCH',
        'Commitment does not match the revealed seed',
        '$.commitment',
      );
    return verificationSuccess(COMMITMENT_VERSION, expected);
  } catch (error) {
    return classifyVerificationError(error);
  }
}
