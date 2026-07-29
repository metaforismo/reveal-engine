import { RevealEngineError, asRevealEngineError } from '../api/errors.js';
import type { CommitmentVersion } from './versions.js';

export interface VerificationSuccess {
  readonly ok: true;
  readonly proofVersion: CommitmentVersion;
  readonly commitment: string;
}

export interface VerificationFailure {
  readonly ok: false;
  readonly code:
    | 'INVALID_TRANSCRIPT'
    | 'UNSUPPORTED_VERSION'
    | 'ADAPTER_MISMATCH'
    | 'DERIVATION_FAILED'
    | 'TRANSCRIPT_MISMATCH'
    | 'COMMITMENT_MISMATCH';
  readonly message: string;
  readonly path: string;
}

export type VerificationResult = VerificationSuccess | VerificationFailure;

export function verificationSuccess(
  proofVersion: CommitmentVersion,
  commitment: string,
): VerificationSuccess {
  return Object.freeze({ ok: true, proofVersion, commitment });
}

export function verificationFailure(
  code: VerificationFailure['code'],
  message: string,
  path: string,
): VerificationFailure {
  return Object.freeze({ ok: false, code, message, path });
}

/**
 * Maps an unexpected throw to the public verification taxonomy.
 *
 * A verifier must never leak an incidental parser, crypto, or adapter exception
 * to a caller who only asked "is this proof valid?". Every lifecycle module
 * routes its catch block through here so the taxonomy stays identical.
 */
export function classifyVerificationError(error: unknown): VerificationFailure {
  const failure =
    error instanceof RevealEngineError
      ? error
      : asRevealEngineError(error, 'INVALID_TRANSCRIPT', 'Transcript verification failed');
  const code: VerificationFailure['code'] =
    failure.code === 'UNSUPPORTED_VERSION'
      ? 'UNSUPPORTED_VERSION'
      : failure.code === 'ADAPTER_MISMATCH'
        ? 'ADAPTER_MISMATCH'
        : failure.code === 'DERIVATION_FAILED' || failure.code === 'INVALID_ADAPTER'
          ? 'DERIVATION_FAILED'
          : 'INVALID_TRANSCRIPT';
  return verificationFailure(code, failure.message, failure.path);
}
