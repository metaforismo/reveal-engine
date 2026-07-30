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
const MAX_SNAPSHOT_DEPTH = 128;
const MAX_SNAPSHOT_NODES = 500_000;
const MAX_SNAPSHOT_ARRAY_LENGTH = ENGINE_LIMITS.maxReceipts;

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

/**
 * Iteratively snapshots an object-form restore payload before any hashing or
 * structural parsing touches it.
 *
 * Besides bounding work, returning a detached graph is important: accessors are
 * rejected and Proxy descriptors are consumed once, so later validation never
 * re-reads caller-owned state. Cycles, sparse arrays and exotic prototypes have
 * no JSON representation and are refused rather than interpreted.
 */
export function preflightSnapshotInput(value: unknown): unknown {
  type Work = {
    readonly source: object;
    readonly target: Record<string, unknown> | unknown[];
    readonly depth: number;
  };

  const seen = new WeakSet<object>();
  let nodes = 0;
  let approximateBytes = 0;

  const makeTarget = (source: object, path: string): Record<string, unknown> | unknown[] => {
    if (!Array.isArray(source)) return Object.create(null) as Record<string, unknown>;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, 'length');
    } catch {
      fail('INVALID_SNAPSHOT', 'Snapshot array could not be inspected safely', path);
    }
    const length = descriptor?.value;
    if (!Number.isSafeInteger(length) || length < 0)
      fail('INVALID_SNAPSHOT', 'Snapshot array has an invalid length', path);
    if (length > MAX_SNAPSHOT_ARRAY_LENGTH)
      fail('PAYLOAD_TOO_LARGE', 'Snapshot array exceeds length limit', path);
    return new Array(length);
  };

  const scalar = (input: unknown, path: string): unknown => {
    nodes += 1;
    if (nodes > MAX_SNAPSHOT_NODES) fail('PAYLOAD_TOO_LARGE', 'Snapshot exceeds node limit', path);
    if (input === null || typeof input === 'boolean') {
      approximateBytes += input === null ? 4 : input ? 4 : 5;
      return input;
    }
    if (typeof input === 'string') {
      const bytes = Buffer.byteLength(input, 'utf8');
      if (bytes > ENGINE_LIMITS.maxSnapshotBytes)
        fail('PAYLOAD_TOO_LARGE', 'Snapshot string exceeds byte limit', path);
      approximateBytes += bytes + 2;
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) fail('INVALID_SNAPSHOT', 'Snapshot number must be finite', path);
      approximateBytes += String(input).length;
      return input;
    }
    if (typeof input !== 'object')
      fail('INVALID_SNAPSHOT', 'Snapshot contains a non-JSON value', path);
    return undefined;
  };

  const rootScalar = scalar(value, '$');
  if (rootScalar !== undefined || value === null) return rootScalar;
  const rootSource = value as object;
  const rootTarget = makeTarget(rootSource, '$');
  const stack: Work[] = [{ source: rootSource, target: rootTarget, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop() as Work;
    if (current.depth > MAX_SNAPSHOT_DEPTH)
      fail('PAYLOAD_TOO_LARGE', 'Snapshot exceeds nesting-depth limit');
    if (seen.has(current.source)) fail('INVALID_SNAPSHOT', 'Snapshot graph contains a cycle');
    seen.add(current.source);

    let descriptors: PropertyDescriptorMap;
    let symbols: symbol[];
    let prototype: object | null;
    try {
      descriptors = Object.getOwnPropertyDescriptors(current.source);
      symbols = Object.getOwnPropertySymbols(current.source);
      prototype = Object.getPrototypeOf(current.source) as object | null;
    } catch {
      fail('INVALID_SNAPSHOT', 'Snapshot object could not be inspected safely');
    }
    if (symbols.length !== 0)
      fail('INVALID_SNAPSHOT', 'Snapshot objects may not carry symbol keys');

    const isArray = Array.isArray(current.source);
    if (
      (!isArray && prototype !== Object.prototype && prototype !== null) ||
      (isArray && prototype !== Array.prototype)
    )
      fail('INVALID_SNAPSHOT', 'Snapshot contains an exotic object');

    let names = Object.keys(descriptors);
    if (isArray) {
      const length = descriptors.length?.value as number;
      names = names.filter((name) => name !== 'length');
      if (names.length !== length || names.some((name, index) => name !== String(index)))
        fail('INVALID_SNAPSHOT', 'Snapshot arrays must be dense and index-only');
      approximateBytes += length + 2;
    } else {
      approximateBytes += names.length + 2;
    }

    for (const name of names) {
      const descriptor = descriptors[name] as PropertyDescriptor;
      if (!descriptor.enumerable || !('value' in descriptor))
        fail('INVALID_SNAPSHOT', 'Snapshot fields must be enumerable data properties', `$.${name}`);
      approximateBytes += Buffer.byteLength(name, 'utf8') + 3;
      if (approximateBytes > ENGINE_LIMITS.maxSnapshotBytes)
        fail('PAYLOAD_TOO_LARGE', 'Snapshot exceeds byte limit');

      const child = descriptor.value;
      const copied = scalar(child, `$.${name}`);
      if (copied !== undefined || child === null) {
        (current.target as Record<string, unknown>)[name] = copied;
        continue;
      }
      const childSource = child as object;
      const childTarget = makeTarget(childSource, `$.${name}`);
      (current.target as Record<string, unknown>)[name] = childTarget;
      stack.push({ source: childSource, target: childTarget, depth: current.depth + 1 });
    }
  }
  return rootTarget;
}

export function assertSnapshotSize(value: unknown): void {
  if (Buffer.byteLength(stableJson(value), 'utf8') > ENGINE_LIMITS.maxSnapshotBytes)
    fail('PAYLOAD_TOO_LARGE', 'Snapshot exceeds byte limit');
}
