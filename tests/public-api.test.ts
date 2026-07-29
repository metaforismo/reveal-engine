import { describe, expect, it } from 'vitest';
import * as root from '../src/index.js';
import * as api from '../src/api/index.js';
import * as core from '../src/core/index.js';
import * as modules from '../src/modules/index.js';
import * as progressiveMarket from '../src/modules/progressive-market/index.js';
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
      'assertExactKeys',
      'assertIdempotencyKey',
      'assertIdentifier',
      'assertNonNegativeBigInt',
      'assertProofVersion',
      'assertRational',
      'assertRecord',
      'assertRevision',
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
      'defineLifecycleModule',
      'deriveMaxContinuations',
      'divide',
      'equal',
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
    ]);
    expect(modules.listModules().map((module) => module.id)).toEqual(['progressive-market']);
    expect(modules.requireModule('progressive-market').version).toBe('1.0.0');
    expect(() => modules.requireModule('sequential-cards')).toThrowError(
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
