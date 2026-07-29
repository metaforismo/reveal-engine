/**
 * Public surface of the sequential-cards lifecycle module.
 *
 * Proof-construction internals are deliberately absent from every package
 * subpath, exactly as they are for `progressive-market`: a host builds proofs
 * through `buildCardsTranscript` and checks them through `verifyCardsTranscript`,
 * never by re-implementing the commitment body.
 */
export {
  CARDS_ACTIONS,
  CARDS_BOOK_SCHEMA,
  CARDS_REJECTION_REASONS,
  CARDS_TRANSCRIPT_SCHEMA,
  COMMITMENT_VERSION,
  ENGINE_API_VERSION,
  SEQUENTIAL_CARDS_MODULE_ID,
  SEQUENTIAL_CARDS_MODULE_VERSION,
  type BackingSpec,
  type CardsAction,
  type CardsClaim,
  type CardsObjective,
  type CardsPricingPolicy,
  type CardsRejectionReason,
  type CardsRiskPolicy,
  type CardsRounding,
  type CardsSeedPolicy,
  type CardsTranscript,
  type CommitmentVersion,
  type Deal,
  type LadderSpec,
  type PlayerChoice,
  type RevealSpec,
  type RevealStep,
  type SequentialCardsDefinition,
  type SideMarket,
  type TicketSpec,
} from './contracts.js';

export {
  cardsFingerprint,
  cardsIdentity,
  cardsRoundOf,
  defineCardsGame,
  freezeCardsDefinition,
} from './adapter.js';

export {
  assertCardsDefinition,
  assertDeal,
  assertPlayerChoices,
  assertRevealSteps,
  eligibleSetSize,
  CARDS_MAX_DEALT,
  CARDS_MAX_OPEN_CLAIMS,
  CARDS_MAX_SIDE_MARKETS,
  CARDS_MAX_STEPS,
} from './validation.js';

export {
  CARDS_MAX_SUPPORT,
  cardsBelief,
  cardsBeliefVector,
  claimProbability,
  combinationCount,
  isReachableObjectiveRank,
  objectiveIndex,
  objectivePositionOf,
  objectiveRankOf,
  reachableObjectiveRanks,
  revealRecordOf,
  type CardsBelief,
  type CardsRevealRecord,
} from './deck.js';

export {
  CARDS_MAX_ENUMERATED_TRUTHS,
  composeRoundSeed,
  dealEqual,
  deriveDeal,
  deriveRanks,
  deriveSelectors,
  encodeDeal,
  enumerateDeals,
  enumerateSelectorTuples,
  type RoundSeedInput,
} from './truth.js';

export {
  deriveRevealSteps,
  eligiblePositions,
  encodePlayerChoice,
  encodeRevealStep,
  revealStepsEqual,
  stepDigest,
} from './steps.js';

export {
  coverProbability,
  entryClaim,
  entryMultiplier,
  fairValue,
  isTerminalCover,
  liquidationFactor,
  livePositions,
  offeredActions,
  transformedClaim,
  type CardsOfferedAction,
  type OfferContext,
} from './pricing.js';

export {
  CARDS_MAX_ANALYSIS_CELLS,
  CARDS_MAX_ANALYSIS_OPS,
  analyseDefinition,
  estimateAnalysisWork,
  forEachCanonicalState,
  type CardsAnalysis,
} from './analysis.js';

export {
  ACCEPTED_CARDS_TRANSCRIPT_SCHEMAS,
  buildCardsTranscript,
  cardsChoicesOf,
  cardsSeedCommitment,
  cardsTranscriptToWire,
  deserializeCardsTranscript,
  serializeCardsTranscript,
  verifyCardsTranscript,
  type WireCardsTranscript,
} from './transcript.js';

export {
  CardsBook,
  assertTicketComposition,
  openFingerprint,
  settlementTotal,
  ticketRowFields,
  type CardsBookSnapshot,
  type CardsDecision,
  type CardsReceipt,
  type CardsSelection,
  type CardsSelectionStatus,
  type CardsSettlementRecord,
  type CashRequest,
  type OpenRequest,
  type RevealRequest,
  type SettleRequest,
  type TicketSelection,
  type TransformRequest,
  type WireCardsSelection,
} from './round-book.js';

export { SEQUENTIAL_CARDS_CHECKS, stakedCardsSnapshot } from './checks.js';

export {
  SEQUENTIAL_CARDS_REFERENCES,
  cascadeMiddleReference,
  duoMiddleReference,
  triadMiddleReference,
} from './references.js';

export { sequentialCards } from './module.js';
export type { SequentialCardsShape } from './shape.js';
