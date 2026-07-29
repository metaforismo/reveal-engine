/**
 * Game-agnostic codes. Core and the lifecycle-module contract raise only these.
 *
 * A module with no adapter, posterior, or evidence reports a definition mismatch
 * as `DEFINITION_MISMATCH` and a refused claim as `CLAIM_REJECTED`.
 */
export const CORE_ERROR_CODES = [
  'INVALID_MODULE',
  'UNKNOWN_MODULE',
  'DEFINITION_MISMATCH',
  'INVALID_RATIONAL',
  'INVALID_WEIGHTS',
  'INVALID_SEED',
  'INVALID_CONTEXT',
  'INVALID_CHOICE',
  'INVALID_TRANSCRIPT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_VERSION',
  'DERIVATION_FAILED',
  'TRANSCRIPT_MISMATCH',
  'COMMITMENT_MISMATCH',
  'UNKNOWN_OUTCOME',
  'STALE_FRAME',
  'IDEMPOTENCY_CONFLICT',
  'CLAIM_REJECTED',
  'ROUND_TERMINAL',
  'INVALID_SNAPSHOT',
] as const;

/**
 * Progressive-market vocabulary, wire-visible to existing hosts.
 *
 * `INVALID_ADAPTER` additionally remains the fallback code for a malformed
 * lifecycle definition, because that is what every shipped consumer branches on.
 * New modules should prefer the core codes above.
 */
export const MODULE_ERROR_CODES = [
  'INVALID_ADAPTER',
  'ADAPTER_MISMATCH',
  'INVALID_POSTERIOR',
  'INVALID_EVIDENCE',
  'OPEN_REJECTED',
  'SELL_REJECTED',
  'SETTLE_REJECTED',
] as const;

/**
 * Permutation-ticket and receipt vocabulary from the AETHER ORDER contract.
 *
 * These are kept separate from the existing lifecycle-module vocabulary so a
 * protocol reader can tell which public contract introduced each wire code.
 */
export const PERMUTATION_ERROR_CODES = [
  'INVALID_TICKET',
  'UNKNOWN_BET',
  'UNKNOWN_INSTANCE',
  'DUPLICATE_LINE',
  'INEXACT_PAYOUT',
  'SIGNATURE_UNCHECKED',
  'CYCLE_FLOOR',
  'BETTING_CLOSED',
] as const;

export const ERROR_CODES = Object.freeze([
  ...CORE_ERROR_CODES,
  ...MODULE_ERROR_CODES,
  ...PERMUTATION_ERROR_CODES,
] as const);

export type RevealEngineErrorCode = (typeof ERROR_CODES)[number];
export type PermutationErrorCode =
  | (typeof PERMUTATION_ERROR_CODES)[number]
  | 'INVALID_ADAPTER'
  | 'INVALID_SEED'
  | 'INVALID_CONTEXT'
  | 'INVALID_TRANSCRIPT'
  | 'UNSUPPORTED_VERSION'
  | 'ADAPTER_MISMATCH'
  | 'TRANSCRIPT_MISMATCH'
  | 'COMMITMENT_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT';

/** Stable runtime failure with a machine-readable code and input path. */
export class RevealEngineError extends Error {
  readonly name = 'RevealEngineError';
  constructor(
    readonly code: RevealEngineErrorCode,
    message: string,
    readonly path = '$',
    readonly details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message);
  }
}

export function fail(
  code: RevealEngineErrorCode,
  message: string,
  path = '$',
  details?: Readonly<Record<string, string | number | boolean>>,
): never {
  throw new RevealEngineError(code, message, path, details);
}

export function asRevealEngineError(
  error: unknown,
  fallback: RevealEngineErrorCode,
  message: string,
): RevealEngineError {
  return error instanceof RevealEngineError
    ? error
    : new RevealEngineError(fallback, message, '$', {
        cause: error instanceof Error ? error.message : String(error),
      });
}
