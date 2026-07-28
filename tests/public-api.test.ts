import { describe, expect, it } from 'vitest';
import * as root from '../src/index.js';
import * as api from '../src/api/index.js';
import * as core from '../src/core/index.js';
import * as conformance from '../src/conformance/index.js';
import * as compatibility from '../src/compatibility/index.js';
import * as integration from '../src/integration/index.js';
import * as protocol from '../src/protocol/index.js';
import * as reference from '../src/reference/index.js';
import * as serialization from '../src/serialization/index.js';

describe('stable public API snapshot', () => {
  it('exports the approved root surface and no internal canonical encoder', () => {
    expect(Object.keys(root).sort()).toEqual([
      'COMMITMENT_VERSION',
      'COMPATIBILITY_CORPUS_VERSION',
      'COMPATIBILITY_REPORT_VERSION',
      'ENGINE_API_VERSION',
      'ENGINE_LIMITS',
      'ERROR_CODES',
      'LEGACY_COMMITMENT_VERSION',
      'RevealEngineError',
      'RoundBook',
      'adapterFingerprint',
      'add',
      'assertAdapterConforms',
      'binaryBeaconReference',
      'blackSignalReference',
      'checkAdapterConformance',
      'compare',
      'compareCompatibilityCorpus',
      'compatibilityCorpusDigest',
      'compatibilityEvidenceDigest',
      'constellationReference',
      'defineGame',
      'deriveMaxContinuations',
      'deriveTruth',
      'deserializeTranscript',
      'divide',
      'equal',
      'fairValue',
      'fairValueClaim',
      'floor',
      'initialPosterior',
      'makeTranscript',
      'multiply',
      'parseCompatibilityCorpus',
      'payable',
      'payableWithinCap',
      'posteriorFor',
      'probability',
      'quote',
      'rational',
      'serializeTranscript',
      'subtract',
      'transcriptToWire',
      'updatePosterior',
      'verifyTranscript',
      'verifyTranscriptDetailed',
    ]);
    expect('encodeFields' in root).toBe(false);
    expect('canonicalTranscriptBytes' in root).toBe(false);
  });

  it('keeps versions and limits on the API subpath', () => {
    expect(api.ENGINE_API_VERSION).toBe('reveal-engine/api-v1');
    expect(api.COMMITMENT_VERSION).toBe('reveal-engine/commit-v2');
    expect(api.ENGINE_LIMITS.maxEvidenceEvents).toBe(10_000);
  });

  it('keeps every package subpath explicit and excludes proof-construction internals', () => {
    expect(Object.keys(core).sort()).toEqual([
      'COMMITMENT_VERSION',
      'ENGINE_API_VERSION',
      'LEGACY_COMMITMENT_VERSION',
      'adapterFingerprint',
      'add',
      'assertBoundedBigInt',
      'assertContext',
      'assertDerivedEvidence',
      'assertEvidenceEvent',
      'assertGameDefinition',
      'assertPosterior',
      'assertPosteriorForGame',
      'assertRational',
      'compare',
      'defineGame',
      'deriveMaxContinuations',
      'deriveTruth',
      'divide',
      'equal',
      'fairValue',
      'fairValueClaim',
      'floor',
      'initialPosterior',
      'makeTranscript',
      'multiply',
      'normalizeSeed',
      'payable',
      'payableWithinCap',
      'posteriorFor',
      'probability',
      'quote',
      'rational',
      'subtract',
      'uniform',
      'uniformBigInt',
      'updatePosterior',
      'verifyTranscript',
      'verifyTranscriptDetailed',
    ]);
    expect(Object.keys(protocol)).toEqual(['RoundBook']);
    expect(Object.keys(serialization).sort()).toEqual([
      'deserializeTranscript',
      'serializeTranscript',
      'transcriptToWire',
    ]);
    expect(Object.keys(conformance).sort()).toEqual([
      'assertAdapterConforms',
      'checkAdapterConformance',
    ]);
    expect(Object.keys(compatibility).sort()).toEqual([
      'COMPATIBILITY_CORPUS_VERSION',
      'COMPATIBILITY_REPORT_VERSION',
      'compareCompatibilityCorpus',
      'compatibilityCorpusDigest',
      'compatibilityEvidenceDigest',
      'parseCompatibilityCorpus',
    ]);
    expect(Object.keys(integration)).toEqual(['RgsExample']);
    expect(Object.keys(reference).sort()).toEqual([
      'binaryBeaconReference',
      'blackSignalReference',
      'constellationReference',
    ]);
    expect('commitment' in core).toBe(false);
    expect('canonicalTranscriptBytes' in core).toBe(false);
    expect('CONTRACT_VERSION' in core).toBe(false);
  });
});
