export {
  COMMITMENT_VERSION,
  ENGINE_API_VERSION,
  LEGACY_COMMITMENT_VERSION,
  STAGED_SURVIVAL_MODULE_ID,
  STAGED_SURVIVAL_MODULE_VERSION,
  SURVIVAL_ACTIONS,
  SURVIVAL_BOOK_SCHEMA,
  SURVIVAL_LIMITS,
  TRANSCRIPT_SCHEMA,
  type CommitmentVersion,
  type LaneProfile,
  type RoundRef,
  type StageContract,
  type SurvivalAction,
  type SurvivalChoice,
  type SurvivalClaimRef,
  type SurvivalDefinition,
  type SurvivalDraw,
  type SurvivalLane,
  type SurvivalPricing,
  type SurvivalRisk,
  type SurvivalStep,
  type SurvivalTranscript,
  type SurvivalTruth,
} from './contracts.js';
export {
  defineSurvivalGame,
  definitionFields,
  survivalFingerprint,
  survivalIdentity,
} from './adapter.js';
/**
 * `MAX_ROUND_ID_BYTES` and `ROUND_REF_SEPARATOR` are part of the subpath because
 * ADR 0008 promises them. The round pair rides inside the contract's single
 * `roundId: string`, which costs the operator half some of its width; the ADR's
 * stated mitigation is that a host can *check* the remaining budget rather than
 * discover it from a rejected round. That mitigation is only real if the number
 * and the separator it is computed against are importable.
 */
export {
  MAX_ROUND_ID_BYTES,
  ROUND_REF_SEPARATOR,
  assertCapIsUnreachable,
  assertClientEntropy,
  assertOperatorRoundId,
  assertRoundRef,
  assertSurvivalChoice,
  assertSurvivalDefinition,
  contractFor,
  contractMenu,
  marginalSurvival,
  maxRoundReturn,
  parseRoundRefId,
  roundRefId,
} from './validation.js';
export {
  binomial,
  distributionTotal,
  expectedSurvivors,
  expectedSurvivorsFromDistribution,
  laneSizes,
  lanePartition,
  laneSurvivorDistribution,
  survivorDistribution,
} from './distribution.js';
/**
 * Proof-construction internals (`commitmentBody`, `encodeStep`, `encodeTruth`)
 * are deliberately absent from this subpath. A host builds a proof through
 * `makeTranscript` and checks one through the module's `verify`, never by
 * re-implementing the commitment body.
 */
export {
  belief,
  deriveSteps,
  deriveTruth,
  liveAfter,
  makeTranscript,
  price,
  resolveStage,
  roundIdentityOf,
  seedCommitment,
  stepsEqual,
  choicesEqual,
  threshold,
  type StageResolution,
} from './fairness.js';
export {
  ACCEPTED_TRANSCRIPT_SCHEMAS,
  deserializeTranscript,
  serializeTranscript,
  transcriptToWire,
} from './transcript.js';
export { SurvivalBook, type SurvivalClaim } from './book.js';
export { STAGED_SURVIVAL_CHECKS, stakedSnapshotFor, type StakedSnapshot } from './checks.js';
export { stagedSurvival } from './module.js';
export type { StagedSurvivalShape } from './shape.js';
export { fiveRunnerReference, oracleTrialReference } from './references/index.js';
