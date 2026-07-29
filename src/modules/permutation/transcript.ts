import { fail } from '../../api/errors.js';
import { ENGINE_LIMITS } from '../../api/limits.js';
import {
  ACCEPTED_TRANSCRIPT_SCHEMAS,
  MAX_ITEMS,
  MIN_ITEMS,
  PERMUTATION_TRANSCRIPT_SCHEMA,
  type PermutationTranscript,
  type WirePermutationTranscript,
} from './contracts.js';

/**
 * The untrusted-input boundary for this module's proof format.
 *
 * Everything here fails closed with a typed error and a path: exact key sets, no
 * coercion, bounded lengths, and a schema check that rejects anything unknown
 * rather than guessing. A transcript arrives from a player, a mirror, or a
 * third-party verifier, and the only safe posture is that none of them are
 * trusted to have produced it honestly.
 *
 * What this codec does **not** do is decide whether the transcript is *true*.
 * It checks that `order` is a genuine permutation and that `reveals` is a
 * well-formed settle prefix, because a transcript failing either is malformed
 * rather than merely wrong; whether the reveals agree with the order, and
 * whether either agrees with the seed, is `verifyPermutationTranscript`'s
 * question and is answered by re-derivation, not by cross-checking a document
 * against itself.
 */

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

function hex32(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    fail('INVALID_TRANSCRIPT', 'Expected canonical 32-byte hexadecimal', path);
  return value;
}

/** Rejects anything that is not a genuine permutation of `[0, length)`. */
function parseOrder(value: unknown, path: string): readonly number[] {
  if (!Array.isArray(value) || value.length < MIN_ITEMS || value.length > MAX_ITEMS)
    fail('INVALID_TRANSCRIPT', `Order must name ${MIN_ITEMS}..${MAX_ITEMS} items`, path);
  const seen = new Set<number>();
  const order: number[] = [];
  // Indexed rather than `forEach`: JSON cannot produce a sparse array, but this
  // codec also accepts a decoded object straight from a caller, and a hole must
  // be a rejection rather than an element the validator never visits.
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    if (!Number.isSafeInteger(item) || (item as number) < 0 || (item as number) >= value.length)
      fail('INVALID_TRANSCRIPT', 'Order names an item outside the draw', `${path}[${index}]`);
    if (seen.has(item as number))
      fail('INVALID_TRANSCRIPT', 'Order repeats an item', `${path}[${index}]`);
    seen.add(item as number);
    order.push(item as number);
  }
  return Object.freeze(order);
}

function parseReveals(
  value: unknown,
  size: number,
  path: string,
): readonly { readonly position: number; readonly item: number }[] {
  if (!Array.isArray(value) || value.length !== size - 1)
    fail('INVALID_TRANSCRIPT', 'A round reveals exactly one position short of the draw', path);
  const seen = new Set<number>();
  const reveals: { readonly position: number; readonly item: number }[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    const step = isRecord(entry)
      ? entry
      : fail('INVALID_TRANSCRIPT', 'Expected a reveal object', `${path}[${index}]`);
    exactKeys(step, ['position', 'item'], `${path}[${index}]`);
    if (step.position !== index)
      fail(
        'INVALID_TRANSCRIPT',
        'Reveals must be a prefix in settle order',
        `${path}[${index}].position`,
      );
    if (
      !Number.isSafeInteger(step.item) ||
      (step.item as number) < 0 ||
      (step.item as number) >= size
    )
      fail('INVALID_TRANSCRIPT', 'Reveal names an item outside the draw', `${path}[${index}].item`);
    if (seen.has(step.item as number))
      fail('INVALID_TRANSCRIPT', 'Reveals settle one item twice', `${path}[${index}].item`);
    seen.add(step.item as number);
    reveals.push(Object.freeze({ position: index, item: step.item as number }));
  }
  return Object.freeze(reveals);
}

export function permutationTranscriptToWire(
  transcript: PermutationTranscript,
): WirePermutationTranscript {
  return Object.freeze({
    schema: PERMUTATION_TRANSCRIPT_SCHEMA,
    definition: Object.freeze({ ...transcript.definition }),
    roundId: transcript.roundId,
    order: Object.freeze([...transcript.order]),
    reveals: Object.freeze(transcript.reveals.map((step) => Object.freeze({ ...step }))),
    commitment: transcript.commitment,
  });
}

export function serializePermutationTranscript(transcript: PermutationTranscript): string {
  return JSON.stringify(permutationTranscriptToWire(transcript));
}

export function deserializePermutationTranscript(input: unknown): PermutationTranscript {
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
  if (!isRecord(value)) fail('INVALID_TRANSCRIPT', 'Expected a transcript object');
  if (!ACCEPTED_TRANSCRIPT_SCHEMAS.includes(value.schema as string))
    fail('UNSUPPORTED_VERSION', 'Unsupported transcript schema', '$.schema');
  exactKeys(value, ['schema', 'definition', 'roundId', 'order', 'reveals', 'commitment'], '$');
  if (!isRecord(value.definition))
    fail('INVALID_TRANSCRIPT', 'Expected a definition identity', '$.definition');
  exactKeys(value.definition, ['id', 'version', 'fingerprint'], '$.definition');
  const order = parseOrder(value.order, '$.order');
  return Object.freeze({
    schema: PERMUTATION_TRANSCRIPT_SCHEMA,
    definition: Object.freeze({
      id: boundedString(value.definition.id, '$.definition.id'),
      version: boundedString(value.definition.version, '$.definition.version'),
      fingerprint: hex32(value.definition.fingerprint, '$.definition.fingerprint'),
    }),
    roundId: boundedString(value.roundId, '$.roundId'),
    order,
    reveals: parseReveals(value.reveals, order.length, '$.reveals'),
    commitment: hex32(value.commitment, '$.commitment'),
  });
}
