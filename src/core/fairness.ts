import { createHash, createHmac } from 'node:crypto';
import {
  CONTRACT_VERSION,
  type EvidenceEvent,
  type GameDefinition,
  type RoundContext,
  type Transcript,
} from './contracts.js';

const UINT64 = 1n << 64n;
function bytes(input: string): Buffer {
  return Buffer.from(input, 'utf8');
}
function canonicalEvent(event: EvidenceEvent): string {
  return `${event.index}:${event.target}:${event.favour}:${event.other}:${event.label}`;
}
function canonicalTranscript(
  context: RoundContext,
  truth: number,
  events: readonly EvidenceEvent[],
): string {
  return [
    CONTRACT_VERSION,
    context.gameId,
    context.roundId,
    String(truth),
    events.map(canonicalEvent).join(','),
  ].join('|');
}
export function sha256Hex(input: string): string {
  return createHash('sha256').update(bytes(input)).digest('hex');
}
export function commitment(
  seedHex: string,
  context: RoundContext,
  truth: number,
  events: readonly EvidenceEvent[],
): string {
  if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new RangeError('Seed must be 32-byte hex');
  return sha256Hex(`${seedHex}|${canonicalTranscript(context, truth, events)}`);
}
/** Uniform draw in [0, modulus), bound to every protocol domain; no modulo bias. */
export function uniform(
  seedHex: string,
  context: RoundContext,
  label: string,
  counter: number,
  modulus: number,
): number {
  if (
    !Number.isSafeInteger(modulus) ||
    modulus <= 0 ||
    !Number.isSafeInteger(counter) ||
    counter < 0
  )
    throw new RangeError('Invalid sampler input');
  const m = BigInt(modulus);
  const limit = UINT64 - (UINT64 % m);
  for (let nonce = 0n; ; nonce += 1n) {
    const payload = `${CONTRACT_VERSION}|${context.gameId}|${context.roundId}|${label}|${counter}|${nonce}`;
    const digest = createHmac('sha256', Buffer.from(seedHex, 'hex'))
      .update(bytes(payload))
      .digest();
    const value = digest.readBigUInt64BE(0);
    if (value < limit) return Number(value % m);
  }
}
export function makeTranscript(
  seedHex: string,
  game: GameDefinition,
  roundId: string,
  truth: number,
): Transcript {
  if (!Number.isSafeInteger(truth) || truth < 0 || truth >= game.outcomes.length)
    throw new RangeError('Truth outside outcomes');
  const context = Object.freeze({ gameId: game.id, roundId, contractVersion: CONTRACT_VERSION });
  const evidence = Object.freeze([...game.evidence.derive(seedHex, context, truth)]);
  return Object.freeze({
    context,
    truth,
    evidence,
    commitment: commitment(seedHex, context, truth, evidence),
  });
}
export function verifyTranscript(
  seedHex: string,
  game: GameDefinition,
  transcript: Transcript,
): boolean {
  if (
    transcript.context.contractVersion !== CONTRACT_VERSION ||
    transcript.context.gameId !== game.id
  )
    return false;
  const expected = makeTranscript(seedHex, game, transcript.context.roundId, transcript.truth);
  return (
    expected.commitment === transcript.commitment &&
    JSON.stringify(expected.evidence, bigintJson) ===
      JSON.stringify(transcript.evidence, bigintJson)
  );
}
function bigintJson(_: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
