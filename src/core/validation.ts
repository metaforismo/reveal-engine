import { ENGINE_LIMITS } from '../api/limits.js';
import { fail } from '../api/errors.js';
import {
  ENGINE_API_VERSION,
  type EvidenceEvent,
  type GameDefinition,
  type Posterior,
  type RoundContext,
} from './contracts.js';
import type { Rational } from './rational.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
function assertString(
  value: unknown,
  path: string,
  maxBytes = ENGINE_LIMITS.maxIdentifierBytes,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    byteLength(value) > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail('INVALID_ADAPTER', `Expected a non-empty bounded printable string`, path);
}
function bitLength(value: bigint): number {
  const n = value < 0n ? -value : value;
  return n === 0n ? 0 : n.toString(2).length;
}
export function assertBoundedBigInt(
  value: unknown,
  path: string,
  positive = false,
): asserts value is bigint {
  if (
    typeof value !== 'bigint' ||
    (positive && value <= 0n) ||
    bitLength(value) > ENGINE_LIMITS.maxBigIntBits
  )
    fail(
      'INVALID_RATIONAL',
      `Expected ${positive ? 'positive ' : ''}BigInt within ${ENGINE_LIMITS.maxBigIntBits} bits`,
      path,
    );
}
export function assertRational(value: unknown, path = '$'): asserts value is Rational {
  if (!isRecord(value)) fail('INVALID_RATIONAL', 'Expected rational object', path);
  assertBoundedBigInt(value.numerator, `${path}.numerator`);
  assertBoundedBigInt(value.denominator, `${path}.denominator`, true);
}
export function assertContext(value: unknown, path = '$'): asserts value is RoundContext {
  if (!isRecord(value)) fail('INVALID_CONTEXT', 'Expected round context', path);
  assertString(value.gameId, `${path}.gameId`);
  assertString(value.roundId, `${path}.roundId`);
  if (
    value.proofVersion !== 'reveal-engine/commit-v1' &&
    value.proofVersion !== 'reveal-engine/commit-v2'
  )
    fail('UNSUPPORTED_VERSION', 'Unsupported proof version', `${path}.proofVersion`);
}
export function assertEvidenceEvent(
  value: unknown,
  outcomeCount: number,
  expectedIndex?: number,
  path = '$',
): asserts value is EvidenceEvent {
  if (!isRecord(value)) fail('INVALID_EVIDENCE', 'Expected evidence event', path);
  if (
    !Number.isSafeInteger(value.index) ||
    Number(value.index) < 0 ||
    (expectedIndex !== undefined && value.index !== expectedIndex)
  )
    fail('INVALID_EVIDENCE', 'Evidence index is not canonical', `${path}.index`);
  if (
    !Number.isSafeInteger(value.target) ||
    Number(value.target) < 0 ||
    Number(value.target) >= outcomeCount
  )
    fail('INVALID_EVIDENCE', 'Evidence targets an unknown outcome', `${path}.target`);
  assertBoundedBigInt(value.favour, `${path}.favour`, true);
  assertBoundedBigInt(value.other, `${path}.other`, true);
  assertString(value.label, `${path}.label`, ENGINE_LIMITS.maxLabelBytes);
}
export function assertPosterior(
  value: unknown,
  expectedOutcomes?: number,
  path = '$',
): asserts value is Posterior {
  if (!isRecord(value) || !Array.isArray(value.weights))
    fail('INVALID_POSTERIOR', 'Expected posterior object', path);
  if (typeof value.adapterId !== 'string' || value.adapterId.length === 0)
    fail('INVALID_POSTERIOR', 'Posterior adapter ID is missing', `${path}.adapterId`);
  if (typeof value.adapterVersion !== 'string' || value.adapterVersion.length === 0)
    fail('INVALID_POSTERIOR', 'Posterior adapter version is missing', `${path}.adapterVersion`);
  if (
    typeof value.adapterFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.adapterFingerprint)
  )
    fail(
      'INVALID_POSTERIOR',
      'Posterior adapter fingerprint is invalid',
      `${path}.adapterFingerprint`,
    );
  if (
    value.weights.length < 2 ||
    value.weights.length > ENGINE_LIMITS.maxOutcomes ||
    (expectedOutcomes !== undefined && value.weights.length !== expectedOutcomes)
  )
    fail('INVALID_POSTERIOR', 'Posterior outcome count mismatch', `${path}.weights`);
  let total = 0n;
  value.weights.forEach((weight, index) => {
    assertBoundedBigInt(weight, `${path}.weights[${index}]`, true);
    total += weight;
  });
  assertBoundedBigInt(value.total, `${path}.total`, true);
  if (value.total !== total)
    fail('INVALID_POSTERIOR', 'Posterior total does not equal its weights', `${path}.total`);
}
export function assertGameDefinition(value: unknown, path = '$'): asserts value is GameDefinition {
  if (!isRecord(value)) fail('INVALID_ADAPTER', 'Expected adapter object', path);
  if (value.apiVersion !== ENGINE_API_VERSION)
    fail('UNSUPPORTED_VERSION', 'Unsupported engine API version', `${path}.apiVersion`);
  assertString(value.adapterVersion, `${path}.adapterVersion`);
  assertString(value.id, `${path}.id`);
  if (
    !Array.isArray(value.outcomes) ||
    value.outcomes.length < 2 ||
    value.outcomes.length > ENGINE_LIMITS.maxOutcomes
  )
    fail('INVALID_ADAPTER', 'Adapter outcome count is outside limits', `${path}.outcomes`);
  const ids = new Set<string>();
  value.outcomes.forEach((outcome, index) => {
    assertString(outcome, `${path}.outcomes[${index}]`);
    if (ids.has(outcome))
      fail('INVALID_ADAPTER', 'Outcome IDs must be unique', `${path}.outcomes[${index}]`);
    ids.add(outcome);
  });
  if (!Array.isArray(value.priorWeights) || value.priorWeights.length !== value.outcomes.length)
    fail('INVALID_ADAPTER', 'Prior weights must match outcomes', `${path}.priorWeights`);
  value.priorWeights.forEach((weight, index) =>
    assertBoundedBigInt(weight, `${path}.priorWeights[${index}]`, true),
  );
  if (value.priorWeights.reduce((sum, weight) => sum + weight, 0n) >= 1n << 256n)
    fail('INVALID_ADAPTER', 'Prior total must be below 2^256', `${path}.priorWeights`);
  if (
    !isRecord(value.evidence) ||
    !Number.isSafeInteger(value.evidence.eventCount) ||
    Number(value.evidence.eventCount) < 0 ||
    Number(value.evidence.eventCount) > ENGINE_LIMITS.maxEvidenceEvents ||
    typeof value.evidence.derive !== 'function'
  )
    fail('INVALID_ADAPTER', 'Invalid evidence schedule', `${path}.evidence`);
  assertString(value.evidence.modelVersion, `${path}.evidence.modelVersion`);
  if (!isRecord(value.pricing))
    fail('INVALID_ADAPTER', 'Missing pricing policy', `${path}.pricing`);
  assertRational(value.pricing.firstEntryRtp, `${path}.pricing.firstEntryRtp`);
  assertRational(value.pricing.liquidationSpread, `${path}.pricing.liquidationSpread`);
  if (
    value.pricing.firstEntryRtp.numerator <= 0n ||
    value.pricing.firstEntryRtp.numerator > value.pricing.firstEntryRtp.denominator
  )
    fail('INVALID_ADAPTER', 'RTP must be in (0,1]', `${path}.pricing.firstEntryRtp`);
  if (
    value.pricing.liquidationSpread.numerator < 0n ||
    value.pricing.liquidationSpread.numerator >= value.pricing.liquidationSpread.denominator
  )
    fail('INVALID_ADAPTER', 'Spread must be in [0,1)', `${path}.pricing.liquidationSpread`);
  if (value.pricing.rounding !== 'floor')
    fail('INVALID_ADAPTER', 'Unsupported rounding policy', `${path}.pricing.rounding`);
  if (!isRecord(value.risk)) fail('INVALID_ADAPTER', 'Missing risk policy', `${path}.risk`);
  assertBoundedBigInt(value.risk.maxWinMultiple, `${path}.risk.maxWinMultiple`, true);
  if (value.risk.continuation !== undefined) {
    if (
      !isRecord(value.risk.continuation) ||
      !Number.isSafeInteger(value.risk.continuation.maxRides) ||
      Number(value.risk.continuation.maxRides) < 0 ||
      Number(value.risk.continuation.maxRides) > 64
    )
      fail('INVALID_ADAPTER', 'Invalid continuation limit', `${path}.risk.continuation.maxRides`);
    assertRational(value.risk.continuation.rtpFloor, `${path}.risk.continuation.rtpFloor`);
  }
}

export function assertDerivedEvidence(
  game: GameDefinition,
  events: unknown,
  path = '$.evidence',
): asserts events is readonly EvidenceEvent[] {
  if (!Array.isArray(events) || events.length !== game.evidence.eventCount)
    fail('INVALID_EVIDENCE', 'Derived evidence length differs from declared schedule', path);
  events.forEach((event, index) =>
    assertEvidenceEvent(event, game.outcomes.length, index, `${path}[${index}]`),
  );
}
