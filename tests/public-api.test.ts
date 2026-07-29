import { describe, expect, it } from 'vitest';
import * as root from '../src/index.js';
import * as api from '../src/api/index.js';
import * as core from '../src/core/index.js';
import * as modules from '../src/modules/index.js';
import * as progressiveMarket from '../src/modules/progressive-market/index.js';
import * as sequentialCards from '../src/modules/sequential-cards/index.js';
import * as conformance from '../src/conformance/index.js';
import * as integration from '../src/integration/index.js';
import * as protocol from '../src/protocol/index.js';
import * as reference from '../src/reference/index.js';
import * as serialization from '../src/serialization/index.js';

describe('stable public API snapshot', () => {
  it('exports the approved root surface and no internal canonical encoder', () => {
    expect(Object.keys(root).sort()).toEqual([
      'COMMITMENT_VERSION',
      'ENGINE_API_VERSION',
      'ENGINE_LIMITS',
      'ERROR_CODES',
      'LEGACY_COMMITMENT_VERSION',
      'MODULE_API_VERSION',
      'RevealEngineError',
      'RoundBook',
      'adapterFingerprint',
      'add',
      'assertAdapterConforms',
      'assertModuleConformance',
      'binaryBeaconReference',
      'blackSignalReference',
      'checkAdapterConformance',
      'checkModuleConformance',
      'compare',
      'constellationReference',
      'defineGame',
      'defineLifecycleModule',
      'deriveMaxContinuations',
      'deriveTruth',
      'deserializeTranscript',
      'divide',
      'equal',
      'fairValue',
      'fairValueClaim',
      'findModule',
      'floor',
      'initialPosterior',
      'listModules',
      'makeTranscript',
      'multiply',
      'payable',
      'payableWithinCap',
      'posteriorFor',
      'probability',
      'progressiveMarket',
      'quote',
      'rational',
      'requireModule',
      'serializeTranscript',
      'subtract',
      'transcriptToWire',
      'updatePosterior',
      'verifyTranscript',
      'verifyTranscriptDetailed',
    ]);
    expect('encodeFields' in root).toBe(false);
    expect('canonicalTranscriptBytes' in root).toBe(false);
    expect('commitment' in root).toBe(false);
  });

  it('keeps versions and limits on the API subpath', () => {
    expect(api.ENGINE_API_VERSION).toBe('reveal-engine/api-v1');
    expect(api.MODULE_API_VERSION).toBe('reveal-engine/module-v1');
    expect(api.COMMITMENT_VERSION).toBe('reveal-engine/commit-v2');
    expect(api.ENGINE_LIMITS.maxEvidenceEvents).toBe(10_000);
    expect(Object.keys(api).sort()).toEqual([
      'COMMITMENT_VERSION',
      'ENGINE_API_VERSION',
      'ENGINE_LIMITS',
      'ERROR_CODES',
      'LEGACY_COMMITMENT_VERSION',
      'MODULE_API_VERSION',
      'RevealEngineError',
    ]);
  });

  it('keeps core game-agnostic: no adapter, posterior, transcript, or book symbols', () => {
    expect(Object.keys(core).sort()).toEqual([
      'COMMITMENT_VERSION',
      'CommandLedger',
      'ENGINE_API_VERSION',
      'LEGACY_COMMITMENT_VERSION',
      'MODULE_API_VERSION',
      'RECEIPT_SCHEMA',
      'RECEIPT_WIRE_KEYS',
      'RandomTape',
      'add',
      'assertBoundedBigInt',
      'assertClaimBudget',
      'assertIdempotencyKey',
      'assertIdentifier',
      'assertLoggedChoices',
      'assertNonNegativeBigInt',
      'assertProofVersion',
      'assertRational',
      'assertSamplerScope',
      'assertSnapshotKeys',
      'assertSnapshotRecord',
      'assertSnapshotRevision',
      'assertSnapshotSize',
      'assertWireHex',
      'assertWireString',
      'classifyVerificationError',
      'commandFingerprint',
      'compare',
      'constantTimeHexEqual',
      'countingProbability',
      'defineLifecycleModule',
      'deriveMaxContinuations',
      'divide',
      'equal',
      'factorial',
      'fallingFactorial',
      'floor',
      'fromWireRational',
      'fromWireReceipt',
      'multiply',
      'normalizeSeed',
      'parseSnapshotJson',
      'parseWireBigInt',
      'parseWireSignedBigInt',
      'payable',
      'payableWithinCap',
      'rational',
      'reduceWeights',
      'samplerScopeOf',
      'scaleWeights',
      'sealCommitment',
      'sealLegacyCommitment',
      'sealSeedCommitment',
      'sha256Hex',
      'snapshotHash',
      'stableJson',
      'subtract',
      'toWireRational',
      'toWireReceipt',
      'uniform',
      'uniformBigInt',
      'uniformPermutation',
      'verificationFailure',
      'verificationSuccess',
      'weightGcd',
      'weightProbability',
      'weightVector',
    ]);
    for (const banned of [
      'defineGame',
      'adapterFingerprint',
      'makeTranscript',
      'deriveTruth',
      'posteriorFor',
      'quote',
      'RoundBook',
      'serializeTranscript',
      'commitment',
      'canonicalTranscriptBytes',
      'encodeFields',
      'CONTRACT_VERSION',
    ])
      expect(banned in core).toBe(false);
  });

  it('exposes the module registry and the progressive-market module surface', () => {
    expect(Object.keys(modules).sort()).toEqual([
      'findModule',
      'listModules',
      'progressiveMarket',
      'requireModule',
      'sequentialCards',
    ]);
    expect(modules.listModules().map((module) => module.id)).toEqual([
      'progressive-market',
      'sequential-cards',
    ]);
    expect(modules.requireModule('progressive-market').version).toBe('1.0.0');
    expect(modules.requireModule('sequential-cards').version).toBe('1.0.0');
    expect(() => modules.requireModule('staged-survival')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_MODULE' }),
    );
    expect(Object.keys(progressiveMarket).sort()).toEqual([
      'ACCEPTED_TRANSCRIPT_SCHEMAS',
      'ADAPTER_CONFORMANCE_SCHEMA',
      'COMMITMENT_VERSION',
      'ENGINE_API_VERSION',
      'LEGACY_COMMITMENT_VERSION',
      'LEGACY_TRANSCRIPT_SCHEMA',
      'PROGRESSIVE_MARKET_CHECKS',
      'PROGRESSIVE_MARKET_MODULE_ID',
      'PROGRESSIVE_MARKET_MODULE_VERSION',
      'ROUND_ACTIONS',
      'ROUND_BOOK_SCHEMA',
      'RoundBook',
      'TRANSCRIPT_SCHEMA',
      'adapterFingerprint',
      'adapterIdentity',
      'assertAdapterConforms',
      'assertContext',
      'assertDerivedEvidence',
      'assertEvidenceEvent',
      'assertGameDefinition',
      'assertPosterior',
      'assertPosteriorForGame',
      'binaryBeaconReference',
      'blackSignalReference',
      'checkAdapterConformance',
      'constellationReference',
      'defineGame',
      'deriveTruth',
      'deserializeTranscript',
      'evidenceEqual',
      'fairValue',
      'fairValueClaim',
      'initialPosterior',
      'makeTranscript',
      'posteriorFor',
      'posteriorWeights',
      'probability',
      'progressiveMarket',
      'quote',
      'roundContext',
      'roundIdentityOf',
      'scopeOf',
      'serializeTranscript',
      'transcriptToWire',
      'uniform',
      'uniformBigInt',
      'updatePosterior',
      'verifyTranscript',
      'verifyTranscriptDetailed',
    ]);
    for (const banned of ['commitment', 'canonicalTranscriptBytes', 'legacyCommitment'])
      expect(banned in progressiveMarket).toBe(false);
  });

  /**
   * A second module's surface is a contract too.
   *
   * The root barrel deliberately does **not** re-export it: the engine is not a
   * game, and `progressive-market` is only at the root because hosts written
   * against 0.2 import it from there. A sequential-cards host reaches it through
   * `requireModule('sequential-cards')` or the `./modules/sequential-cards`
   * subpath, and nothing else.
   */
  it('exposes the sequential-cards module surface without widening the root', () => {
    expect(Object.keys(sequentialCards).sort()).toEqual([
      'ACCEPTED_CARDS_TRANSCRIPT_SCHEMAS',
      'CARDS_ACTIONS',
      'CARDS_BOOK_SCHEMA',
      'CARDS_MAX_ANALYSIS_CELLS',
      'CARDS_MAX_ANALYSIS_OPS',
      'CARDS_MAX_DEALT',
      'CARDS_MAX_ENUMERATED_TRUTHS',
      'CARDS_MAX_OPEN_CLAIMS',
      'CARDS_MAX_SIDE_MARKETS',
      'CARDS_MAX_STEPS',
      'CARDS_MAX_SUPPORT',
      'CARDS_REJECTION_REASONS',
      'CARDS_TRANSCRIPT_SCHEMA',
      'COMMITMENT_VERSION',
      'CardsBook',
      'ENGINE_API_VERSION',
      'SEQUENTIAL_CARDS_CHECKS',
      'SEQUENTIAL_CARDS_MODULE_ID',
      'SEQUENTIAL_CARDS_MODULE_VERSION',
      'SEQUENTIAL_CARDS_REFERENCES',
      'analyseDefinition',
      'assertCardsDefinition',
      'assertDeal',
      'assertPlayerChoices',
      'assertRevealSteps',
      'assertTicketComposition',
      'buildCardsTranscript',
      'cardsBelief',
      'cardsBeliefVector',
      'cardsChoicesOf',
      'cardsFingerprint',
      'cardsIdentity',
      'cardsRoundOf',
      'cardsSeedCommitment',
      'cardsTranscriptToWire',
      'cascadeMiddleReference',
      'claimProbability',
      'combinationCount',
      'composeRoundSeed',
      'coverProbability',
      'dealEqual',
      'defineCardsGame',
      'deriveDeal',
      'deriveRanks',
      'deriveRevealSteps',
      'deriveSelectors',
      'deserializeCardsTranscript',
      'duoMiddleReference',
      'eligiblePositions',
      'eligibleSetSize',
      'encodeDeal',
      'encodePlayerChoice',
      'encodeRevealStep',
      'entryClaim',
      'entryMultiplier',
      'enumerateDeals',
      'enumerateSelectorTuples',
      'estimateAnalysisWork',
      'fairValue',
      'forEachCanonicalState',
      'freezeCardsDefinition',
      'isReachableObjectiveRank',
      'isTerminalCover',
      'liquidationFactor',
      'livePositions',
      'objectiveIndex',
      'objectivePositionOf',
      'objectiveRankOf',
      'offeredActions',
      'openFingerprint',
      'reachableObjectiveRanks',
      'revealRecordOf',
      'revealStepsEqual',
      'sequentialCards',
      'serializeCardsTranscript',
      'settlementTotal',
      'stakedCardsSnapshot',
      'stepDigest',
      'ticketRowFields',
      'transformedClaim',
      'triadMiddleReference',
      'verifyCardsTranscript',
    ]);
    for (const banned of ['cardsCommitmentBody', 'sealCommitment', 'encodeFields'])
      expect(banned in sequentialCards).toBe(false);
    for (const leaked of [
      'CardsBook',
      'sequentialCards',
      'defineCardsGame',
      'triadMiddleReference',
    ])
      expect(leaked in root).toBe(false);
  });

  it('keeps every remaining package subpath explicit', () => {
    expect(Object.keys(conformance).sort()).toEqual([
      'MODULE_CONFORMANCE_SCHEMA',
      'assertAdapterConforms',
      'assertModuleConformance',
      'checkAdapterConformance',
      'checkModuleConformance',
      'conformanceSeed',
    ]);
    expect(Object.keys(integration)).toEqual(['RgsExample']);
    expect(Object.keys(protocol)).toEqual(['RoundBook']);
    expect(Object.keys(serialization).sort()).toEqual([
      'deserializeTranscript',
      'serializeTranscript',
      'transcriptToWire',
    ]);
    expect(Object.keys(reference).sort()).toEqual([
      'binaryBeaconReference',
      'blackSignalReference',
      'constellationReference',
    ]);
  });

  it('keeps deprecated aliases pointing at the relocated module implementation', () => {
    expect(protocol.RoundBook).toBe(progressiveMarket.RoundBook);
    expect(serialization.serializeTranscript).toBe(progressiveMarket.serializeTranscript);
    expect(reference.blackSignalReference).toBe(progressiveMarket.blackSignalReference);
  });
});
