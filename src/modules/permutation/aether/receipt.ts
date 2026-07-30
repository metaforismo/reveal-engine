import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { fail, RevealEngineError, type PermutationErrorCode } from '../../../api/errors.js';
import { normalizeSeed, sha256Hex } from '../../../core/random.js';
import { constantTimeHexEqual, encodeFields } from '../../../internal/canonical.js';
import { isRecord } from './context.js';
import type { PermutationTranscript } from './derivation.js';
import {
  PERMUTATION_LIMITS,
  PERMUTATION_MODULE_VERSION,
  PERMUTATION_RECEIPT_SCHEMA,
  RECEIPT_DOMAIN,
} from './identity.js';
import {
  settlementDigestFor,
  ticketDigestForReceipt,
  ticketDigestFromTicket,
  type Settlement,
  type Ticket,
} from './ticket.js';

export interface PermutationReceipt {
  readonly schema: typeof PERMUTATION_RECEIPT_SCHEMA;
  readonly moduleVersion: typeof PERMUTATION_MODULE_VERSION;
  readonly gameId: string;
  readonly adapterVersion: string;
  readonly adapterFingerprint: string;
  readonly variantId: string;
  readonly roundId: string;
  readonly nonce: number;
  readonly seedCommitment: string;
  readonly commitment: string;
  readonly ticketDigest: string;
  readonly settlementDigest: string;
  readonly totalStake: bigint;
  readonly credited: bigint;
  readonly signerId: string;
  readonly digest: string;
  readonly signature: string | null;
}

export type ReceiptVerificationResult =
  | {
      readonly ok: true;
      readonly digest: string;
      readonly signatureChecked: true;
      readonly signatureValid: true;
      readonly bindingsVerified: true;
    }
  | {
      readonly ok: false;
      readonly code: 'SIGNATURE_UNCHECKED';
      readonly message: string;
      readonly path: string;
      readonly digest: string;
      readonly signatureChecked: false;
      readonly signatureValid: null;
      readonly bindingsVerified: true;
    }
  | {
      readonly ok: false;
      readonly code: PermutationErrorCode;
      readonly message: string;
      readonly path: string;
      readonly signatureChecked: boolean;
      readonly signatureValid: boolean | null;
      readonly bindingsVerified: boolean;
    };

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const RECEIPT_KEYS = Object.freeze([
  'schema',
  'moduleVersion',
  'gameId',
  'adapterVersion',
  'adapterFingerprint',
  'variantId',
  'roundId',
  'nonce',
  'seedCommitment',
  'commitment',
  'ticketDigest',
  'settlementDigest',
  'totalStake',
  'credited',
  'signerId',
  'digest',
  'signature',
]);

function digestHex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

export function receiptCoreBytes(
  receipt: Omit<PermutationReceipt, 'digest' | 'signature'> | PermutationReceipt,
): Buffer {
  return encodeFields([
    RECEIPT_DOMAIN,
    PERMUTATION_RECEIPT_SCHEMA,
    PERMUTATION_MODULE_VERSION,
    receipt.gameId,
    receipt.adapterVersion,
    receipt.adapterFingerprint,
    receipt.variantId,
    receipt.roundId,
    receipt.nonce,
    receipt.seedCommitment,
    receipt.commitment,
    receipt.ticketDigest,
    receipt.settlementDigest,
    receipt.totalStake,
    receipt.credited,
    receipt.signerId,
  ]);
}

function assertSignerId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > PERMUTATION_LIMITS.maxSignerIdBytes ||
    !/^[\x20-\x7e]+$/u.test(value)
  )
    fail('INVALID_CONTEXT', 'Signer id must be bounded printable ASCII', '$.signerId');
  return value;
}

export function makeReceipt(input: {
  transcript: PermutationTranscript;
  ticket: unknown;
  settlement: Settlement;
  signerId: string;
}): PermutationReceipt {
  const { transcript, settlement } = input;
  if (!isRecord(transcript))
    fail('INVALID_TRANSCRIPT', 'Receipt requires a transcript', '$.transcript');
  if (!isRecord(input.ticket))
    fail('INVALID_TICKET', 'Receipt requires an opened ticket', '$.ticket');
  const ticket = input.ticket as unknown as Ticket;
  if (
    ticket.gameId !== transcript.gameId ||
    ticket.variantId !== transcript.variantId ||
    ticket.roundId !== transcript.roundId ||
    ticket.nonce !== transcript.nonce
  )
    fail('TRANSCRIPT_MISMATCH', 'Ticket does not belong to the transcript', '$.ticket.roundId');
  if (!digestHex(transcript.seedCommitment) || !digestHex(transcript.commitment))
    fail('INVALID_TRANSCRIPT', 'Transcript commitments are malformed', '$.transcript');
  const computedTicketDigest = ticketDigestFromTicket(ticket);
  if (
    !digestHex(ticket.ticketDigest) ||
    !constantTimeHexEqual(computedTicketDigest, ticket.ticketDigest)
  )
    fail('TRANSCRIPT_MISMATCH', 'Ticket digest does not bind its lines', '$.ticket.ticketDigest');
  const computedSettlementDigest = settlementDigestFor(
    transcript.gameId,
    transcript.variantId,
    settlement,
  );
  if (ticket.totalStake !== settlement.totalStake)
    fail(
      'TRANSCRIPT_MISMATCH',
      'Settlement total does not match the ticket',
      '$.settlement.totalStake',
    );

  const core = {
    schema: PERMUTATION_RECEIPT_SCHEMA,
    moduleVersion: PERMUTATION_MODULE_VERSION,
    gameId: transcript.gameId,
    adapterVersion: transcript.adapterVersion,
    adapterFingerprint: transcript.adapterFingerprint,
    variantId: transcript.variantId,
    roundId: transcript.roundId,
    nonce: transcript.nonce,
    seedCommitment: transcript.seedCommitment,
    commitment: transcript.commitment,
    ticketDigest: computedTicketDigest,
    settlementDigest: computedSettlementDigest,
    totalStake: settlement.totalStake,
    credited: settlement.credited,
    signerId: assertSignerId(input.signerId),
  };
  return Object.freeze({
    ...core,
    digest: sha256Hex(receiptCoreBytes(core)),
    signature: null,
  });
}

export function signReceipt(
  receipt: PermutationReceipt,
  privateKey: KeyObject,
): PermutationReceipt {
  const signature = cryptoSign(null, receiptCoreBytes(receipt), privateKey).toString('hex');
  return Object.freeze({ ...receipt, signature });
}

function rejected(
  code: PermutationErrorCode,
  message: string,
  path: string,
  extra: Partial<{
    digest: string;
    signatureChecked: boolean;
    signatureValid: boolean | null;
    bindingsVerified: boolean;
  }> = {},
): ReceiptVerificationResult {
  return Object.freeze({
    ok: false,
    code,
    message,
    path,
    signatureChecked: false,
    signatureValid: null,
    bindingsVerified: false,
    ...extra,
  }) as ReceiptVerificationResult;
}

export function verifyReceipt(
  receipt: unknown,
  context: {
    transcript: PermutationTranscript;
    ticket: unknown;
    settlement: Settlement;
    publicKey?: KeyObject;
  },
): ReceiptVerificationResult {
  try {
    if (!isRecord(receipt))
      return rejected('INVALID_TICKET', 'Receipt must be a plain object', '$');
    const keys = Object.keys(receipt).sort();
    const expected = [...RECEIPT_KEYS].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
      return rejected('INVALID_TICKET', 'Receipt carries an unknown or missing field', '$');
    if (receipt.schema !== PERMUTATION_RECEIPT_SCHEMA)
      return rejected('UNSUPPORTED_VERSION', 'Unknown receipt schema', '$.schema');
    if (receipt.moduleVersion !== PERMUTATION_MODULE_VERSION)
      return rejected('UNSUPPORTED_VERSION', 'Unknown module version', '$.moduleVersion');
    const transcript = context?.transcript;
    if (!isRecord(transcript))
      return rejected(
        'INVALID_TRANSCRIPT',
        'Receipt verification requires a transcript',
        '$.transcript',
      );
    if (
      receipt.gameId !== transcript.gameId ||
      receipt.adapterVersion !== transcript.adapterVersion ||
      receipt.variantId !== transcript.variantId
    )
      return rejected('ADAPTER_MISMATCH', 'Receipt belongs to another adapter', '$.adapterVersion');
    if (
      typeof receipt.adapterFingerprint !== 'string' ||
      typeof transcript.adapterFingerprint !== 'string' ||
      !constantTimeHexEqual(receipt.adapterFingerprint, transcript.adapterFingerprint)
    )
      return rejected(
        'ADAPTER_MISMATCH',
        'Receipt adapter fingerprint does not match the transcript',
        '$.adapterFingerprint',
      );
    if (receipt.roundId !== transcript.roundId || receipt.nonce !== transcript.nonce)
      return rejected('TRANSCRIPT_MISMATCH', 'Receipt does not describe this round', '$.roundId');
    if (
      typeof receipt.seedCommitment !== 'string' ||
      typeof transcript.seedCommitment !== 'string' ||
      !constantTimeHexEqual(receipt.seedCommitment, transcript.seedCommitment)
    )
      return rejected(
        'COMMITMENT_MISMATCH',
        'Receipt seed commitment does not match the transcript',
        '$.seedCommitment',
      );
    if (
      typeof receipt.commitment !== 'string' ||
      typeof transcript.commitment !== 'string' ||
      !constantTimeHexEqual(receipt.commitment, transcript.commitment)
    )
      return rejected(
        'COMMITMENT_MISMATCH',
        'Receipt commitment does not match the transcript',
        '$.commitment',
      );
    const recomputedTicketDigest = ticketDigestForReceipt(
      {
        gameId: transcript.gameId,
        adapterVersion: transcript.adapterVersion,
        adapterFingerprint: transcript.adapterFingerprint,
        variantId: transcript.variantId,
        roundId: transcript.roundId,
        nonce: transcript.nonce,
      },
      context.ticket,
    );
    if (
      typeof receipt.ticketDigest !== 'string' ||
      !constantTimeHexEqual(recomputedTicketDigest, receipt.ticketDigest)
    )
      return rejected(
        'TRANSCRIPT_MISMATCH',
        'Receipt does not bind the supplied ticket',
        '$.ticketDigest',
      );
    let recomputedSettlementDigest: string;
    try {
      recomputedSettlementDigest = settlementDigestFor(
        transcript.gameId,
        transcript.variantId,
        context.settlement,
      );
    } catch {
      return rejected(
        'TRANSCRIPT_MISMATCH',
        'Receipt does not bind the supplied settlement',
        '$.settlementDigest',
      );
    }
    if (
      typeof receipt.settlementDigest !== 'string' ||
      !constantTimeHexEqual(recomputedSettlementDigest, receipt.settlementDigest)
    )
      return rejected(
        'TRANSCRIPT_MISMATCH',
        'Receipt does not bind the supplied settlement',
        '$.settlementDigest',
      );
    if (
      receipt.totalStake !== context.settlement.totalStake ||
      receipt.credited !== context.settlement.credited
    )
      return rejected(
        'TRANSCRIPT_MISMATCH',
        'Receipt money fields disagree with the settlement',
        '$.credited',
      );
    if (
      typeof receipt.signerId !== 'string' ||
      typeof receipt.totalStake !== 'bigint' ||
      typeof receipt.credited !== 'bigint'
    )
      return rejected('INVALID_TICKET', 'Receipt core fields are malformed', '$');
    const recomputedDigest = sha256Hex(receiptCoreBytes(receipt as unknown as PermutationReceipt));
    if (
      typeof receipt.digest !== 'string' ||
      !constantTimeHexEqual(recomputedDigest, receipt.digest)
    )
      return rejected(
        'COMMITMENT_MISMATCH',
        'Receipt digest does not cover its fields',
        '$.digest',
      );
    if (context.publicKey === undefined)
      return rejected(
        'SIGNATURE_UNCHECKED',
        'Bindings are intact but no operator key was supplied',
        '$.signature',
        { digest: recomputedDigest, bindingsVerified: true },
      );
    if (typeof receipt.signature !== 'string' || !/^[0-9a-f]{128}$/u.test(receipt.signature))
      return rejected('INVALID_TICKET', 'Receipt signature is malformed', '$.signature', {
        bindingsVerified: true,
      });
    const valid = cryptoVerify(
      null,
      receiptCoreBytes(receipt as unknown as PermutationReceipt),
      context.publicKey,
      Buffer.from(receipt.signature, 'hex'),
    );
    if (!valid)
      return rejected('COMMITMENT_MISMATCH', 'Receipt signature does not verify', '$.signature', {
        signatureChecked: true,
        signatureValid: false,
        bindingsVerified: true,
      });
    return Object.freeze({
      ok: true,
      digest: recomputedDigest,
      signatureChecked: true,
      signatureValid: true,
      bindingsVerified: true,
    });
  } catch (error) {
    if (error instanceof RevealEngineError)
      return rejected(error.code as PermutationErrorCode, error.message, error.path);
    return rejected('INVALID_TICKET', 'Receipt verification failed', '$');
  }
}

/** Deterministic RFC 8032 fixture helper; production keys come from operator custody. */
export function ed25519KeyPairFromSeed(seedHex: string): Readonly<{
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyHex: string;
}> {
  const seed = normalizeSeed(seedHex);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return Object.freeze({
    privateKey,
    publicKey,
    publicKeyHex: Buffer.from(spki.subarray(spki.length - 32)).toString('hex'),
  });
}
