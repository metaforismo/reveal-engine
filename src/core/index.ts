/**
 * Reveal Engine core: everything a lifecycle module must not reimplement.
 *
 * Nothing here knows what a game is. Truth models, step semantics, books, and
 * transcripts live in `src/modules/*` and are wired through the contract in
 * `./module.js`.
 */

export {
  COMMITMENT_VERSION,
  ENGINE_API_VERSION,
  LEGACY_COMMITMENT_VERSION,
  MODULE_API_VERSION,
  type CommitmentVersion,
} from './versions.js';

export {
  add,
  compare,
  divide,
  equal,
  floor,
  multiply,
  rational,
  subtract,
  type Rational,
} from './rational.js';

export {
  reduceWeights,
  scaleWeights,
  weightGcd,
  weightProbability,
  weightVector,
  type WeightVector,
} from './weights.js';

export { countingProbability, factorial, fallingFactorial } from './combinatorics.js';

export { payable, payableWithinCap, type Payable } from './payments.js';
export { deriveMaxContinuations } from './continuation.js';

export {
  RandomTape,
  assertSamplerScope,
  normalizeSeed,
  sha256Hex,
  uniform,
  uniformBigInt,
  uniformPermutation,
  type SamplerScope,
  type TapeDraw,
} from './random.js';

export {
  constantTimeHexEqual,
  sealCommitment,
  sealLegacyCommitment,
  sealSeedCommitment,
  type SeedCommitmentBinding,
} from './commitment.js';

export {
  classifyVerificationError,
  verificationFailure,
  verificationSuccess,
  type VerificationFailure,
  type VerificationResult,
  type VerificationSuccess,
} from './verification.js';

export {
  CommandLedger,
  RECEIPT_SCHEMA,
  RECEIPT_WIRE_KEYS,
  assertIdempotencyKey,
  commandFingerprint,
  fromWireReceipt,
  toWireReceipt,
  type CommandLedgerOptions,
  type Receipt,
  type StakeFunding,
  type StoredReceipt,
  type WireReceipt,
} from './ledger.js';

export {
  assertSnapshotKeys,
  assertSnapshotRecord,
  assertSnapshotRevision,
  assertSnapshotSize,
  assertWireHex,
  assertWireString,
  fromWireRational,
  parseSnapshotJson,
  parseWireBigInt,
  parseWireSignedBigInt,
  snapshotHash,
  stableJson,
  toWireRational,
  type WireRational,
} from './snapshot.js';

export {
  assertBoundedBigInt,
  assertIdentifier,
  assertNonNegativeBigInt,
  assertProofVersion,
  assertRational,
} from './validation.js';

export {
  assertClaimBudget,
  assertLoggedChoices,
  defineLifecycleModule,
  samplerScopeOf,
  type BeliefSpace,
  type BookModel,
  type BookPositions,
  type ChoiceTiming,
  type ClaimSettlement,
  type ConformanceFailure,
  type ConformanceModel,
  type ConformanceReference,
  type DefinitionIdentity,
  type DefinitionModel,
  type LifecycleModule,
  type LifecycleShape,
  type ModuleConformanceCheck,
  type ModuleConformanceContext,
  type RoundIdentity,
  type StepModel,
  type TranscriptModel,
  type TruthKind,
  type TruthModel,
} from './module.js';
