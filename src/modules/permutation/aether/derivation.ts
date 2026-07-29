import { createHmac } from 'node:crypto';
import { fail, RevealEngineError, type PermutationErrorCode } from '../../../api/errors.js';
import { normalizeSeed, sha256Hex } from '../../../core/random.js';
import { constantTimeHexEqual, encodeFields, stableJson } from '../../../internal/canonical.js';
import {
  assertExactKeys,
  assertRoundContext,
  assertSeedContext,
  isRecord,
  type RoundContext,
  type SeedContext,
} from './context.js';
import { permutationAdapterFingerprint, type PermutationGameDefinition } from './definition.js';
import { fisherYates, type Permutation } from './families.js';
import {
  AETHER_ORDER_GAME_ID,
  PERMUTATION_LIMITS,
  PERMUTATION_MODULE_VERSION,
  PERMUTATION_TRANSCRIPT_SCHEMA,
  SEED_COMMIT_DOMAIN,
  ZERO_COMMITMENT,
} from './identity.js';

const RANGE = 1n << 256n;
const TRANSCRIPT_KEYS = Object.freeze([
  'schema',
  'moduleVersion',
  'gameId',
  'adapterVersion',
  'adapterFingerprint',
  'variantId',
  'roundId',
  'clientSeed',
  'nonce',
  'n',
  'permutation',
  'previousCommitment',
  'seedCommitment',
  'commitment',
]);

function normalizeServerSeed(value: string): string {
  try {
    return normalizeSeed(value);
  } catch (error) {
    if (error instanceof RevealEngineError && error.code === 'INVALID_SEED')
      fail('INVALID_SEED', 'Server seed must be exactly 32 bytes of hexadecimal', '$.serverSeed');
    throw error;
  }
}

export interface PermutationTranscript {
  readonly schema: typeof PERMUTATION_TRANSCRIPT_SCHEMA;
  readonly moduleVersion: typeof PERMUTATION_MODULE_VERSION;
  readonly gameId: string;
  readonly adapterVersion: string;
  readonly adapterFingerprint: string;
  readonly variantId: string;
  readonly roundId: string;
  readonly clientSeed: string;
  readonly nonce: number;
  readonly n: number;
  readonly permutation: Permutation;
  readonly previousCommitment: string;
  readonly seedCommitment: string;
  readonly commitment: string;
}

export type VerificationResult =
  | { readonly ok: true; readonly commitment: string }
  | {
      readonly ok: false;
      readonly code: PermutationErrorCode;
      readonly message: string;
      readonly path: string;
    };

function assertDigest(
  value: unknown,
  path: string,
  code: 'INVALID_TRANSCRIPT' | 'INVALID_TICKET' = 'INVALID_TRANSCRIPT',
): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    fail(code, 'Expected a 32-byte lowercase hexadecimal digest', path);
  return value;
}

function assertGameContext(game: PermutationGameDefinition, context: RoundContext): void {
  if (context.gameId !== game.id)
    fail('INVALID_CONTEXT', 'Round context belongs to another game', '$.gameId');
  if (context.variantId !== game.variantId)
    fail('ADAPTER_MISMATCH', 'Round context belongs to another variant', '$.variantId');
}

/**
 * The pre-ticket publication. Its fixed game id follows the normative
 * signature, which intentionally has no game parameter.
 */
export function seedCommitment(serverSeedHex: string, context: SeedContext): string {
  const seed = normalizeServerSeed(serverSeedHex);
  const seedContext = assertSeedContext(context);
  return sha256Hex(
    encodeFields([
      SEED_COMMIT_DOMAIN,
      Buffer.from(seed, 'hex'),
      AETHER_ORDER_GAME_ID,
      seedContext.variantId,
      seedContext.roundId,
      seedContext.nonce,
    ]),
  );
}

/** Exact 256-bit rejection sampling; the loop is deliberately unbounded. */
export function uniformBelow(
  serverSeedHex: string,
  context: RoundContext,
  label: string,
  counter: number,
  modulus: bigint,
): bigint {
  const seed = normalizeServerSeed(serverSeedHex);
  const ctx = assertRoundContext(context);
  if (
    typeof label !== 'string' ||
    label.length === 0 ||
    Buffer.byteLength(label, 'utf8') > PERMUTATION_LIMITS.maxLabelBytes ||
    !/^[\x20-\x7e]+$/u.test(label)
  )
    fail('INVALID_CONTEXT', 'Sampler label must be bounded printable ASCII', '$.label');
  if (!Number.isSafeInteger(counter) || counter < 0)
    fail('INVALID_CONTEXT', 'Sampler counter is invalid', '$.counter');
  if (typeof modulus !== 'bigint' || modulus <= 0n || modulus >= RANGE)
    fail('INVALID_CONTEXT', 'Sampler modulus must be in [1, 2^256)', '$.modulus');
  const key = Buffer.from(seed, 'hex');
  const limit = RANGE - (RANGE % modulus);
  for (let rejection = 0n; ; rejection += 1n) {
    const payload = encodeFields([
      'sampler',
      PERMUTATION_MODULE_VERSION,
      ctx.gameId,
      ctx.variantId,
      ctx.roundId,
      ctx.clientSeed,
      ctx.nonce,
      label,
      counter,
      rejection,
      modulus,
    ]);
    const value = BigInt(`0x${createHmac('sha256', key).update(payload).digest('hex')}`);
    if (value < limit) return value % modulus;
  }
}

export function derivePermutation(
  serverSeedHex: string,
  game: PermutationGameDefinition,
  context: RoundContext,
): Permutation {
  const ctx = assertRoundContext(context);
  assertGameContext(game, ctx);
  const draws: number[] = [];
  for (let counter = 0; counter < game.n - 1; counter += 1)
    draws.push(
      Number(uniformBelow(serverSeedHex, ctx, 'shuffle', counter, BigInt(game.n - counter))),
    );
  return fisherYates(game.n, draws);
}

function transcriptBytes(
  game: PermutationGameDefinition,
  context: RoundContext,
  permutation: Permutation,
  previousCommitment: string,
): Buffer {
  const fields: (string | Uint8Array | bigint | number)[] = [
    'AETHER ORDER permutation transcript',
    PERMUTATION_TRANSCRIPT_SCHEMA,
    PERMUTATION_MODULE_VERSION,
    game.id,
    game.adapterVersion,
    permutationAdapterFingerprint(game),
    game.variantId,
    context.roundId,
    context.clientSeed,
    context.nonce,
    game.n,
    permutation.length,
  ];
  permutation.forEach((element, slot) => fields.push(slot, element));
  fields.push(previousCommitment);
  return encodeFields(fields);
}

export function permutationTranscriptCommitment(
  serverSeedHex: string,
  game: PermutationGameDefinition,
  context: RoundContext,
  permutation: Permutation,
  previousCommitment: string,
): string {
  const seed = normalizeServerSeed(serverSeedHex);
  return sha256Hex(
    encodeFields([
      'commitment',
      PERMUTATION_MODULE_VERSION,
      Buffer.from(seed, 'hex'),
      transcriptBytes(game, context, permutation, previousCommitment),
    ]),
  );
}

export function makePermutationTranscript(
  serverSeedHex: string,
  game: PermutationGameDefinition,
  context: RoundContext,
  previousCommitment = ZERO_COMMITMENT,
): PermutationTranscript {
  const seed = normalizeServerSeed(serverSeedHex);
  const ctx = assertRoundContext(context);
  assertGameContext(game, ctx);
  const previous = assertDigest(previousCommitment, '$.previousCommitment');
  const permutation = derivePermutation(seed, game, ctx);
  return Object.freeze({
    schema: PERMUTATION_TRANSCRIPT_SCHEMA,
    moduleVersion: PERMUTATION_MODULE_VERSION,
    gameId: game.id,
    adapterVersion: game.adapterVersion,
    adapterFingerprint: permutationAdapterFingerprint(game),
    variantId: game.variantId,
    roundId: ctx.roundId,
    clientSeed: ctx.clientSeed,
    nonce: ctx.nonce,
    n: game.n,
    permutation: Object.freeze([...permutation]),
    previousCommitment: previous,
    seedCommitment: seedCommitment(seed, {
      variantId: ctx.variantId,
      roundId: ctx.roundId,
      nonce: ctx.nonce,
    }),
    commitment: permutationTranscriptCommitment(seed, game, ctx, permutation, previous),
  });
}

function reject(code: PermutationErrorCode, message: string, path: string): VerificationResult {
  return Object.freeze({ ok: false, code, message, path });
}

export function verifyPermutationTranscript(
  serverSeedHex: string,
  game: PermutationGameDefinition,
  input: unknown,
): VerificationResult {
  try {
    const seed = normalizeServerSeed(serverSeedHex);
    if (!isRecord(input))
      return reject('INVALID_TRANSCRIPT', 'Transcript must be a plain object', '$');
    assertExactKeys(input, TRANSCRIPT_KEYS, 'INVALID_TRANSCRIPT');
    if (input.schema !== PERMUTATION_TRANSCRIPT_SCHEMA)
      return reject('UNSUPPORTED_VERSION', 'Unknown transcript schema', '$.schema');
    if (input.moduleVersion !== PERMUTATION_MODULE_VERSION)
      return reject('UNSUPPORTED_VERSION', 'Unknown module version', '$.moduleVersion');
    if (
      input.gameId !== game.id ||
      input.adapterVersion !== game.adapterVersion ||
      input.variantId !== game.variantId
    )
      return reject(
        'ADAPTER_MISMATCH',
        'Transcript belongs to another adapter',
        '$.adapterVersion',
      );
    if (
      typeof input.adapterFingerprint !== 'string' ||
      !constantTimeHexEqual(input.adapterFingerprint, permutationAdapterFingerprint(game))
    )
      return reject(
        'ADAPTER_MISMATCH',
        'Adapter fingerprint does not match this build',
        '$.adapterFingerprint',
      );
    const previous = assertDigest(input.previousCommitment, '$.previousCommitment');
    const context = assertRoundContext({
      gameId: input.gameId,
      variantId: input.variantId,
      roundId: input.roundId,
      clientSeed: input.clientSeed,
      nonce: input.nonce,
    });
    if (input.n !== game.n)
      return reject('INVALID_TRANSCRIPT', 'Element count does not match the adapter', '$.n');
    const permutation = assertPermutation(input.permutation, game.n, '$.permutation');
    const expected = derivePermutation(seed, game, context);
    if (expected.some((element, slot) => element !== permutation[slot]))
      return reject(
        'TRANSCRIPT_MISMATCH',
        'Permutation does not match deterministic derivation',
        '$.permutation',
      );
    if (typeof input.seedCommitment !== 'string' || !/^[0-9a-f]{64}$/u.test(input.seedCommitment))
      return reject(
        'INVALID_TRANSCRIPT',
        'Pre-round seed commitment is missing or malformed',
        '$.seedCommitment',
      );
    const expectedSeedCommitment = seedCommitment(seed, {
      variantId: context.variantId,
      roundId: context.roundId,
      nonce: context.nonce,
    });
    if (!constantTimeHexEqual(input.seedCommitment, expectedSeedCommitment))
      return reject(
        'COMMITMENT_MISMATCH',
        'Pre-round seed commitment does not open to this seed',
        '$.seedCommitment',
      );
    const expectedCommitment = permutationTranscriptCommitment(
      seed,
      game,
      context,
      expected,
      previous,
    );
    if (
      typeof input.commitment !== 'string' ||
      !constantTimeHexEqual(input.commitment, expectedCommitment)
    )
      return reject(
        'COMMITMENT_MISMATCH',
        'Commitment does not open to the revealed seed',
        '$.commitment',
      );
    return Object.freeze({ ok: true, commitment: expectedCommitment });
  } catch (error) {
    if (error instanceof RevealEngineError)
      return reject(error.code as PermutationErrorCode, error.message, error.path);
    return reject('INVALID_TRANSCRIPT', 'Transcript verification failed', '$');
  }
}

export function assertPermutation(value: unknown, n: number, path: string): Permutation {
  if (!Array.isArray(value) || value.length !== n)
    fail('INVALID_TRANSCRIPT', 'Permutation has the wrong length', path);
  const copy = Array.prototype.slice.call(value) as unknown[];
  const seen = new Set<number>();
  for (const element of copy) {
    if (
      !Number.isInteger(element) ||
      Number(element) < 0 ||
      Number(element) >= n ||
      seen.has(Number(element))
    )
      fail('INVALID_TRANSCRIPT', 'Value is not a permutation of [0, n)', path);
    seen.add(Number(element));
  }
  return Object.freeze(copy.map(Number));
}

function canonicalPrettyJson(value: unknown): string {
  return `${JSON.stringify(JSON.parse(stableJson(value)), null, 2)}\n`;
}

export function serializeTranscript(transcript: PermutationTranscript): string {
  const validated = deserializeTranscript(transcript);
  const json = canonicalPrettyJson(validated);
  if (Buffer.byteLength(json, 'utf8') > PERMUTATION_LIMITS.maxTranscriptBytes)
    fail('INVALID_TRANSCRIPT', 'Serialised transcript exceeds the byte limit', '$');
  return json;
}

export function deserializeTranscript(input: unknown): PermutationTranscript {
  let value = input;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > PERMUTATION_LIMITS.maxTranscriptBytes)
      fail('INVALID_TRANSCRIPT', 'Serialised transcript exceeds the byte limit', '$');
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      fail('INVALID_TRANSCRIPT', 'Transcript is not valid JSON', '$');
    }
  }
  if (!isRecord(value)) fail('INVALID_TRANSCRIPT', 'Transcript must be a plain object', '$');
  assertExactKeys(value, TRANSCRIPT_KEYS, 'INVALID_TRANSCRIPT');
  if (value.schema !== PERMUTATION_TRANSCRIPT_SCHEMA)
    fail('UNSUPPORTED_VERSION', 'Unknown transcript schema', '$.schema');
  if (value.moduleVersion !== PERMUTATION_MODULE_VERSION)
    fail('UNSUPPORTED_VERSION', 'Unknown module version', '$.moduleVersion');
  if (value.gameId !== AETHER_ORDER_GAME_ID)
    fail('ADAPTER_MISMATCH', 'Transcript belongs to another game', '$.gameId');
  const context = assertRoundContext({
    gameId: value.gameId,
    variantId: value.variantId,
    roundId: value.roundId,
    clientSeed: value.clientSeed,
    nonce: value.nonce,
  });
  if (!Number.isSafeInteger(value.n) || Number(value.n) < 2)
    fail('INVALID_TRANSCRIPT', 'Transcript n is invalid', '$.n');
  const n = Number(value.n);
  return Object.freeze({
    schema: PERMUTATION_TRANSCRIPT_SCHEMA,
    moduleVersion: PERMUTATION_MODULE_VERSION,
    gameId: AETHER_ORDER_GAME_ID,
    adapterVersion:
      typeof value.adapterVersion === 'string'
        ? value.adapterVersion
        : fail('INVALID_TRANSCRIPT', 'Adapter version must be a string', '$.adapterVersion'),
    adapterFingerprint: assertDigest(value.adapterFingerprint, '$.adapterFingerprint'),
    variantId: context.variantId,
    roundId: context.roundId,
    clientSeed: context.clientSeed,
    nonce: context.nonce,
    n,
    permutation: assertPermutation(value.permutation, n, '$.permutation'),
    previousCommitment: assertDigest(value.previousCommitment, '$.previousCommitment'),
    seedCommitment: assertDigest(value.seedCommitment, '$.seedCommitment'),
    commitment: assertDigest(value.commitment, '$.commitment'),
  });
}
