import { createHash, createHmac } from 'node:crypto';
import { ENGINE_LIMITS } from '../api/limits.js';
import { RevealEngineError, asRevealEngineError, fail } from '../api/errors.js';
import { constantTimeHexEqual, encodeFields } from '../internal/canonical.js';
import { adapterFingerprint } from './adapter.js';
import {
  COMMITMENT_VERSION,
  LEGACY_COMMITMENT_VERSION,
  type EvidenceEvent,
  type GameDefinition,
  type RoundContext,
  type Transcript,
  type VerificationFailure,
  type VerificationResult,
} from './contracts.js';
import { assertContext, assertDerivedEvidence, assertGameDefinition } from './validation.js';
import { deserializeTranscript } from '../serialization/transcript.js';

const UINT64 = 1n << 64n;

export function normalizeSeed(seedHex: string): string {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{64}$/iu.test(seedHex))
    fail('INVALID_SEED', 'Seed must be exactly 32 bytes of hexadecimal', '$.seed');
  return seedHex.toLowerCase();
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function legacyEvent(event: EvidenceEvent): string {
  return `${event.index}:${event.target}:${event.favour}:${event.other}:${event.label}`;
}

function legacyPayload(
  context: RoundContext,
  truth: number,
  events: readonly EvidenceEvent[],
): string {
  return [
    LEGACY_COMMITMENT_VERSION,
    context.gameId,
    context.roundId,
    String(truth),
    events.map(legacyEvent).join(','),
  ].join('|');
}

export function legacyCommitment(
  seedHex: string,
  context: RoundContext,
  truth: number,
  events: readonly EvidenceEvent[],
): string {
  normalizeSeed(seedHex);
  return sha256Hex(`${seedHex}|${legacyPayload(context, truth, events)}`);
}

export function canonicalTranscriptBytes(
  game: GameDefinition,
  context: RoundContext,
  truth: number,
  events: readonly EvidenceEvent[],
): Buffer {
  const fields: Array<string | bigint | number> = [
    'Axiom Games Reveal Engine commitment',
    COMMITMENT_VERSION,
    game.id,
    game.adapterVersion,
    adapterFingerprint(game),
    context.roundId,
    truth,
    events.length,
  ];
  events.forEach((event) =>
    fields.push(event.index, event.target, event.favour, event.other, event.label),
  );
  return encodeFields(fields);
}

export function commitment(
  seedHex: string,
  game: GameDefinition,
  context: RoundContext,
  truth: number,
  events: readonly EvidenceEvent[],
): string {
  assertGameDefinition(game);
  assertContext(context);
  const normalizedSeed = normalizeSeed(seedHex);
  if (context.gameId !== game.id) fail('ADAPTER_MISMATCH', 'Context game does not match adapter');
  if (context.proofVersion === LEGACY_COMMITMENT_VERSION)
    return legacyCommitment(seedHex, context, truth, events);
  return sha256Hex(
    encodeFields([
      'commitment',
      COMMITMENT_VERSION,
      Buffer.from(normalizedSeed, 'hex'),
      canonicalTranscriptBytes(game, context, truth, events),
    ]),
  );
}

function legacyUniform(
  seedHex: string,
  context: RoundContext,
  label: string,
  counter: number,
  modulus: bigint,
): bigint {
  if (modulus > UINT64) fail('INVALID_CONTEXT', 'Legacy sampler modulus exceeds uint64');
  const limit = UINT64 - (UINT64 % modulus);
  for (let nonce = 0n; ; nonce += 1n) {
    const digest = createHmac('sha256', Buffer.from(seedHex, 'hex'))
      .update(
        `${LEGACY_COMMITMENT_VERSION}|${context.gameId}|${context.roundId}|${label}|${counter}|${nonce}`,
      )
      .digest();
    const value = digest.readBigUInt64BE(0);
    if (value < limit) return value % modulus;
  }
}

/** Exact rejection sampling for a positive modulus up to 256 bits. */
export function uniformBigInt(
  seedHex: string,
  context: RoundContext,
  label: string,
  counter: number,
  modulus: bigint,
): bigint {
  const seed = normalizeSeed(seedHex);
  assertContext(context);
  if (
    typeof label !== 'string' ||
    label.length === 0 ||
    Buffer.byteLength(label, 'utf8') > ENGINE_LIMITS.maxLabelBytes
  )
    fail('INVALID_CONTEXT', 'Sampler label is invalid', '$.label');
  if (!Number.isSafeInteger(counter) || counter < 0)
    fail('INVALID_CONTEXT', 'Sampler counter is invalid', '$.counter');
  if (modulus <= 0n || modulus >= 1n << 256n)
    fail('INVALID_CONTEXT', 'Sampler modulus must be in [1, 2^256)', '$.modulus');
  if (context.proofVersion === LEGACY_COMMITMENT_VERSION)
    return legacyUniform(seed, context, label, counter, modulus);
  const range = 1n << 256n;
  const limit = range - (range % modulus);
  for (let nonce = 0n; ; nonce += 1n) {
    const payload = encodeFields([
      'sampler',
      COMMITMENT_VERSION,
      context.gameId,
      context.roundId,
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
  context: RoundContext,
  label: string,
  counter: number,
  modulus: number,
): number {
  if (!Number.isSafeInteger(modulus) || modulus <= 0)
    fail('INVALID_CONTEXT', 'Modulus must be a positive safe integer', '$.modulus');
  return Number(uniformBigInt(seedHex, context, label, counter, BigInt(modulus)));
}

export function deriveTruth(seedHex: string, game: GameDefinition, roundId: string): number {
  assertGameDefinition(game);
  const context: RoundContext = Object.freeze({
    gameId: game.id,
    roundId,
    proofVersion: COMMITMENT_VERSION,
  });
  const total = game.priorWeights.reduce((sum, weight) => sum + weight, 0n);
  if (total >= 1n << 256n)
    fail('INVALID_ADAPTER', 'Prior total exceeds deterministic sampler range', '$.priorWeights');
  const draw = uniformBigInt(seedHex, context, 'truth', 0, total);
  let cursor = 0n;
  for (let index = 0; index < game.priorWeights.length; index += 1) {
    cursor += game.priorWeights[index] ?? 0n;
    if (draw < cursor) return index;
  }
  fail('DERIVATION_FAILED', 'Truth derivation escaped the prior partition');
}

function deriveEvidence(
  seedHex: string,
  game: GameDefinition,
  context: RoundContext,
  truth: number,
): readonly EvidenceEvent[] {
  try {
    const first = game.evidence.derive(seedHex, context, truth);
    assertDerivedEvidence(game, first);
    const second = game.evidence.derive(seedHex, context, truth);
    assertDerivedEvidence(game, second);
    if (!evidenceEqual(first, second))
      fail('INVALID_ADAPTER', 'Evidence derivation is not deterministic', '$.evidence.derive');
    return Object.freeze(first.map((event) => Object.freeze({ ...event })));
  } catch (error) {
    throw asRevealEngineError(error, 'DERIVATION_FAILED', 'Evidence derivation failed');
  }
}

export function makeTranscript(seedHex: string, game: GameDefinition, roundId: string): Transcript {
  assertGameDefinition(game);
  const seed = normalizeSeed(seedHex);
  const context: RoundContext = Object.freeze({
    gameId: game.id,
    roundId,
    proofVersion: COMMITMENT_VERSION,
  });
  assertContext(context);
  const truth = deriveTruth(seed, game, roundId);
  const evidence = deriveEvidence(seed, game, context, truth);
  return Object.freeze({
    schema: 'reveal-engine/transcript-v2',
    adapterVersion: game.adapterVersion,
    context,
    truth,
    evidence,
    commitment: commitment(seed, game, context, truth, evidence),
  });
}

export function verifyTranscriptDetailed(
  seedHex: string,
  game: GameDefinition,
  input: unknown,
): VerificationResult {
  try {
    assertGameDefinition(game);
    const seed = normalizeSeed(seedHex);
    const transcript = deserializeTranscript(input);
    if (transcript.context.gameId !== game.id || transcript.adapterVersion !== game.adapterVersion)
      return failure('ADAPTER_MISMATCH', 'Transcript adapter does not match verifier', '$.adapter');
    const expectedTruth = deriveTruth(seed, game, transcript.context.roundId);
    if (
      transcript.context.proofVersion === COMMITMENT_VERSION &&
      transcript.truth !== expectedTruth
    )
      return failure(
        'TRANSCRIPT_MISMATCH',
        'Truth does not match deterministic derivation',
        '$.truth',
      );
    const expectedEvidence = deriveEvidence(seed, game, transcript.context, transcript.truth);
    if (!evidenceEqual(expectedEvidence, transcript.evidence))
      return failure(
        'TRANSCRIPT_MISMATCH',
        'Evidence transcript differs from derivation',
        '$.evidence',
      );
    const expectedCommitment = commitment(
      seedHex,
      game,
      transcript.context,
      transcript.truth,
      transcript.evidence,
    );
    if (!constantTimeHexEqual(expectedCommitment, transcript.commitment))
      return failure(
        'COMMITMENT_MISMATCH',
        'Commitment does not match revealed seed',
        '$.commitment',
      );
    return Object.freeze({
      ok: true,
      proofVersion: transcript.context.proofVersion,
      commitment: expectedCommitment,
    });
  } catch (error) {
    const failureError =
      error instanceof RevealEngineError
        ? error
        : asRevealEngineError(error, 'INVALID_TRANSCRIPT', 'Transcript verification failed');
    const code: VerificationFailure['code'] =
      failureError.code === 'UNSUPPORTED_VERSION'
        ? 'UNSUPPORTED_VERSION'
        : failureError.code === 'ADAPTER_MISMATCH'
          ? 'ADAPTER_MISMATCH'
          : failureError.code === 'DERIVATION_FAILED' || failureError.code === 'INVALID_ADAPTER'
            ? 'DERIVATION_FAILED'
            : 'INVALID_TRANSCRIPT';
    return failure(code, failureError.message, failureError.path);
  }
}

export function verifyTranscript(seedHex: string, game: GameDefinition, input: unknown): boolean {
  return verifyTranscriptDetailed(seedHex, game, input).ok;
}

function failure(
  code: VerificationFailure['code'],
  message: string,
  path: string,
): VerificationFailure {
  return Object.freeze({ ok: false, code, message, path });
}

export function evidenceEqual(
  left: readonly EvidenceEvent[],
  right: readonly EvidenceEvent[],
): boolean {
  return (
    left.length === right.length &&
    left.every((event, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        event.index === other.index &&
        event.target === other.target &&
        event.favour === other.favour &&
        event.other === other.other &&
        event.label === other.label
      );
    })
  );
}
