import { timingSafeEqual } from 'node:crypto';
import { fail } from '../api/errors.js';

function lengthPrefix(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff)
    fail('PAYLOAD_TOO_LARGE', 'Canonical field is too large');
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32BE(length);
  return result;
}

/** Unambiguous typed framing: field count, then uint32 byte length + bytes per field. */
export function encodeFields(fields: readonly (string | Uint8Array | bigint | number)[]): Buffer {
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
