import { fail } from '../../../api/errors.js';
import { stableJson } from '../../../internal/canonical.js';
import { assertExactKeys, assertSeedContext, isRecord, type SeedContext } from './context.js';
import type { PermutationGameDefinition } from './definition.js';
import { permutationPlayPolicyDigest } from './definition.js';
import { deserializeTranscript, type PermutationTranscript } from './derivation.js';
import {
  PERMUTATION_LIMITS,
  PERMUTATION_MODULE_VERSION,
  PERMUTATION_SNAPSHOT_SCHEMA,
} from './identity.js';
import type { PermutationReceipt } from './receipt.js';
import type { Settlement, Ticket } from './ticket.js';

export interface RoundSnapshot {
  readonly schema: typeof PERMUTATION_SNAPSHOT_SCHEMA;
  readonly moduleVersion: typeof PERMUTATION_MODULE_VERSION;
  readonly gameId: string;
  readonly phase: 'COMMITTED' | 'TICKETED' | 'SETTLED';
  readonly variantId: string;
  readonly roundId: string;
  readonly nonce: number;
  readonly seedCommitment: string;
  readonly playPolicyDigest: string;
  readonly transcript: PermutationTranscript | null;
  readonly ticket: Ticket | null;
  readonly settlement: Settlement | null;
  readonly receipt: PermutationReceipt | null;
}

const SNAPSHOT_KEYS = Object.freeze([
  'schema',
  'moduleVersion',
  'gameId',
  'phase',
  'variantId',
  'roundId',
  'nonce',
  'seedCommitment',
  'playPolicyDigest',
  'transcript',
  'ticket',
  'settlement',
  'receipt',
]);
const PHASES = new Set(['COMMITTED', 'TICKETED', 'SETTLED']);
const MONEY_FIELDS = new Set(['stake', 'totalStake', 'gross', 'credited', 'net']);

function assertDigest(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    fail('INVALID_TRANSCRIPT', 'Expected a lowercase 32-byte digest', path);
  return value;
}

export function makeRoundSnapshot(input: {
  game: PermutationGameDefinition;
  phase: RoundSnapshot['phase'];
  seedContext: SeedContext;
  seedCommitment: string;
  playPolicyDigest?: string;
  transcript?: PermutationTranscript;
  ticket?: Ticket;
  settlement?: Settlement;
  receipt?: PermutationReceipt;
}): RoundSnapshot {
  const context = assertSeedContext(input.seedContext);
  if (context.variantId !== input.game.variantId)
    fail('ADAPTER_MISMATCH', 'Snapshot context belongs to another variant', '$.variantId');
  if (!PHASES.has(input.phase)) fail('INVALID_TRANSCRIPT', 'Unknown round phase', '$.phase');
  const transcript = input.transcript ?? null;
  const ticket = input.ticket ?? null;
  const settlement = input.settlement ?? null;
  const receipt = input.receipt ?? null;
  if (input.phase !== 'COMMITTED' && ticket === null)
    fail('INVALID_TICKET', 'TICKETED and SETTLED snapshots require a ticket', '$.ticket');
  if (input.phase === 'SETTLED' && transcript === null)
    fail('INVALID_TRANSCRIPT', 'SETTLED snapshot requires a transcript', '$.transcript');
  if (input.phase === 'SETTLED' && settlement === null)
    fail('INVALID_TICKET', 'SETTLED snapshot requires a settlement', '$.settlement');
  return Object.freeze({
    schema: PERMUTATION_SNAPSHOT_SCHEMA,
    moduleVersion: PERMUTATION_MODULE_VERSION,
    gameId: input.game.id,
    phase: input.phase,
    variantId: context.variantId,
    roundId: context.roundId,
    nonce: context.nonce,
    seedCommitment: assertDigest(input.seedCommitment, '$.seedCommitment'),
    playPolicyDigest: assertDigest(
      input.playPolicyDigest ?? permutationPlayPolicyDigest(input.game.play),
      '$.playPolicyDigest',
    ),
    transcript,
    ticket,
    settlement,
    receipt,
  });
}

function toWire(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (Array.isArray(value)) return value.map(toWire);
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toWire(child)]));
  return value;
}

function canonicalPrettyJson(value: unknown): string {
  return `${JSON.stringify(JSON.parse(stableJson(toWire(value))), null, 2)}\n`;
}

export function serializeRoundSnapshot(snapshot: RoundSnapshot): string {
  if (!isRecord(snapshot)) fail('INVALID_TRANSCRIPT', 'Snapshot must be a plain object', '$');
  assertExactKeys(snapshot, SNAPSHOT_KEYS, 'INVALID_TRANSCRIPT');
  const json = canonicalPrettyJson(snapshot);
  if (Buffer.byteLength(json, 'utf8') > PERMUTATION_LIMITS.maxSnapshotBytes)
    fail('INVALID_TRANSCRIPT', 'Serialised snapshot exceeds the byte limit', '$');
  return json;
}

function reviveMoney(node: unknown, path = '$'): unknown {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node))
    return Object.freeze(node.map((child, index) => reviveMoney(child, `${path}[${index}]`)));
  if (!isRecord(node)) return node;
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, raw] of Object.entries(node)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype')
      fail('INVALID_TRANSCRIPT', 'Dangerous snapshot key is forbidden', `${path}.${key}`);
    if (MONEY_FIELDS.has(key)) {
      if (typeof raw === 'bigint') output[key] = raw;
      else if (typeof raw === 'string' && /^-?\d+$/u.test(raw)) output[key] = BigInt(raw);
      else fail('INVALID_TICKET', `Money field ${key} must be an integer string`, `${path}.${key}`);
    } else output[key] = reviveMoney(raw, `${path}.${key}`);
  }
  return Object.freeze(output);
}

export function deserializeRoundSnapshot(input: unknown): RoundSnapshot {
  let value = input;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > PERMUTATION_LIMITS.maxSnapshotBytes)
      fail('INVALID_TRANSCRIPT', 'Serialised snapshot exceeds the byte limit', '$');
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      fail('INVALID_TRANSCRIPT', 'Snapshot is not valid JSON', '$');
    }
  }
  if (!isRecord(value)) fail('INVALID_TRANSCRIPT', 'Snapshot must be a plain object', '$');
  let objectBytes: number;
  try {
    objectBytes = Buffer.byteLength(canonicalPrettyJson(value), 'utf8');
  } catch {
    fail('INVALID_TRANSCRIPT', 'Snapshot cannot be canonically serialised', '$');
  }
  if (objectBytes > PERMUTATION_LIMITS.maxSnapshotBytes)
    fail('INVALID_TRANSCRIPT', 'Serialised snapshot exceeds the byte limit', '$');
  assertExactKeys(value, SNAPSHOT_KEYS, 'INVALID_TRANSCRIPT');
  if (value.schema !== PERMUTATION_SNAPSHOT_SCHEMA)
    fail('UNSUPPORTED_VERSION', 'Unknown snapshot schema', '$.schema');
  if (value.moduleVersion !== PERMUTATION_MODULE_VERSION)
    fail('UNSUPPORTED_VERSION', 'Unknown module version', '$.moduleVersion');
  if (typeof value.playPolicyDigest !== 'string')
    fail(
      'INVALID_TRANSCRIPT',
      'Snapshot must carry the play policy digest it ran under',
      '$.playPolicyDigest',
    );
  if (typeof value.gameId !== 'string')
    fail('INVALID_TRANSCRIPT', 'Snapshot gameId must be a string', '$.gameId');
  if (typeof value.phase !== 'string' || !PHASES.has(value.phase))
    fail('INVALID_TRANSCRIPT', 'Unknown round phase', '$.phase');
  const context = assertSeedContext({
    variantId: value.variantId,
    roundId: value.roundId,
    nonce: value.nonce,
  });
  const transcript = value.transcript === null ? null : deserializeTranscript(value.transcript);
  const ticket = reviveMoney(value.ticket, '$.ticket') as Ticket | null;
  const settlement = reviveMoney(value.settlement, '$.settlement') as Settlement | null;
  const receipt = reviveMoney(value.receipt, '$.receipt') as PermutationReceipt | null;
  if (value.phase !== 'COMMITTED' && (!isRecord(ticket) || !Array.isArray(ticket.lines)))
    fail('INVALID_TICKET', 'TICKETED and SETTLED snapshots require a ticket', '$.ticket');
  if (value.phase === 'SETTLED' && transcript === null)
    fail('INVALID_TRANSCRIPT', 'SETTLED snapshot requires a transcript', '$.transcript');
  if (value.phase === 'SETTLED' && !isRecord(settlement))
    fail('INVALID_TICKET', 'SETTLED snapshot requires a settlement', '$.settlement');
  return Object.freeze({
    schema: PERMUTATION_SNAPSHOT_SCHEMA,
    moduleVersion: PERMUTATION_MODULE_VERSION,
    gameId: value.gameId,
    phase: value.phase as RoundSnapshot['phase'],
    variantId: context.variantId,
    roundId: context.roundId,
    nonce: context.nonce,
    seedCommitment: assertDigest(value.seedCommitment, '$.seedCommitment'),
    playPolicyDigest: assertDigest(value.playPolicyDigest, '$.playPolicyDigest'),
    transcript,
    ticket,
    settlement,
    receipt,
  });
}
