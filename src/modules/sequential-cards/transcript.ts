import { fail } from '../../api/errors.js';
import { ENGINE_LIMITS } from '../../api/limits.js';
import { constantTimeHexEqual, sealCommitment, sealSeedCommitment } from '../../core/commitment.js';
import type { RoundIdentity } from '../../core/module.js';
import { isRecord } from '../../core/validation.js';
import {
  classifyVerificationError,
  verificationFailure,
  verificationSuccess,
  type VerificationResult,
} from '../../core/verification.js';
import { COMMITMENT_VERSION } from '../../core/versions.js';
import { encodeFields, type CanonicalField } from '../../internal/canonical.js';
import { cardsFingerprint, cardsRoundOf } from './adapter.js';
import {
  CARDS_TRANSCRIPT_SCHEMA,
  type CardsTranscript,
  type Deal,
  type PlayerChoice,
  type RevealStep,
  type SequentialCardsDefinition,
} from './contracts.js';
import { deriveDeal, dealEqual, encodeDeal } from './truth.js';
import {
  deriveRevealSteps,
  encodePlayerChoice,
  encodeRevealStep,
  revealStepsEqual,
} from './steps.js';
import { assertRevealSteps } from './record.js';
import { assertCardsDefinition, assertDeal, assertPlayerChoices } from './validation.js';

/**
 * Transcript schema, codec, and verifier.
 *
 * The module owns its own schema string and its own migration set; core never
 * parses a module transcript and only ever seals the bytes `cardsCommitmentBody`
 * returns.
 */
export const ACCEPTED_CARDS_TRANSCRIPT_SCHEMAS: readonly string[] = Object.freeze([
  CARDS_TRANSCRIPT_SCHEMA,
]);

/** Wire shape. Every value is JSON-native; nothing here is a BigInt. */
export interface WireCardsTranscript {
  readonly schema: string;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly definitionFingerprint: string;
  readonly roundId: string;
  readonly seedCommitment: string;
  readonly deal: { readonly ranks: readonly number[]; readonly selectors: readonly number[] };
  readonly choices: readonly {
    readonly index: number;
    readonly kind: string;
    readonly position: number;
  }[];
  readonly steps: readonly {
    readonly index: number;
    readonly position: number;
    readonly rank: number;
    readonly sorted: readonly number[];
    readonly label: string;
  }[];
  readonly commitment: string;
}

const TRANSCRIPT_KEYS = Object.freeze([
  'schema',
  'definitionId',
  'definitionVersion',
  'definitionFingerprint',
  'roundId',
  'seedCommitment',
  'deal',
  'choices',
  'steps',
  'commitment',
]);

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

function assertHex(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    fail('INVALID_TRANSCRIPT', 'Expected canonical 32-byte hexadecimal', path);
}

function assertBoundedString(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > ENGINE_LIMITS.maxIdentifierBytes
  )
    fail('INVALID_TRANSCRIPT', 'Expected a bounded non-empty string', path);
}

function assertIntegerArray(
  value: unknown,
  path: string,
  maxLength: number,
): asserts value is number[] {
  if (!Array.isArray(value) || value.length > maxLength)
    fail('INVALID_TRANSCRIPT', 'Expected a bounded integer array', path);
  value.forEach((entry, index) => {
    if (!Number.isSafeInteger(entry))
      fail('INVALID_TRANSCRIPT', 'Expected a safe integer', `${path}[${index}]`);
  });
}

/**
 * The seed pre-commitment, published **before** the round accepts its first
 * decision.
 *
 * A choice-timed round has no body to seal until it is over, so this is what
 * covers the window in which the player backs a position: it binds the seed, the
 * module, the definition fingerprint — so the economics are frozen too — and the
 * round id, and it reveals nothing, being a hash of an unrevealed 32-byte seed.
 */
export function cardsSeedCommitment(
  seedHex: string,
  definition: SequentialCardsDefinition,
  round: RoundIdentity,
): string {
  assertCardsDefinition(definition);
  return sealSeedCommitment(seedHex, {
    moduleId: round.moduleId,
    definitionId: definition.id,
    definitionFingerprint: cardsFingerprint(definition),
    roundId: round.roundId,
    proofVersion: round.proofVersion,
  });
}

/**
 * The canonical bytes core seals.
 *
 * It binds the module id, the definition identity **and** its fingerprint, the
 * round identity, the truth, every logged choice, and every derived step. The
 * choice log is not optional: omit it and an operator holding one published
 * commitment could settle the same round twice under different decisions, and
 * both settlements would verify.
 *
 * The truth and step sections are spread from `encodeDeal` and
 * `encodeRevealStep` — the same two functions the module declares as
 * `truth.encode` and `steps.encode` — so the declared encoding *is* the
 * proof-bearing one by construction rather than by review.
 */
export function cardsCommitmentBody(
  definition: SequentialCardsDefinition,
  round: RoundIdentity,
  deal: Deal,
  steps: readonly RevealStep[],
  choices: readonly PlayerChoice[],
): Buffer {
  assertCardsDefinition(definition);
  const fields: CanonicalField[] = [
    'Axiom Games sequential-cards commitment',
    COMMITMENT_VERSION,
    round.moduleId,
    definition.id,
    definition.version,
    cardsFingerprint(definition),
    round.roundId,
    round.proofVersion,
    ...encodeDeal(deal),
    choices.length,
    ...choices.flatMap((choice) => [...encodePlayerChoice(choice)]),
    steps.length,
    ...steps.flatMap((step) => [...encodeRevealStep(step)]),
  ];
  return encodeFields(fields);
}

export function buildCardsTranscript(
  seedHex: string,
  definition: SequentialCardsDefinition,
  roundId: string,
  choices: readonly PlayerChoice[] = [],
): CardsTranscript {
  assertCardsDefinition(definition);
  assertPlayerChoices(definition, choices);
  const round = cardsRoundOf(definition, roundId);
  const deal = deriveDeal(seedHex, definition, roundId);
  const steps = deriveRevealSteps(definition, deal, choices);
  return Object.freeze({
    schema: CARDS_TRANSCRIPT_SCHEMA,
    definitionId: definition.id,
    definitionVersion: definition.version,
    definitionFingerprint: cardsFingerprint(definition),
    roundId,
    seedCommitment: cardsSeedCommitment(seedHex, definition, round),
    deal,
    choices: Object.freeze(choices.map((choice) => Object.freeze({ ...choice }))),
    steps,
    commitment: sealCommitment(
      seedHex,
      cardsCommitmentBody(definition, round, deal, steps, choices),
    ),
  });
}

export function cardsTranscriptToWire(transcript: CardsTranscript): WireCardsTranscript {
  return Object.freeze({
    schema: transcript.schema,
    definitionId: transcript.definitionId,
    definitionVersion: transcript.definitionVersion,
    definitionFingerprint: transcript.definitionFingerprint,
    roundId: transcript.roundId,
    seedCommitment: transcript.seedCommitment,
    deal: Object.freeze({
      ranks: Object.freeze([...transcript.deal.ranks]),
      selectors: Object.freeze([...transcript.deal.selectors]),
    }),
    choices: Object.freeze(
      transcript.choices.map((choice) =>
        Object.freeze({ index: choice.index, kind: choice.kind, position: choice.position }),
      ),
    ),
    steps: Object.freeze(
      transcript.steps.map((step) =>
        Object.freeze({
          index: step.index,
          position: step.position,
          rank: step.rank,
          sorted: Object.freeze([...step.sorted]),
          label: step.label,
        }),
      ),
    ),
    commitment: transcript.commitment,
  });
}

export function serializeCardsTranscript(transcript: CardsTranscript): string {
  return JSON.stringify(cardsTranscriptToWire(transcript));
}

/**
 * The untrusted-input boundary.
 *
 * Exact key sets, bounded lengths, safe integers, canonical hex, and no
 * coercion anywhere. A schema this module does not accept fails closed with
 * `UNSUPPORTED_VERSION` rather than being parsed hopefully.
 */
export function deserializeCardsTranscript(input: unknown): CardsTranscript {
  const value: unknown = typeof input === 'string' ? parseJson(input) : input;
  if (!isRecord(value)) fail('INVALID_TRANSCRIPT', 'Expected a transcript object', '$');
  // The schema is read before anything else, so a payload this module does not
  // accept fails closed as an unsupported version rather than being reported as
  // a malformed one it was never going to parse.
  if (typeof value.schema !== 'string')
    fail('INVALID_TRANSCRIPT', 'Missing transcript schema', '$.schema');
  if (!ACCEPTED_CARDS_TRANSCRIPT_SCHEMAS.includes(value.schema))
    fail('UNSUPPORTED_VERSION', 'Unsupported transcript schema', '$.schema');
  assertExactKeys(value, TRANSCRIPT_KEYS, '$');
  assertBoundedString(value.definitionId, '$.definitionId');
  assertBoundedString(value.definitionVersion, '$.definitionVersion');
  assertHex(value.definitionFingerprint, '$.definitionFingerprint');
  assertBoundedString(value.roundId, '$.roundId');
  assertHex(value.seedCommitment, '$.seedCommitment');
  assertHex(value.commitment, '$.commitment');

  const deal = value.deal;
  if (!isRecord(deal)) fail('INVALID_TRANSCRIPT', 'Expected a deal object', '$.deal');
  assertExactKeys(deal, ['ranks', 'selectors'], '$.deal');
  assertIntegerArray(deal.ranks, '$.deal.ranks', ENGINE_LIMITS.maxOutcomes);
  assertIntegerArray(deal.selectors, '$.deal.selectors', ENGINE_LIMITS.maxSteps);

  if (!Array.isArray(value.choices) || value.choices.length > ENGINE_LIMITS.maxLoggedChoices)
    fail('INVALID_TRANSCRIPT', 'Choices must be a bounded array', '$.choices');
  const choices = value.choices.map((entry: unknown, index): PlayerChoice => {
    if (!isRecord(entry))
      fail('INVALID_TRANSCRIPT', 'Choice must be an object', `$.choices[${index}]`);
    assertExactKeys(entry, ['index', 'kind', 'position'], `$.choices[${index}]`);
    if (
      !Number.isSafeInteger(entry.index) ||
      !Number.isSafeInteger(entry.position) ||
      entry.kind !== 'back'
    )
      fail('INVALID_TRANSCRIPT', 'Choice fields are invalid', `$.choices[${index}]`);
    return Object.freeze({
      index: entry.index as number,
      kind: 'back',
      position: entry.position as number,
    });
  });

  if (!Array.isArray(value.steps) || value.steps.length > ENGINE_LIMITS.maxSteps)
    fail('INVALID_TRANSCRIPT', 'Steps must be a bounded array', '$.steps');
  const steps = value.steps.map((entry: unknown, index): RevealStep => {
    if (!isRecord(entry)) fail('INVALID_TRANSCRIPT', 'Step must be an object', `$.steps[${index}]`);
    assertExactKeys(entry, ['index', 'position', 'rank', 'sorted', 'label'], `$.steps[${index}]`);
    if (
      !Number.isSafeInteger(entry.index) ||
      !Number.isSafeInteger(entry.position) ||
      !Number.isSafeInteger(entry.rank)
    )
      fail('INVALID_TRANSCRIPT', 'Step counters are invalid', `$.steps[${index}]`);
    assertBoundedString(entry.label, `$.steps[${index}].label`);
    assertIntegerArray(entry.sorted, `$.steps[${index}].sorted`, ENGINE_LIMITS.maxOutcomes);
    return Object.freeze({
      index: entry.index as number,
      position: entry.position as number,
      rank: entry.rank as number,
      sorted: Object.freeze([...(entry.sorted as number[])]),
      label: entry.label as string,
    });
  });

  return Object.freeze({
    schema: CARDS_TRANSCRIPT_SCHEMA,
    definitionId: value.definitionId,
    definitionVersion: value.definitionVersion,
    definitionFingerprint: value.definitionFingerprint,
    roundId: value.roundId,
    seedCommitment: value.seedCommitment,
    deal: Object.freeze({
      ranks: Object.freeze([...(deal.ranks as number[])]),
      selectors: Object.freeze([...(deal.selectors as number[])]),
    }),
    choices: Object.freeze(choices),
    steps: Object.freeze(steps),
    commitment: value.commitment,
  });
}

function parseJson(input: string): unknown {
  if (Buffer.byteLength(input, 'utf8') > ENGINE_LIMITS.maxTranscriptBytes)
    fail('PAYLOAD_TOO_LARGE', 'Transcript exceeds byte limit');
  try {
    return JSON.parse(input) as unknown;
  } catch {
    fail('INVALID_TRANSCRIPT', 'Transcript is not valid JSON');
  }
}

export function cardsChoicesOf(transcript: CardsTranscript): readonly PlayerChoice[] {
  return transcript.choices;
}

/**
 * Pure re-derivation verifier, in the contract's required phase order.
 *
 * Decode the wire form, check the definition identity, re-derive and compare the
 * **seed pre-commitment** — which is what proves the seed predates every
 * decision — re-derive the truth, re-derive the steps from the transcript's own
 * logged choices, and re-seal the body. Commitments are compared in constant
 * time, and every failure is one of the public verification codes: an incidental
 * parser or crypto exception is classified, never leaked.
 */
export function verifyCardsTranscript(
  seedHex: string,
  definition: SequentialCardsDefinition,
  input: unknown,
): VerificationResult {
  try {
    assertCardsDefinition(definition);
    const transcript = deserializeCardsTranscript(input);
    const fingerprint = cardsFingerprint(definition);
    if (
      transcript.definitionId !== definition.id ||
      transcript.definitionVersion !== definition.version ||
      !constantTimeHexEqual(transcript.definitionFingerprint, fingerprint)
    )
      return verificationFailure(
        'DEFINITION_MISMATCH',
        'Transcript belongs to another definition',
        '$.definitionId',
      );
    const round = cardsRoundOf(definition, transcript.roundId);
    if (
      !constantTimeHexEqual(
        cardsSeedCommitment(seedHex, definition, round),
        transcript.seedCommitment,
      )
    )
      return verificationFailure(
        'COMMITMENT_MISMATCH',
        'Seed pre-commitment does not re-derive from the revealed seed',
        '$.seedCommitment',
      );
    assertPlayerChoices(definition, transcript.choices);
    assertDeal(definition, transcript.deal);
    assertRevealSteps(definition, transcript.choices, transcript.steps);
    const deal = deriveDeal(seedHex, definition, transcript.roundId);
    if (!dealEqual(deal, transcript.deal))
      return verificationFailure('TRANSCRIPT_MISMATCH', 'Deal differs', '$.deal');
    const steps = deriveRevealSteps(definition, deal, transcript.choices);
    if (!revealStepsEqual(steps, transcript.steps))
      return verificationFailure(
        'TRANSCRIPT_MISMATCH',
        'Reveals differ from the logged decisions',
        '$.steps',
      );
    const expected = sealCommitment(
      seedHex,
      cardsCommitmentBody(definition, round, deal, steps, transcript.choices),
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
