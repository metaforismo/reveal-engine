import { timingSafeEqual } from 'node:crypto';
import { fail } from '../api/errors.js';

/** A value that may appear in an unambiguous canonical field vector. */
export type CanonicalField = string | Uint8Array | bigint | number;

function lengthPrefix(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff)
    fail('PAYLOAD_TOO_LARGE', 'Canonical field is too large');
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32BE(length);
  return result;
}

/** Unambiguous typed framing: field count, then uint32 byte length + bytes per field. */
export function encodeFields(fields: readonly CanonicalField[]): Buffer {
  const encoded = fields.map((field) => {
    if (typeof field === 'bigint') return Buffer.from(field.toString(10), 'ascii');
    if (typeof field === 'number') {
      if (!Number.isSafeInteger(field)) fail('INVALID_TRANSCRIPT', 'Canonical number is not safe');
      return Buffer.from(String(field), 'ascii');
    }
    return typeof field === 'string' ? Buffer.from(field, 'utf8') : Buffer.from(field);
  });
  return Buffer.concat([
    lengthPrefix(encoded.length),
    ...encoded.flatMap((part) => [lengthPrefix(part.length), part]),
  ]);
}

export function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/** Deterministic JSON with sorted keys and dropped `undefined`; anchors snapshot checksums. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
