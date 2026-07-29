import { ENGINE_LIMITS } from '../api/limits.js';
import { fail, type RevealEngineErrorCode } from '../api/errors.js';
import type { Rational } from './rational.js';
import {
  COMMITMENT_VERSION,
  LEGACY_COMMITMENT_VERSION,
  type CommitmentVersion,
} from './versions.js';

/** Game-agnostic structural validation. Lifecycle modules layer their own asserts on top. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function assertRecord(
  value: unknown,
  code: RevealEngineErrorCode,
  message: string,
  path = '$',
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(code, message, path);
}

/** Rejects missing and unknown fields so unmodelled wire data can never survive a round trip. */
export function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: RevealEngineErrorCode,
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail(code, 'Object has missing or unknown fields', path);
}

/** Non-empty, bounded, control-character-free UTF-8 identifier. */
export function assertIdentifier(
  value: unknown,
  path: string,
  code: RevealEngineErrorCode = 'INVALID_ADAPTER',
  maxBytes: number = ENGINE_LIMITS.maxIdentifierBytes,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    byteLength(value) > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail(code, `Expected a non-empty bounded printable string`, path);
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

/** Non-negative BigInt within the public bit budget; zero is allowed. */
export function assertNonNegativeBigInt(value: unknown, path: string): asserts value is bigint {
  assertBoundedBigInt(value, path);
  if (value < 0n) fail('INVALID_RATIONAL', 'Expected a non-negative BigInt', path);
}

export function assertRational(value: unknown, path = '$'): asserts value is Rational {
  if (!isRecord(value)) fail('INVALID_RATIONAL', 'Expected rational object', path);
  assertBoundedBigInt(value.numerator, `${path}.numerator`);
  assertBoundedBigInt(value.denominator, `${path}.denominator`, true);
}

export function assertRevision(
  value: unknown,
  path: string,
  code: RevealEngineErrorCode = 'INVALID_SNAPSHOT',
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(code, 'Invalid revision', path);
}

export function assertProofVersion(
  value: unknown,
  path: string,
): asserts value is CommitmentVersion {
  if (value !== LEGACY_COMMITMENT_VERSION && value !== COMMITMENT_VERSION)
    fail('UNSUPPORTED_VERSION', 'Unsupported proof version', path);
}
