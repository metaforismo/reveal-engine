import { fail } from '../../api/errors.js';
import { ENGINE_LIMITS } from '../../api/limits.js';
import { isRecord } from '../../core/validation.js';
import {
  SURVIVAL_LIMITS,
  TRANSCRIPT_SCHEMA,
  type SurvivalChoice,
  type SurvivalLane,
  type SurvivalStep,
  type SurvivalTranscript,
} from './contracts.js';

/**
 * The untrusted-input boundary for a `staged-survival` proof.
 *
 * Exact key sets, bounded lengths, no coercion, and a schema that fails closed.
 * Nothing here consults a definition — a verifier reaches this before it knows
 * which definition the payload claims — so every bound is the module's own
 * declared maximum. Anything that survives this and is still inconsistent with
 * the definition is caught by re-derivation, which is where it belongs.
 */

export const ACCEPTED_TRANSCRIPT_SCHEMAS: readonly string[] = Object.freeze([TRANSCRIPT_SCHEMA]);

const TRANSCRIPT_KEYS = Object.freeze([
  'schema',
  'definitionId',
  'definitionVersion',
  'definitionFingerprint',
  'roundId',
  'clientEntropy',
  'seedCommitment',
  'tapeDigest',
  'choices',
  'steps',
  'commitment',
]);

const CHOICE_KEYS = Object.freeze(['contractId', 'banked']);
const STEP_KEYS = Object.freeze(['index', 'contractId', 'banked', 'lanes', 'survivors', 'failed']);
const LANE_KEYS = Object.freeze(['entities', 'collapsed']);

const MAX_WIRE_STRING_BYTES = 256;

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail('INVALID_TRANSCRIPT', 'Object has missing or unknown fields', path);
}

function assertWire(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail('INVALID_TRANSCRIPT', 'Expected an object', path);
}

function assertBoundedString(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_WIRE_STRING_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail('INVALID_TRANSCRIPT', 'Expected a non-empty bounded printable string', path);
}

function assertHex(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    fail('INVALID_TRANSCRIPT', 'Expected canonical 32-byte hexadecimal', path);
}

/** Ascending, distinct, and inside the module's own entity bound. */
export function parseEntityList(value: unknown, path: string): readonly number[] {
  if (!Array.isArray(value) || value.length > SURVIVAL_LIMITS.maxEntities)
    fail('INVALID_TRANSCRIPT', 'Entity list is not a bounded array', path);
  let previous = -1;
  const entities = value.map((entity, index) => {
    if (
      typeof entity !== 'number' ||
      !Number.isSafeInteger(entity) ||
      entity < 0 ||
      entity >= SURVIVAL_LIMITS.maxEntities
    )
      fail('INVALID_TRANSCRIPT', 'Entity index is outside module limits', `${path}[${index}]`);
    if (entity <= previous)
      fail('INVALID_TRANSCRIPT', 'Entity list must be ascending and distinct', `${path}[${index}]`);
    previous = entity;
    return entity;
  });
  return Object.freeze(entities);
}

function parseChoice(value: unknown, path: string): SurvivalChoice {
  assertWire(value, path);
  assertExactKeys(value, CHOICE_KEYS, path);
  assertBoundedString(value.contractId, `${path}.contractId`);
  return Object.freeze({
    contractId: value.contractId,
    banked: parseEntityList(value.banked, `${path}.banked`),
  });
}

function parseLane(value: unknown, path: string): SurvivalLane {
  assertWire(value, path);
  assertExactKeys(value, LANE_KEYS, path);
  if (typeof value.collapsed !== 'boolean')
    fail('INVALID_TRANSCRIPT', 'Lane collapse flag must be a boolean', `${path}.collapsed`);
  return Object.freeze({
    entities: parseEntityList(value.entities, `${path}.entities`),
    collapsed: value.collapsed,
  });
}

function parseStep(value: unknown, index: number, path: string): SurvivalStep {
  assertWire(value, path);
  assertExactKeys(value, STEP_KEYS, path);
  if (value.index !== index)
    fail('INVALID_TRANSCRIPT', 'Step index is not its position in the log', `${path}.index`);
  assertBoundedString(value.contractId, `${path}.contractId`);
  if (!Array.isArray(value.lanes) || value.lanes.length > SURVIVAL_LIMITS.maxEntities)
    fail('INVALID_TRANSCRIPT', 'Lane list is not a bounded array', `${path}.lanes`);
  return Object.freeze({
    index,
    contractId: value.contractId,
    banked: parseEntityList(value.banked, `${path}.banked`),
    lanes: Object.freeze(
      value.lanes.map((lane, laneIndex) => parseLane(lane, `${path}.lanes[${laneIndex}]`)),
    ),
    survivors: parseEntityList(value.survivors, `${path}.survivors`),
    failed: parseEntityList(value.failed, `${path}.failed`),
  });
}

/**
 * Bounded decode of a choice log. Shared with the book snapshot.
 *
 * The book's reconnect state carries the same two logs the transcript does, and
 * they are the same wire shape, so they get the same parser rather than a second
 * one that could drift from it.
 */
export function parseWireChoiceList(value: unknown, path: string): readonly SurvivalChoice[] {
  if (!Array.isArray(value) || value.length > ENGINE_LIMITS.maxLoggedChoices)
    fail('INVALID_TRANSCRIPT', 'Choice log is not a bounded array', path);
  return Object.freeze(value.map((choice, index) => parseChoice(choice, `${path}[${index}]`)));
}

export function parseWireStepList(value: unknown, path: string): readonly SurvivalStep[] {
  if (!Array.isArray(value) || value.length > SURVIVAL_LIMITS.maxStages)
    fail('INVALID_TRANSCRIPT', 'Step log is not a bounded array', path);
  return Object.freeze(value.map((step, index) => parseStep(step, index, `${path}[${index}]`)));
}

export function transcriptToWire(transcript: SurvivalTranscript): object {
  return Object.freeze({
    schema: transcript.schema,
    definitionId: transcript.definitionId,
    definitionVersion: transcript.definitionVersion,
    definitionFingerprint: transcript.definitionFingerprint,
    roundId: transcript.roundId,
    clientEntropy: transcript.clientEntropy,
    seedCommitment: transcript.seedCommitment,
    tapeDigest: transcript.tapeDigest,
    choices: transcript.choices.map((choice) => ({
      contractId: choice.contractId,
      banked: [...choice.banked],
    })),
    steps: transcript.steps.map((step) => ({
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
    commitment: transcript.commitment,
  });
}

export function serializeTranscript(transcript: SurvivalTranscript): string {
  return JSON.stringify(transcriptToWire(transcript));
}

/**
 * Decodes an attacker-controlled transcript.
 *
 * An unknown schema is `UNSUPPORTED_VERSION` and everything else structural is
 * `INVALID_TRANSCRIPT`; neither ever surfaces as a raw `TypeError`. The payload
 * is byte-bounded before any structural work happens.
 */
export function deserializeTranscript(input: unknown): SurvivalTranscript {
  let value: unknown = input;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > ENGINE_LIMITS.maxTranscriptBytes)
      fail('PAYLOAD_TOO_LARGE', 'Transcript exceeds byte limit', '$');
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      fail('INVALID_TRANSCRIPT', 'Transcript is not valid JSON', '$');
    }
  }
  assertWire(value, '$');
  if (typeof value.schema !== 'string')
    fail('INVALID_TRANSCRIPT', 'Transcript schema is missing', '$.schema');
  if (!ACCEPTED_TRANSCRIPT_SCHEMAS.includes(value.schema))
    fail('UNSUPPORTED_VERSION', 'Unsupported transcript schema', '$.schema');
  assertExactKeys(value, TRANSCRIPT_KEYS, '$');
  assertBoundedString(value.definitionId, '$.definitionId');
  assertBoundedString(value.definitionVersion, '$.definitionVersion');
  assertHex(value.definitionFingerprint, '$.definitionFingerprint');
  assertBoundedString(value.roundId, '$.roundId');
  assertHex(value.seedCommitment, '$.seedCommitment');
  assertHex(value.tapeDigest, '$.tapeDigest');
  assertHex(value.commitment, '$.commitment');
  if (
    typeof value.clientEntropy !== 'string' ||
    !new RegExp(`^[0-9a-f]{${SURVIVAL_LIMITS.clientEntropyBytes * 2}}$`, 'u').test(
      value.clientEntropy,
    )
  )
    fail('INVALID_TRANSCRIPT', 'Client entropy is not canonical hexadecimal', '$.clientEntropy');
  if (!Array.isArray(value.choices) || value.choices.length > ENGINE_LIMITS.maxLoggedChoices)
    fail('INVALID_TRANSCRIPT', 'Choice log is not a bounded array', '$.choices');
  if (!Array.isArray(value.steps) || value.steps.length > SURVIVAL_LIMITS.maxStages)
    fail('INVALID_TRANSCRIPT', 'Step log is not a bounded array', '$.steps');
  // A step is the resolution of a logged decision, so there can never be more
  // steps than decisions. Rejecting the excess here keeps `verify()` from
  // reporting a step-count mismatch as if it were a derivation disagreement.
  if (value.steps.length > value.choices.length)
    fail('INVALID_TRANSCRIPT', 'Transcript has more steps than logged decisions', '$.steps');
  return Object.freeze({
    schema: TRANSCRIPT_SCHEMA,
    definitionId: value.definitionId,
    definitionVersion: value.definitionVersion,
    definitionFingerprint: value.definitionFingerprint,
    roundId: value.roundId,
    clientEntropy: value.clientEntropy,
    seedCommitment: value.seedCommitment,
    tapeDigest: value.tapeDigest,
    choices: parseWireChoiceList(value.choices, '$.choices'),
    steps: parseWireStepList(value.steps, '$.steps'),
    commitment: value.commitment,
  });
}
