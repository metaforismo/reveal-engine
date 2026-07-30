import { fail } from '../../../api/errors.js';
import { multiply, rational } from '../../../core/rational.js';
import { sha256Hex } from '../../../core/random.js';
import { constantTimeHexEqual, encodeFields } from '../../../internal/canonical.js';
import { assertExactKeys, assertSeedContext, isRecord, type SeedContext } from './context.js';
import {
  canonicalParams,
  findFamily,
  findInstance,
  permutationAdapterFingerprint,
  permutationClaimSignature,
  snapshotParams,
  type PermutationGameDefinition,
} from './definition.js';
import { assertPermutation, type PermutationTranscript } from './derivation.js';
import { outcomeViewOf, type BetFamily, type BetInstance } from './families.js';
import {
  IDEMPOTENCY_DOMAIN,
  PERMUTATION_LIMITS,
  PERMUTATION_MODULE_VERSION,
  PERMUTATION_TICKET_SCHEMA,
  SETTLEMENT_DIGEST_DOMAIN,
  TICKET_DIGEST_DOMAIN,
} from './identity.js';

export interface TicketLine {
  readonly code: string;
  readonly params: Readonly<object>;
  readonly stake: bigint;
}

export interface Ticket {
  readonly schema: typeof PERMUTATION_TICKET_SCHEMA;
  readonly moduleVersion: typeof PERMUTATION_MODULE_VERSION;
  readonly gameId: string;
  readonly adapterVersion: string;
  readonly adapterFingerprint: string;
  readonly variantId: string;
  readonly roundId: string;
  readonly nonce: number;
  readonly lines: readonly TicketLine[];
  readonly totalStake: bigint;
  readonly ticketDigest: string;
  readonly idempotencyKey: string;
}

export interface SettledLine extends TicketLine {
  readonly won: boolean;
  readonly gross: bigint;
}

export interface Settlement {
  readonly lines: readonly SettledLine[];
  readonly totalStake: bigint;
  readonly gross: bigint;
  readonly credited: bigint;
  readonly capped: boolean;
  readonly net: bigint;
}

interface NormalizedLine extends TicketLine {
  readonly family: BetFamily;
  readonly instance: BetInstance;
}

interface NormalizedTicket {
  readonly lines: readonly NormalizedLine[];
  readonly totalStake: bigint;
}

const RAW_TICKET_KEYS = Object.freeze(['lines']);
const LINE_KEYS = Object.freeze(['code', 'params', 'stake']);
const OPEN_TICKET_KEYS = Object.freeze([
  'schema',
  'moduleVersion',
  'gameId',
  'adapterVersion',
  'adapterFingerprint',
  'variantId',
  'roundId',
  'nonce',
  'lines',
  'totalStake',
  'ticketDigest',
  'idempotencyKey',
]);

function normalizeTicket(
  game: PermutationGameDefinition,
  ticket: unknown,
  acceptOpened: boolean,
): NormalizedTicket {
  if (!isRecord(ticket) || !Array.isArray(ticket.lines))
    fail('INVALID_TICKET', 'Ticket must be a plain object carrying lines', '$.lines');
  const opened = 'schema' in ticket;
  assertExactKeys(
    ticket,
    opened && acceptOpened ? OPEN_TICKET_KEYS : RAW_TICKET_KEYS,
    'INVALID_TICKET',
  );
  const inputLines = Array.prototype.slice.call(ticket.lines) as unknown[];
  if (inputLines.length === 0)
    fail('INVALID_TICKET', 'Ticket must carry at least one line', '$.lines');
  if (
    inputLines.length > game.risk.maxLinesPerTicket ||
    inputLines.length > PERMUTATION_LIMITS.maxLinesPerTicket
  )
    fail('INVALID_TICKET', 'Ticket exceeds the published line limit', '$.lines');

  let totalStake = 0n;
  const claims = new Set<string>();
  const lines = inputLines.map((value, index): NormalizedLine => {
    const path = `$.lines[${index}]`;
    if (!isRecord(value)) fail('INVALID_TICKET', 'Ticket line must be a plain object', path);
    assertExactKeys(value, LINE_KEYS, 'INVALID_TICKET', path);
    const family = findFamily(game, value.code, `${path}.code`);
    if (typeof value.stake !== 'bigint')
      fail('INVALID_TICKET', 'Stake must be a BigInt minor-unit amount', `${path}.stake`);
    const stake = value.stake;
    if (stake < game.risk.minLineStake || stake > game.risk.maxLineStake)
      fail('INVALID_TICKET', 'Line stake is outside the published bounds', `${path}.stake`);
    if (stake % game.pricing.stakeQuantum !== 0n)
      fail('INVALID_TICKET', 'Line stake is not a multiple of stakeQuantum', `${path}.stake`);
    const instance = findInstance(game, family, value.params, `${path}.params`);
    const signature = permutationClaimSignature(game, family.code, instance);
    if (game.risk.requireDistinctLines && claims.has(signature))
      fail('DUPLICATE_LINE', 'Ticket repeats the same behavioral claim', path);
    claims.add(signature);
    totalStake += stake;
    return Object.freeze({
      code: family.code,
      params: instance.params,
      stake,
      family,
      instance,
    });
  });
  if (totalStake > game.risk.maxTicketStake)
    fail('INVALID_TICKET', 'Ticket exceeds the total stake limit', '$.lines');
  return Object.freeze({ lines: Object.freeze(lines), totalStake });
}

function canonicalLineOrder<T extends TicketLine>(lines: readonly T[]): readonly T[] {
  return Object.freeze(
    [...lines].sort((left, right) => {
      if (left.code !== right.code) return left.code < right.code ? -1 : 1;
      const leftParams = canonicalParams(left.params);
      const rightParams = canonicalParams(right.params);
      return leftParams < rightParams ? -1 : leftParams > rightParams ? 1 : 0;
    }),
  );
}

function digestForNormalized(
  game: PermutationGameDefinition,
  context: SeedContext,
  ticket: NormalizedTicket,
): string {
  const ordered = canonicalLineOrder(ticket.lines);
  const fields: (string | Uint8Array | bigint | number)[] = [
    TICKET_DIGEST_DOMAIN,
    PERMUTATION_TICKET_SCHEMA,
    PERMUTATION_MODULE_VERSION,
    game.id,
    game.adapterVersion,
    permutationAdapterFingerprint(game),
    game.variantId,
    context.roundId,
    context.nonce,
    ordered.length,
  ];
  for (const line of ordered) fields.push(line.code, canonicalParams(line.params), line.stake);
  fields.push(ticket.totalStake);
  return sha256Hex(encodeFields(fields));
}

export function ticketDigestForReceipt(
  identity: {
    gameId: string;
    adapterVersion: string;
    adapterFingerprint: string;
    variantId: string;
    roundId: string;
    nonce: number;
  },
  ticket: unknown,
): string {
  if (!isRecord(ticket) || !Array.isArray(ticket.lines))
    fail('INVALID_TICKET', 'Ticket must carry a lines array', '$.ticket');
  const ordered = canonicalLineOrder(Array.prototype.slice.call(ticket.lines));
  const fields: (string | Uint8Array | bigint | number)[] = [
    TICKET_DIGEST_DOMAIN,
    PERMUTATION_TICKET_SCHEMA,
    PERMUTATION_MODULE_VERSION,
    identity.gameId,
    identity.adapterVersion,
    identity.adapterFingerprint,
    identity.variantId,
    identity.roundId,
    identity.nonce,
    ordered.length,
  ];
  let totalStake = 0n;
  for (let index = 0; index < ordered.length; index += 1) {
    const line = ordered[index] as TicketLine;
    if (!isRecord(line) || typeof line.code !== 'string' || typeof line.stake !== 'bigint')
      fail('INVALID_TICKET', 'Ticket line is malformed', `$.lines[${index}]`);
    const params = snapshotParams(line.params, `$.lines[${index}].params`);
    fields.push(line.code, canonicalParams(params), line.stake);
    totalStake += line.stake;
  }
  fields.push(totalStake);
  return sha256Hex(encodeFields(fields));
}

export function ticketDigestFromTicket(ticket: Ticket): string {
  return ticketDigestForReceipt(
    {
      gameId: ticket.gameId,
      adapterVersion: ticket.adapterVersion,
      adapterFingerprint: ticket.adapterFingerprint,
      variantId: ticket.variantId,
      roundId: ticket.roundId,
      nonce: ticket.nonce,
    },
    ticket,
  );
}

export function ticketDigest(
  game: PermutationGameDefinition,
  context: SeedContext,
  ticket: unknown,
): string {
  const ctx = assertSeedContext(context);
  if (ctx.variantId !== game.variantId)
    fail('ADAPTER_MISMATCH', 'Ticket context belongs to another variant', '$.variantId');
  return digestForNormalized(game, ctx, normalizeTicket(game, ticket, true));
}

export function idempotencyKeyFor(action: 'open' | 'settle', ticketDigestValue: string): string {
  if (action !== 'open' && action !== 'settle')
    fail('IDEMPOTENCY_CONFLICT', 'Unknown idempotency action', '$.action');
  if (typeof ticketDigestValue !== 'string' || !/^[0-9a-f]{64}$/u.test(ticketDigestValue))
    fail('IDEMPOTENCY_CONFLICT', 'Ticket digest is malformed', '$.ticketDigest');
  return sha256Hex(
    encodeFields([
      IDEMPOTENCY_DOMAIN,
      PERMUTATION_MODULE_VERSION,
      'aether-order',
      action,
      ticketDigestValue,
    ]),
  );
}

export function openTicket(
  game: PermutationGameDefinition,
  context: SeedContext,
  ticket: unknown,
): Ticket {
  const ctx = assertSeedContext(context);
  if (ctx.variantId !== game.variantId)
    fail('ADAPTER_MISMATCH', 'Ticket context belongs to another variant', '$.variantId');
  const normalized = normalizeTicket(game, ticket, false);
  const digest = digestForNormalized(game, ctx, normalized);
  return Object.freeze({
    schema: PERMUTATION_TICKET_SCHEMA,
    moduleVersion: PERMUTATION_MODULE_VERSION,
    gameId: game.id,
    adapterVersion: game.adapterVersion,
    adapterFingerprint: permutationAdapterFingerprint(game),
    variantId: game.variantId,
    roundId: ctx.roundId,
    nonce: ctx.nonce,
    lines: Object.freeze(
      canonicalLineOrder(normalized.lines).map((line) =>
        Object.freeze({ code: line.code, params: line.params, stake: line.stake }),
      ),
    ),
    totalStake: normalized.totalStake,
    ticketDigest: digest,
    idempotencyKey: idempotencyKeyFor('open', digest),
  });
}

function assertOpenedTicket(
  game: PermutationGameDefinition,
  transcript: PermutationTranscript,
  ticket: Ticket,
): NormalizedTicket {
  const normalized = normalizeTicket(game, ticket, true);
  if (
    ticket.schema !== PERMUTATION_TICKET_SCHEMA ||
    ticket.moduleVersion !== PERMUTATION_MODULE_VERSION
  )
    fail('UNSUPPORTED_VERSION', 'Unknown ticket schema or module version', '$.schema');
  if (
    ticket.gameId !== game.id ||
    ticket.adapterVersion !== game.adapterVersion ||
    !constantTimeHexEqual(ticket.adapterFingerprint, permutationAdapterFingerprint(game)) ||
    !constantTimeHexEqual(ticket.adapterFingerprint, transcript.adapterFingerprint) ||
    ticket.variantId !== game.variantId ||
    ticket.roundId !== transcript.roundId ||
    ticket.nonce !== transcript.nonce
  )
    fail('TRANSCRIPT_MISMATCH', 'Ticket does not belong to this transcript', '$.roundId');
  const recomputed = digestForNormalized(
    game,
    { variantId: game.variantId, roundId: ticket.roundId, nonce: ticket.nonce },
    normalized,
  );
  if (!constantTimeHexEqual(recomputed, ticket.ticketDigest))
    fail('TRANSCRIPT_MISMATCH', 'Ticket digest does not bind its lines', '$.ticketDigest');
  if (ticket.totalStake !== normalized.totalStake)
    fail('TRANSCRIPT_MISMATCH', 'Ticket total does not match its lines', '$.totalStake');
  if (ticket.idempotencyKey !== idempotencyKeyFor('open', recomputed))
    fail(
      'IDEMPOTENCY_CONFLICT',
      'Ticket carries an idempotency key for another intent',
      '$.idempotencyKey',
    );
  return normalized;
}

export function exactPayout(
  stake: bigint,
  multiplier: { numerator: bigint; denominator: bigint },
  path = '$',
): bigint {
  const product = multiply(rational(stake), multiplier);
  if (product.denominator !== 1n)
    fail('INEXACT_PAYOUT', 'Payout is not an integer minor-unit amount', path);
  if (product.numerator < 0n) fail('INVALID_TICKET', 'Payout must not be negative', path);
  return product.numerator;
}

export function settleTicket(
  game: PermutationGameDefinition,
  transcript: PermutationTranscript,
  ticket: Ticket,
): Settlement {
  if (!isRecord(transcript))
    fail('INVALID_TRANSCRIPT', 'Settlement requires a transcript', '$.transcript');
  if (
    transcript.gameId !== game.id ||
    transcript.variantId !== game.variantId ||
    transcript.adapterVersion !== game.adapterVersion ||
    !constantTimeHexEqual(transcript.adapterFingerprint, permutationAdapterFingerprint(game))
  )
    fail('ADAPTER_MISMATCH', 'Transcript belongs to another adapter', '$.transcript');
  const permutation = assertPermutation(transcript.permutation, game.n, '$.transcript.permutation');
  const normalized = assertOpenedTicket(game, transcript, ticket);
  const view = outcomeViewOf(permutation, game.n);
  let gross = 0n;
  const lines = canonicalLineOrder(normalized.lines).map((line, index) => {
    const won = line.family.resolve(line.instance, view) === true;
    const multiplier = game.pricing.multipliers[line.code];
    if (!multiplier)
      fail('INVALID_ADAPTER', 'Bet family has no multiplier', `$.pricing.${line.code}`);
    const lineGross = won ? exactPayout(line.stake, multiplier, `$.lines[${index}].gross`) : 0n;
    gross += lineGross;
    return Object.freeze({
      code: line.code,
      params: line.params,
      stake: line.stake,
      won,
      gross: lineGross,
    });
  });
  const ceiling = normalized.totalStake * game.risk.maxWinMultiple;
  const credited = gross > ceiling ? ceiling : gross;
  if (gross < 0n || credited < 0n)
    fail('INVALID_TICKET', 'Settlement credits must not be negative', '$.credited');
  return Object.freeze({
    lines: Object.freeze(lines),
    totalStake: normalized.totalStake,
    gross,
    credited,
    capped: gross > ceiling,
    net: credited - normalized.totalStake,
  });
}

export function settlementDigest(game: PermutationGameDefinition, settlement: Settlement): string {
  return settlementDigestFor(game.id, game.variantId, settlement);
}

export function settlementDigestFor(
  gameId: string,
  variantId: string,
  settlement: Settlement,
): string {
  if (!isRecord(settlement) || !Array.isArray(settlement.lines))
    fail('INVALID_TICKET', 'Settlement must carry a lines array', '$.settlement.lines');
  const moneyFields = ['totalStake', 'gross', 'credited', 'net'] as const;
  for (const field of moneyFields)
    if (typeof settlement[field] !== 'bigint')
      fail('INVALID_TICKET', 'Settlement money fields must be BigInts', `$.${field}`);
  if (typeof settlement.capped !== 'boolean')
    fail('INVALID_TICKET', 'Settlement capped flag must be boolean', '$.capped');
  if (
    settlement.totalStake < 0n ||
    settlement.gross < 0n ||
    settlement.credited < 0n ||
    settlement.credited > settlement.gross ||
    settlement.net !== settlement.credited - settlement.totalStake ||
    settlement.capped !== settlement.credited < settlement.gross
  )
    fail('INVALID_TICKET', 'Settlement money fields are inconsistent', '$.settlement');
  const ordered = canonicalLineOrder(Array.prototype.slice.call(settlement.lines));
  let summedStake = 0n;
  let summedGross = 0n;
  const fields: (string | Uint8Array | bigint | number)[] = [
    SETTLEMENT_DIGEST_DOMAIN,
    PERMUTATION_MODULE_VERSION,
    gameId,
    variantId,
    settlement.totalStake,
    settlement.gross,
    settlement.credited,
    settlement.capped ? 1 : 0,
    settlement.net,
    ordered.length,
  ];
  for (let index = 0; index < ordered.length; index += 1) {
    const line = ordered[index] as SettledLine;
    if (!isRecord(line))
      fail('INVALID_TICKET', 'Settlement line must be a plain object', `$.lines[${index}]`);
    snapshotParams(line.params, `$.lines[${index}].params`);
    if (
      typeof line.code !== 'string' ||
      typeof line.stake !== 'bigint' ||
      typeof line.won !== 'boolean' ||
      typeof line.gross !== 'bigint'
    )
      fail('INVALID_TICKET', 'Settlement line is malformed', `$.lines[${index}]`);
    if (line.stake < 0n || line.gross < 0n)
      fail('INVALID_TICKET', 'Settlement line money must not be negative', `$.lines[${index}]`);
    summedStake += line.stake;
    summedGross += line.gross;
    fields.push(line.code, canonicalParams(line.params), line.stake, line.won ? 1 : 0, line.gross);
  }
  if (summedStake !== settlement.totalStake || summedGross !== settlement.gross)
    fail('INVALID_TICKET', 'Settlement totals do not match their lines', '$.settlement');
  return sha256Hex(encodeFields(fields));
}
