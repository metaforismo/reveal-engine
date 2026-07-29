import { createHash } from 'node:crypto';
import { fail } from '../api/errors.js';
import { ENGINE_LIMITS } from '../api/limits.js';
import { stableJson } from '../internal/canonical.js';
import { rational, type Rational } from './rational.js';

/**
 * Wire helpers shared by every lifecycle module's round snapshot.
 *
 * Snapshots are attacker-controlled reconnect state. Everything here fails
 * closed with `INVALID_SNAPSHOT` and never coerces: exact key sets, canonical
 * decimal integers, and bounded strings only.
 */

export interface WireRational {
  readonly numerator: string;
  readonly denominator: string;
}

const MAX_WIRE_STRING_BYTES = 1234;

export { stableJson };

export function snapshotHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function assertSnapshotRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_SNAPSHOT', 'Expected an object', path);
  return value as Record<string, unknown>;
}

export function assertSnapshotKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail('INVALID_SNAPSHOT', 'Object has missing or unknown fields', path);
}

export function assertWireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_WIRE_STRING_BYTES)
    fail('INVALID_SNAPSHOT', 'Expected a bounded string', path);
}

export function assertWireHex(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    fail('INVALID_SNAPSHOT', 'Expected canonical 32-byte hexadecimal', path);
}

export function parseWireBigInt(value: string, path: string, allowZero = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value))
    fail('INVALID_SNAPSHOT', 'Invalid canonical integer', path);
  const parsed = BigInt(value);
  if ((!allowZero && parsed <= 0n) || parsed.toString(2).length > ENGINE_LIMITS.maxBigIntBits)
    fail('INVALID_SNAPSHOT', 'Snapshot integer outside limits', path);
  return parsed;
}

export function parseWireSignedBigInt(value: string, path: string): bigint {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/u.test(value) || value === '-0')
    fail('INVALID_SNAPSHOT', 'Invalid canonical signed integer', path);
  const parsed = BigInt(value);
  if ((parsed < 0n ? -parsed : parsed).toString(2).length > ENGINE_LIMITS.maxBigIntBits)
    fail('INVALID_SNAPSHOT', 'Snapshot integer outside limits', path);
  return parsed;
}

export function assertSnapshotRevision(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_SNAPSHOT', 'Invalid revision', path);
  return value;
}

export function toWireRational(value: Rational): WireRational {
  return Object.freeze({
    numerator: String(value.numerator),
    denominator: String(value.denominator),
  });
}

export function fromWireRational(value: WireRational, path = '$'): Rational {
  return rational(
    parseWireBigInt(value.numerator, `${path}.numerator`, true),
    parseWireBigInt(value.denominator, `${path}.denominator`),
  );
}

/** Parses and byte-bounds a JSON snapshot before any structural work happens. */
export function parseSnapshotJson(input: string): unknown {
  if (Buffer.byteLength(input, 'utf8') > ENGINE_LIMITS.maxSnapshotBytes)
    fail('PAYLOAD_TOO_LARGE', 'Snapshot exceeds byte limit');
  try {
    return JSON.parse(input) as unknown;
  } catch {
    fail('INVALID_SNAPSHOT', 'Snapshot is not valid JSON');
  }
}

export function assertSnapshotSize(value: unknown): void {
  if (Buffer.byteLength(stableJson(value), 'utf8') > ENGINE_LIMITS.maxSnapshotBytes)
    fail('PAYLOAD_TOO_LARGE', 'Snapshot exceeds byte limit');
}
