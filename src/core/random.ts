import { createHash, createHmac } from 'node:crypto';
import { fail } from '../api/errors.js';
import { ENGINE_LIMITS } from '../api/limits.js';
import { encodeFields, type CanonicalField } from '../internal/canonical.js';
import { assertIdentifier, assertProofVersion, isRecord } from './validation.js';
import {
  COMMITMENT_VERSION,
  LEGACY_COMMITMENT_VERSION,
  type CommitmentVersion,
} from './versions.js';

const UINT64 = 1n << 64n;

/**
 * Domain under which a seed is expanded. `domain` is the definition identity
 * (an adapter or deck id), `roundId` the round, `proofVersion` the commitment
 * scheme. Two different games, rounds, or schemes never share a draw.
 */
export interface SamplerScope {
  readonly domain: string;
  readonly roundId: string;
  readonly proofVersion: CommitmentVersion;
}

export function assertSamplerScope(value: unknown, path = '$'): asserts value is SamplerScope {
  if (!isRecord(value)) fail('INVALID_CONTEXT', 'Expected sampler scope', path);
  assertIdentifier(value.domain, `${path}.domain`);
  assertIdentifier(value.roundId, `${path}.roundId`);
  assertProofVersion(value.proofVersion, `${path}.proofVersion`);
}

export function normalizeSeed(seedHex: string): string {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{64}$/iu.test(seedHex))
    fail('INVALID_SEED', 'Seed must be exactly 32 bytes of hexadecimal', '$.seed');
  return seedHex.toLowerCase();
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function assertLabel(label: unknown): asserts label is string {
  if (
    typeof label !== 'string' ||
    label.length === 0 ||
    Buffer.byteLength(label, 'utf8') > ENGINE_LIMITS.maxLabelBytes
  )
    fail('INVALID_CONTEXT', 'Sampler label is invalid', '$.label');
}

function assertCounter(counter: unknown): asserts counter is number {
  if (!Number.isSafeInteger(counter) || Number(counter) < 0)
    fail('INVALID_CONTEXT', 'Sampler counter is invalid', '$.counter');
}

function legacyUniform(
  seedHex: string,
  scope: SamplerScope,
  label: string,
  counter: number,
  modulus: bigint,
): bigint {
  if (modulus > UINT64) fail('INVALID_CONTEXT', 'Legacy sampler modulus exceeds uint64');
  const limit = UINT64 - (UINT64 % modulus);
  for (let nonce = 0n; ; nonce += 1n) {
    const digest = createHmac('sha256', Buffer.from(seedHex, 'hex'))
      .update(
        `${LEGACY_COMMITMENT_VERSION}|${scope.domain}|${scope.roundId}|${label}|${counter}|${nonce}`,
      )
      .digest();
    const value = digest.readBigUInt64BE(0);
    if (value < limit) return value % modulus;
  }
}

/** Exact rejection sampling for a positive modulus up to 256 bits; never uses floats. */
export function uniformBigInt(
  seedHex: string,
  scope: SamplerScope,
  label: string,
  counter: number,
  modulus: bigint,
): bigint {
  const seed = normalizeSeed(seedHex);
  assertSamplerScope(scope);
  assertLabel(label);
  assertCounter(counter);
  if (modulus <= 0n || modulus >= 1n << 256n)
    fail('INVALID_CONTEXT', 'Sampler modulus must be in [1, 2^256)', '$.modulus');
  if (scope.proofVersion === LEGACY_COMMITMENT_VERSION)
    return legacyUniform(seed, scope, label, counter, modulus);
  const range = 1n << 256n;
  const limit = range - (range % modulus);
  for (let nonce = 0n; ; nonce += 1n) {
    const payload = encodeFields([
      'sampler',
      COMMITMENT_VERSION,
      scope.domain,
      scope.roundId,
      label,
      counter,
      nonce,
      modulus,
    ]);
    const value = BigInt(
      `0x${createHmac('sha256', Buffer.from(seed, 'hex')).update(payload).digest('hex')}`,
    );
    if (value < limit) return value % modulus;
  }
}

export function uniform(
  seedHex: string,
  scope: SamplerScope,
  label: string,
  counter: number,
  modulus: number,
): number {
  if (!Number.isSafeInteger(modulus) || modulus <= 0)
    fail('INVALID_CONTEXT', 'Modulus must be a positive safe integer', '$.modulus');
  return Number(uniformBigInt(seedHex, scope, label, counter, BigInt(modulus)));
}

/**
 * Seeded Fisher-Yates over `[0, size)` using the same rejection sampler.
 *
 * This is the primitive for committed deck shuffles and for truth models whose
 * truth is an ordering rather than a scalar index. Draw `k` of the shuffle uses
 * counter `counterOffset + k`, so a caller can interleave several independent
 * permutations under distinct labels or disjoint counter ranges.
 */
export function uniformPermutation(
  seedHex: string,
  scope: SamplerScope,
  label: string,
  size: number,
  counterOffset = 0,
): readonly number[] {
  if (!Number.isSafeInteger(size) || size < 0 || size > ENGINE_LIMITS.maxPermutationSize)
    fail('INVALID_CONTEXT', 'Permutation size is outside limits', '$.size');
  assertCounter(counterOffset);
  const order = Array.from({ length: size }, (_, index) => index);
  for (let position = size - 1, draw = 0; position > 0; position -= 1, draw += 1) {
    const pick = Number(
      uniformBigInt(seedHex, scope, label, counterOffset + draw, BigInt(position + 1)),
    );
    const swapped = order[position] as number;
    order[position] = order[pick] as number;
    order[pick] = swapped;
  }
  return Object.freeze(order);
}

export interface TapeDraw {
  readonly label: string;
  readonly counter: number;
  readonly modulus: bigint;
  readonly value: bigint;
}

/**
 * A recorded, replayable expansion of one seed.
 *
 * A lifecycle module whose steps depend on logged player choices cannot derive
 * everything up front: it must interleave randomness with decisions. The tape
 * makes that interleaving auditable — every draw is addressed by (label,
 * counter) and recorded, so a verifier replaying the same seed and the same
 * logged choices reproduces the identical draw sequence and digest.
 */
export class RandomTape {
  readonly #seed: string;
  readonly #scope: SamplerScope;
  readonly #draws: TapeDraw[] = [];
  readonly #maxDraws: number;

  constructor(seedHex: string, scope: SamplerScope, maxDraws: number = ENGINE_LIMITS.maxTapeDraws) {
    this.#seed = normalizeSeed(seedHex);
    assertSamplerScope(scope);
    this.#scope = Object.freeze({ ...scope });
    if (!Number.isSafeInteger(maxDraws) || maxDraws <= 0 || maxDraws > ENGINE_LIMITS.maxTapeDraws)
      fail('INVALID_CONTEXT', 'Tape draw budget is outside limits', '$.maxDraws');
    this.#maxDraws = maxDraws;
  }

  get scope(): SamplerScope {
    return this.#scope;
  }

  get draws(): readonly TapeDraw[] {
    return Object.freeze([...this.#draws]);
  }

  draw(label: string, counter: number, modulus: bigint): bigint {
    if (this.#draws.length >= this.#maxDraws)
      fail('INVALID_CONTEXT', 'Tape draw budget exhausted', '$.draws');
    const value = uniformBigInt(this.#seed, this.#scope, label, counter, modulus);
    this.#draws.push(Object.freeze({ label, counter, modulus, value }));
    return value;
  }

  index(label: string, counter: number, size: number): number {
    if (!Number.isSafeInteger(size) || size <= 0)
      fail('INVALID_CONTEXT', 'Tape index size must be a positive safe integer', '$.size');
    return Number(this.draw(label, counter, BigInt(size)));
  }

  /** Canonical field vector binding the whole tape; safe to fold into a commitment body. */
  encode(): readonly CanonicalField[] {
    const fields: CanonicalField[] = ['tape', this.#scope.domain, this.#scope.roundId];
    fields.push(this.#draws.length);
    for (const entry of this.#draws)
      fields.push(entry.label, entry.counter, entry.modulus, entry.value);
    return Object.freeze(fields);
  }

  digest(): string {
    return sha256Hex(encodeFields(this.encode()));
  }
}
