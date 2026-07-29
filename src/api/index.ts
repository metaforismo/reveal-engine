/** Stable, game-agnostic surface: versions, limits, and the typed failure taxonomy. */
export { RevealEngineError, ERROR_CODES, type RevealEngineErrorCode } from './errors.js';
export { ENGINE_LIMITS } from './limits.js';
export {
  ENGINE_API_VERSION,
  MODULE_API_VERSION,
  COMMITMENT_VERSION,
  LEGACY_COMMITMENT_VERSION,
  type CommitmentVersion,
} from '../core/versions.js';
export type { Payable } from '../core/payments.js';
export type {
  VerificationFailure,
  VerificationResult,
  VerificationSuccess,
} from '../core/verification.js';
export type {
  BookModel,
  ConformanceFailure,
  DefinitionIdentity,
  DefinitionModel,
  LifecycleModule,
  LifecycleShape,
  RoundIdentity,
  StepModel,
  TranscriptModel,
  TruthModel,
} from '../core/module.js';
