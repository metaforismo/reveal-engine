export const ERROR_CODES = [
  'INVALID_ADAPTER',
  'INVALID_MODULE',
  'UNKNOWN_MODULE',
  'INVALID_RATIONAL',
  'INVALID_POSTERIOR',
  'INVALID_WEIGHTS',
  'INVALID_EVIDENCE',
  'INVALID_SEED',
  'INVALID_CONTEXT',
  'INVALID_TRANSCRIPT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_VERSION',
  'ADAPTER_MISMATCH',
  'DERIVATION_FAILED',
  'TRANSCRIPT_MISMATCH',
  'COMMITMENT_MISMATCH',
  'UNKNOWN_OUTCOME',
  'STALE_FRAME',
  'IDEMPOTENCY_CONFLICT',
  'OPEN_REJECTED',
  'SELL_REJECTED',
  'SETTLE_REJECTED',
  'ROUND_TERMINAL',
  'INVALID_SNAPSHOT',
] as const;

export type RevealEngineErrorCode = (typeof ERROR_CODES)[number];

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
