import { ENGINE_LIMITS } from '../../api/limits.js';
import { fail } from '../../api/errors.js';
import { LEGACY_COMMITMENT_VERSION } from '../../core/versions.js';
import {
  LEGACY_TRANSCRIPT_SCHEMA,
  TRANSCRIPT_SCHEMA,
  type CommitmentVersion,
  type EvidenceEvent,
  type Transcript,
} from './contracts.js';
import { assertContext } from './validation.js';

interface WireEvidence {
  readonly index: number;
  readonly target: number;
  readonly favour: string;
  readonly other: string;
  readonly label: string;
}

export interface WireTranscriptV2 {
  readonly schema: typeof TRANSCRIPT_SCHEMA;
  readonly proofVersion: CommitmentVersion;
  readonly adapter: { readonly id: string; readonly version: string };
  readonly roundId: string;
  readonly truth: number;
  readonly evidence: readonly WireEvidence[];
  readonly commitment: string;
}

/** Schemas this codec accepts, newest first. Anything else fails closed. */
export const ACCEPTED_TRANSCRIPT_SCHEMAS = Object.freeze([
  TRANSCRIPT_SCHEMA,
  LEGACY_TRANSCRIPT_SCHEMA,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail('INVALID_TRANSCRIPT', 'Object has missing or unknown fields', path);
}
function boundedString(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > ENGINE_LIMITS.maxIdentifierBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail('INVALID_TRANSCRIPT', 'Expected a bounded printable string', path);
  return value;
}
function parseDecimal(value: unknown, path: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value) || value.length > 1234)
    fail('INVALID_TRANSCRIPT', 'Expected canonical non-negative BigInt string', path);
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed.toString(2).length > ENGINE_LIMITS.maxBigIntBits)
    fail('INVALID_TRANSCRIPT', 'Evidence likelihood is outside limits', path);
  return parsed;
}
function positiveBigInt(value: unknown, path: string): bigint {
  if (typeof value !== 'bigint') return parseDecimal(value, path);
  if (value <= 0n || value.toString(2).length > ENGINE_LIMITS.maxBigIntBits)
    fail('INVALID_TRANSCRIPT', 'Evidence likelihood is outside limits', path);
  return value;
}
function wireEvent(event: EvidenceEvent): WireEvidence {
  return Object.freeze({
    index: event.index,
    target: event.target,
    favour: event.favour.toString(10),
    other: event.other.toString(10),
    label: event.label,
  });
}
function domainEvent(value: unknown, path: string): EvidenceEvent {
  if (!isRecord(value)) fail('INVALID_TRANSCRIPT', 'Expected evidence object', path);
  exactKeys(value, ['index', 'target', 'favour', 'other', 'label'], path);
  if (!Number.isSafeInteger(value.index) || !Number.isSafeInteger(value.target))
    fail('INVALID_TRANSCRIPT', 'Evidence index/target must be safe integers', path);
  if (
    typeof value.label !== 'string' ||
    value.label.length === 0 ||
    Buffer.byteLength(value.label, 'utf8') > ENGINE_LIMITS.maxLabelBytes
  )
    fail('INVALID_TRANSCRIPT', 'Evidence label must be string', `${path}.label`);
  return Object.freeze({
    index: Number(value.index),
    target: Number(value.target),
    favour: positiveBigInt(value.favour, `${path}.favour`),
    other: positiveBigInt(value.other, `${path}.other`),
    label: value.label,
  });
}

export function transcriptToWire(transcript: Transcript): WireTranscriptV2 {
  return Object.freeze({
    schema: TRANSCRIPT_SCHEMA,
    proofVersion: transcript.context.proofVersion,
    adapter: Object.freeze({ id: transcript.context.gameId, version: transcript.adapterVersion }),
    roundId: transcript.context.roundId,
    truth: transcript.truth,
    evidence: Object.freeze(transcript.evidence.map(wireEvent)),
    commitment: transcript.commitment,
  });
}

export function serializeTranscript(transcript: Transcript): string {
  return JSON.stringify(transcriptToWire(transcript));
}

export function deserializeTranscript(input: unknown): Transcript {
  let value = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > ENGINE_LIMITS.maxTranscriptBytes)
      fail('PAYLOAD_TOO_LARGE', 'Transcript exceeds byte limit');
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      fail('INVALID_TRANSCRIPT', 'Transcript is not valid JSON');
    }
  }
  if (!isRecord(value)) fail('INVALID_TRANSCRIPT', 'Expected transcript object');
  if (value.schema === TRANSCRIPT_SCHEMA && 'context' in value) return parseDomain(value);
  if (value.schema === TRANSCRIPT_SCHEMA) return parseV2(value);
  if (
    value.schema === LEGACY_TRANSCRIPT_SCHEMA ||
    (value.schema === undefined && 'context' in value)
  )
    return parseLegacy(value);
  fail('UNSUPPORTED_VERSION', 'Unsupported transcript schema', '$.schema');
}

function parseDomain(value: Record<string, unknown>): Transcript {
  exactKeys(value, ['schema', 'adapterVersion', 'context', 'truth', 'evidence', 'commitment'], '$');
  if (!isRecord(value.context)) fail('INVALID_TRANSCRIPT', 'Invalid domain transcript identity');
  exactKeys(value.context, ['gameId', 'roundId', 'proofVersion'], '$.context');
  const adapterVersion = boundedString(value.adapterVersion, '$.adapterVersion');
  const proofVersion = value.context.proofVersion;
  if (
    typeof value.context.gameId !== 'string' ||
    typeof value.context.roundId !== 'string' ||
    (proofVersion !== 'reveal-engine/commit-v1' && proofVersion !== 'reveal-engine/commit-v2')
  )
    fail('INVALID_TRANSCRIPT', 'Invalid domain context', '$.context');
  if (
    !Number.isSafeInteger(value.truth) ||
    Number(value.truth) < 0 ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > ENGINE_LIMITS.maxEvidenceEvents
  )
    fail('INVALID_TRANSCRIPT', 'Invalid domain truth/evidence');
  if (typeof value.commitment !== 'string' || !/^[0-9a-f]{64}$/u.test(value.commitment))
    fail('INVALID_TRANSCRIPT', 'Invalid commitment', '$.commitment');
  const context = Object.freeze({
    gameId: value.context.gameId,
    roundId: value.context.roundId,
    proofVersion,
  });
  assertContext(context);
  return Object.freeze({
    schema: TRANSCRIPT_SCHEMA,
    adapterVersion,
    context,
    truth: Number(value.truth),
    evidence: Object.freeze(
      value.evidence.map((event, index) => domainEvent(event, `$.evidence[${index}]`)),
    ),
    commitment: value.commitment,
  });
}

function parseV2(value: Record<string, unknown>): Transcript {
  exactKeys(
    value,
    ['schema', 'proofVersion', 'adapter', 'roundId', 'truth', 'evidence', 'commitment'],
    '$',
  );
  if (!isRecord(value.adapter)) fail('INVALID_TRANSCRIPT', 'Expected adapter object', '$.adapter');
  exactKeys(value.adapter, ['id', 'version'], '$.adapter');
  const adapterId = boundedString(value.adapter.id, '$.adapter.id');
  const adapterVersion = boundedString(value.adapter.version, '$.adapter.version');
  const roundId = boundedString(value.roundId, '$.roundId');
  if (
    value.proofVersion !== 'reveal-engine/commit-v1' &&
    value.proofVersion !== 'reveal-engine/commit-v2'
  )
    fail('UNSUPPORTED_VERSION', 'Unsupported proof version', '$.proofVersion');
  if (!Number.isSafeInteger(value.truth) || Number(value.truth) < 0)
    fail('INVALID_TRANSCRIPT', 'Invalid truth', '$.truth');
  if (!Array.isArray(value.evidence) || value.evidence.length > ENGINE_LIMITS.maxEvidenceEvents)
    fail('INVALID_TRANSCRIPT', 'Invalid evidence array', '$.evidence');
  if (typeof value.commitment !== 'string' || !/^[0-9a-f]{64}$/u.test(value.commitment))
    fail('INVALID_TRANSCRIPT', 'Invalid commitment', '$.commitment');
  const context = Object.freeze({
    gameId: adapterId,
    roundId,
    proofVersion: value.proofVersion,
  });
  assertContext(context);
  const evidence = Object.freeze(
    value.evidence.map((event, index) => domainEvent(event, `$.evidence[${index}]`)),
  );
  return Object.freeze({
    schema: TRANSCRIPT_SCHEMA,
    adapterVersion,
    context,
    truth: Number(value.truth),
    evidence,
    commitment: value.commitment,
  });
}

function parseLegacy(value: Record<string, unknown>): Transcript {
  const hasAdapterVersion = 'adapterVersion' in value;
  const hasSchema = 'schema' in value;
  exactKeys(
    value,
    [
      ...(hasSchema ? ['schema'] : []),
      ...(hasAdapterVersion ? ['adapterVersion'] : []),
      'context',
      'truth',
      'evidence',
      'commitment',
    ],
    '$',
  );
  if (!isRecord(value.context))
    fail('INVALID_TRANSCRIPT', 'Legacy transcript context missing', '$.context');
  const contextValue = value.context;
  const versionKey = 'contractVersion' in contextValue ? 'contractVersion' : 'proofVersion';
  exactKeys(contextValue, ['gameId', 'roundId', versionKey], '$.context');
  const gameId = contextValue.gameId;
  const roundId = contextValue.roundId;
  const version = contextValue.contractVersion ?? contextValue.proofVersion;
  if (version !== LEGACY_COMMITMENT_VERSION)
    fail('UNSUPPORTED_VERSION', 'Invalid legacy transcript context', '$.context');
  const boundedGameId = boundedString(gameId, '$.context.gameId');
  const boundedRoundId = boundedString(roundId, '$.context.roundId');
  if (
    !Array.isArray(value.evidence) ||
    value.evidence.length > ENGINE_LIMITS.maxEvidenceEvents ||
    !Number.isSafeInteger(value.truth) ||
    typeof value.commitment !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.commitment) ||
    Number(value.truth) < 0
  )
    fail('INVALID_TRANSCRIPT', 'Invalid legacy transcript');
  const evidence = Object.freeze(
    value.evidence.map((event, index) => domainEvent(event, `$.evidence[${index}]`)),
  );
  const context = Object.freeze({
    gameId: boundedGameId,
    roundId: boundedRoundId,
    proofVersion: LEGACY_COMMITMENT_VERSION,
  });
  assertContext(context);
  return Object.freeze({
    schema: TRANSCRIPT_SCHEMA,
    adapterVersion:
      value.adapterVersion === undefined
        ? '1.0.0'
        : boundedString(value.adapterVersion, '$.adapterVersion'),
    context,
    truth: Number(value.truth),
    evidence,
    commitment: value.commitment,
  });
}
