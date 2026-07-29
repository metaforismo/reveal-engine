import { asRevealEngineError, fail } from '../../api/errors.js';
import { sealCommitment, sealLegacyCommitment } from '../../core/commitment.js';
import {
  constantTimeHexEqual,
  encodeFields,
  type CanonicalField,
} from '../../internal/canonical.js';
import type { RoundIdentity } from '../../core/module.js';
import {
  normalizeSeed,
  sha256Hex,
  uniform as scopedUniform,
  uniformBigInt as scopedUniformBigInt,
  type SamplerScope,
} from '../../core/random.js';
import {
  classifyVerificationError,
  verificationFailure,
  verificationSuccess,
  type VerificationFailure,
  type VerificationResult,
} from '../../core/verification.js';
import { COMMITMENT_VERSION, LEGACY_COMMITMENT_VERSION } from '../../core/versions.js';
import { adapterFingerprint } from './adapter.js';
import {
  PROGRESSIVE_MARKET_MODULE_ID,
  TRANSCRIPT_SCHEMA,
  type EvidenceEvent,
  type GameDefinition,
  type RoundContext,
  type Transcript,
} from './contracts.js';
import { deserializeTranscript } from './transcript.js';
import { assertContext, assertDerivedEvidence, assertGameDefinition } from './validation.js';

export { normalizeSeed, sha256Hex };

/** Sampler scope for a round: the adapter id is the domain, so games never collide. */
export function scopeOf(context: RoundContext): SamplerScope {
  return { domain: context.gameId, roundId: context.roundId, proofVersion: context.proofVersion };
}

/**
 * Round-scoped rejection sampler for adapter authors.
 *
 * An evidence schedule receives a `RoundContext`; these wrappers map it onto the
 * core sampler so an adapter can never accidentally draw outside its own round.
 */
export function uniformBigInt(
  seedHex: string,
  context: RoundContext,
  label: string,
  counter: number,
  modulus: bigint,
): bigint {
  return scopedUniformBigInt(seedHex, scopeOf(context), label, counter, modulus);
}

export function uniform(
  seedHex: string,
  context: RoundContext,
  label: string,
  counter: number,
  modulus: number,
): number {
  return scopedUniform(seedHex, scopeOf(context), label, counter, modulus);
}

export function roundIdentityOf(context: RoundContext): RoundIdentity {
  return Object.freeze({
    moduleId: PROGRESSIVE_MARKET_MODULE_ID,
    definitionId: context.gameId,
    roundId: context.roundId,
    proofVersion: context.proofVersion,
  });
}

export function roundContext(gameId: string, roundId: string): RoundContext {
  return Object.freeze({ gameId, roundId, proofVersion: COMMITMENT_VERSION });
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
  return sealLegacyCommitment(seedHex, legacyPayload(context, truth, events));
}

/**
 * Canonical commitment body for one progressive-market round.
 *
 * Binding the adapter fingerprint means an operator cannot publish a commitment
 * under one set of economics and settle under another.
 */
export function canonicalTranscriptBytes(
  game: GameDefinition,
  context: RoundContext,
  truth: number,
  events: readonly EvidenceEvent[],
): Buffer {
  const fields: CanonicalField[] = [
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
  normalizeSeed(seedHex);
  if (context.gameId !== game.id) fail('ADAPTER_MISMATCH', 'Context game does not match adapter');
  if (context.proofVersion === LEGACY_COMMITMENT_VERSION)
    return legacyCommitment(seedHex, context, truth, events);
  return sealCommitment(seedHex, canonicalTranscriptBytes(game, context, truth, events));
}

/** Deterministic prior-weighted truth. One seed and one adapter mean exactly one truth. */
export function deriveTruth(seedHex: string, game: GameDefinition, roundId: string): number {
  assertGameDefinition(game);
  const context = roundContext(game.id, roundId);
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

export function deriveEvidence(
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
  const context = roundContext(game.id, roundId);
  assertContext(context);
  const truth = deriveTruth(seed, game, roundId);
  const evidence = deriveEvidence(seed, game, context, truth);
  return Object.freeze({
    schema: TRANSCRIPT_SCHEMA,
    adapterVersion: game.adapterVersion,
    context,
    truth,
    evidence,
    commitment: commitment(seed, game, context, truth, evidence),
  });
}

/**
 * Pure re-derivation verifier.
 *
 * Phase order is fixed by the lifecycle-module contract: decode, identity,
 * truth, steps, commitment. Legacy `commit-v1` transcripts skip the truth
 * re-derivation phase because that scheme did not bind a deterministic truth;
 * they remain verification-only.
 */
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
    return verificationSuccess(transcript.context.proofVersion, expectedCommitment);
  } catch (error) {
    return classifyVerificationError(error);
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
  return verificationFailure(code, message, path);
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
