export {
  ACCEPTED_TRANSCRIPT_SCHEMAS,
  MAX_ITEMS,
  MAX_OPEN_BETS,
  MIN_ITEMS,
  PERMUTATION_ACTIONS,
  PERMUTATION_BET_CODES,
  PERMUTATION_BOOK_SCHEMA,
  PERMUTATION_MODULE_ID,
  PERMUTATION_MODULE_VERSION,
  PERMUTATION_TRANSCRIPT_SCHEMA,
  RETIRED_BOOK_SCHEMAS,
  type Item,
  type PermutationAction,
  type PermutationBet,
  type PermutationBetCode,
  type PermutationClaim,
  type PermutationDefinition,
  type PermutationOrder,
  type PermutationPaytable,
  type PermutationRoundBinding,
  type PermutationSettlement,
  type PermutationStep,
  type PermutationTranscript,
  type Position,
  type WirePermutationTranscript,
} from './contracts.js';
export {
  assertBet,
  betAssignments,
  betFromParameters,
  betParameters,
  betWins,
  claimSignature,
  enumerateInstances,
  enumerateOrders,
  type BetAssignment,
} from './bets.js';
export {
  definePermutationGame,
  permutationFingerprint,
  permutationIdentity,
} from './definition.js';
export { assertPermutationDefinition } from './validation.js';
/**
 * Proof-construction internals are deliberately narrow here.
 *
 * `permutationCommitmentBody` is exported because a module's declared encoders
 * and the body that composes them are one artefact, and a contract test rebuilds
 * the body out of the declarations to prove they have not drifted. A host should
 * still build proofs through `makePermutationTranscript` and check them through
 * `verifyPermutationTranscript`, never by re-implementing the layout.
 */
export {
  derivePermutationOrder,
  derivePermutationSteps,
  encodeOrder,
  encodeStep,
  makePermutationTranscript,
  ordersEqual,
  permutationCommitmentBody,
  permutationRound,
  stepsEqual,
  verifyPermutationTranscript,
} from './derivation.js';
export { fairMultiplier, freshProbability, itemBelief, linePayout, price } from './pricing.js';
export {
  deserializePermutationTranscript,
  permutationTranscriptToWire,
  serializePermutationTranscript,
} from './transcript.js';
export {
  PermutationBook,
  type PermutationBookSnapshot,
  type PlaceRequest,
  type SettleRequest,
  type WirePermutationClaim,
} from './round-book.js';
export { PERMUTATION_CHECKS, stakedSnapshotFor } from './checks.js';
export { permutation } from './module.js';
export type { PermutationShape } from './shape.js';
export {
  aetherOrderClassicReference,
  aetherOrderSevenReference,
  triadReference,
} from './references/index.js';
