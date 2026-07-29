import { fail } from '../../../api/errors.js';
import { AETHER_ORDER_GAME_ID, PERMUTATION_LIMITS } from './identity.js';

export interface SeedContext {
  readonly variantId: string;
  readonly roundId: string;
  readonly nonce: number;
}

export interface RoundContext extends SeedContext {
  readonly gameId: string;
  readonly clientSeed: string;
}

const PRINTABLE = /^[\x20-\x7e]+$/u;
const PRINTABLE_OR_EMPTY = /^[\x20-\x7e]*$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: 'INVALID_CONTEXT' | 'INVALID_TRANSCRIPT' | 'INVALID_TICKET',
  path = '$',
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  const missing = expected.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing) fail(code, 'Object is missing a required field', `${path}.${missing}`);
  const unknown = actual.find((key) => !expected.includes(key));
  if (unknown) fail(code, 'Object carries an unknown field', `${path}.${unknown}`);
}

export function assertPrintableIdentifier(
  value: unknown,
  path: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    !(allowEmpty ? PRINTABLE_OR_EMPTY : PRINTABLE).test(value)
  )
    fail('INVALID_CONTEXT', 'Expected bounded printable ASCII', path);
  return value;
}

export function assertRoundId(value: unknown): string {
  return assertPrintableIdentifier(value, '$.roundId', PERMUTATION_LIMITS.maxRoundIdBytes);
}

export function assertClientSeed(value: unknown): string {
  return assertPrintableIdentifier(
    value,
    '$.clientSeed',
    PERMUTATION_LIMITS.maxClientSeedBytes,
    true,
  );
}

export function assertNonce(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    fail('INVALID_CONTEXT', 'Nonce must be a non-negative safe integer', '$.nonce');
  return Number(value);
}

export function assertSeedContext(value: unknown): SeedContext {
  if (!isRecord(value)) fail('INVALID_CONTEXT', 'Seed context must be a plain object', '$');
  // RoundContext extends SeedContext, so callers may pass the already-frozen
  // round context to seed-only operations. No unrelated key is accepted.
  const allowed = new Set(['variantId', 'roundId', 'nonce', 'gameId', 'clientSeed']);
  if (
    !Object.prototype.hasOwnProperty.call(value, 'variantId') ||
    !Object.prototype.hasOwnProperty.call(value, 'roundId') ||
    !Object.prototype.hasOwnProperty.call(value, 'nonce') ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    fail('INVALID_CONTEXT', 'Seed context carries an unknown or missing field', '$');
  const variantId = assertPrintableIdentifier(
    value.variantId,
    '$.variantId',
    PERMUTATION_LIMITS.maxRoundIdBytes,
  );
  return Object.freeze({
    variantId,
    roundId: assertRoundId(value.roundId),
    nonce: assertNonce(value.nonce),
  });
}

export function assertRoundContext(value: unknown): RoundContext {
  if (!isRecord(value)) fail('INVALID_CONTEXT', 'Round context must be a plain object', '$');
  assertExactKeys(
    value,
    ['gameId', 'variantId', 'roundId', 'clientSeed', 'nonce'],
    'INVALID_CONTEXT',
  );
  if (value.gameId !== AETHER_ORDER_GAME_ID)
    fail('INVALID_CONTEXT', 'Round context belongs to another game', '$.gameId');
  const seed = assertSeedContext({
    variantId: value.variantId,
    roundId: value.roundId,
    nonce: value.nonce,
  });
  return Object.freeze({
    gameId: AETHER_ORDER_GAME_ID,
    ...seed,
    clientSeed: assertClientSeed(value.clientSeed),
  });
}
