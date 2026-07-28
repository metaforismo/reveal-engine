export const COMPATIBILITY_CORPUS_VERSION = 'reveal-engine/compatibility-corpus-v1' as const;
export const COMPATIBILITY_REPORT_VERSION = 'reveal-engine/compatibility-report-v1' as const;

export type CompatibilityField =
  | 'truth'
  | 'evidence'
  | 'commitment'
  | 'posterior'
  | 'liquidation'
  | 'winning-settlement'
  | 'max-win-cap'
  | 'continuation'
  | 'ride-lifecycle';

export type CompatibilityExpectation = 'exact' | 'expected-migration-delta' | 'host-managed';

export type CompatibilityReason =
  | 'none'
  | 'legacy-truth-derivation'
  | 'legacy-evidence-derivation'
  | 'proof-version-upgrade'
  | 'early-payable-rounding'
  | 'host-managed-continuation';

export interface CompatibilityPolicy {
  readonly field: CompatibilityField;
  readonly expectation: CompatibilityExpectation;
  readonly reason: CompatibilityReason;
  readonly allowedDeltaCents?: { readonly min: string; readonly max: string };
}

export interface CompatibilityWireRational {
  readonly numerator: string;
  readonly denominator: string;
}

export interface CompatibilityEvidenceEvent {
  readonly index: number;
  readonly target: number;
  readonly favour: string;
  readonly other: string;
  readonly label: string;
}

export interface CompatibilityEconomicCase {
  readonly caseId: string;
  readonly entryFrame: number;
  readonly exitFrame: number;
  readonly outcome: number;
  readonly stakeCents: string;
  readonly hostSellCents: string;
  readonly targetSellCents: string;
  readonly hostWinningSettlementCents: string;
  readonly targetWinningSettlementCents: string;
}

export interface CompatibilityVector {
  readonly vectorId: string;
  readonly seed: string;
  readonly roundId: string;
  readonly host: {
    readonly truth: number;
    readonly evidence: readonly CompatibilityEvidenceEvent[];
    readonly commitment: string;
    readonly posteriorCheckpoints: readonly {
      readonly frame: number;
      readonly weights: readonly string[];
    }[];
  };
  readonly target: {
    readonly truth: number;
    readonly evidenceSha256: string;
    readonly commitment: string;
  };
  readonly economics: readonly CompatibilityEconomicCase[];
}

export interface CompatibilityCapCase {
  readonly caseId: string;
  readonly theoretical: CompatibilityWireRational;
  readonly originalStakeCents: string;
  readonly maxWinMultiple: string;
  readonly alreadyLiquidCents: string;
  readonly expectedCreditedCents: string;
  readonly expectedCapped: boolean;
}

export interface CompatibilityCorpusV1 {
  readonly schema: typeof COMPATIBILITY_CORPUS_VERSION;
  readonly corpusId: string;
  readonly source: {
    readonly repository: string;
    readonly branch: string;
    readonly revision: string;
    readonly revisionDate: string;
    readonly observedDirtyState: readonly string[];
    readonly files: readonly { readonly path: string; readonly sha256: string }[];
    readonly generator: { readonly name: string; readonly version: string };
  };
  readonly target: {
    readonly engineApiVersion: string;
    readonly packageVersion: string;
    readonly adapterId: string;
    readonly adapterVersion: string;
    readonly adapterFingerprint: string;
    readonly proofVersion: string;
    readonly transcriptSchema: string;
  };
  readonly hostContracts: {
    readonly truth: {
      readonly algorithm: 'hmac-sha256-uint64-rejection-v1';
      readonly domainTemplate: string;
    };
    readonly evidence: { readonly algorithm: 'frozen-events-v1' };
    readonly commitment: {
      readonly algorithm: 'sha256-seed-pipe-round-truth-targets-v1';
    };
    readonly pricing: {
      readonly algorithm: 'fixed-point-early-floor-v1';
      readonly scale: string;
    };
    readonly continuation: { readonly ownership: 'host' };
  };
  readonly contract: {
    readonly outcomes: readonly string[];
    readonly priorWeights: readonly string[];
    readonly firstEntryRtp: CompatibilityWireRational;
    readonly liquidationSpread: CompatibilityWireRational;
    readonly rounding: 'floor';
    readonly maxWinMultiple: string;
    readonly continuation: {
      readonly maxRides: number;
      readonly rtpFloor: CompatibilityWireRational;
    };
  };
  readonly policies: readonly CompatibilityPolicy[];
  readonly sampling: {
    readonly seedCount: number;
    readonly seedDerivation: 'counter-as-32-byte-big-endian-hex';
    readonly roundIdTemplate: 'audit-{index}';
    readonly posteriorFrames: readonly number[];
    readonly entryFrames: readonly number[];
    readonly exitFrames: readonly number[];
    readonly outcomes: readonly number[];
    readonly stakesCents: readonly string[];
    readonly economicCaseCount: number;
  };
  readonly observed: {
    readonly truthMatches: number;
    readonly evidenceScheduleMatches: number;
    readonly sellExactMatches: number;
    readonly sellExpectedDeltas: number;
    readonly settlementExactMatches: number;
    readonly settlementExpectedDeltas: number;
    readonly maxSellDeltaCents: string;
    readonly maxSettlementDeltaCents: string;
  };
  readonly vectors: readonly CompatibilityVector[];
  readonly capCases: readonly CompatibilityCapCase[];
  readonly integrity: {
    readonly algorithm: 'sha256-canonical-json-v1';
    readonly sha256: string;
  };
}

export type CompatibilityClassification =
  'exact' | 'expected-migration-delta' | 'host-managed' | 'unexpected-delta' | 'target-drift';

export interface CompatibilityFinding {
  readonly field: CompatibilityField;
  readonly classification: CompatibilityClassification;
  readonly reason: CompatibilityReason;
  readonly vectorId?: string;
  readonly caseId?: string;
  readonly hostValue: string;
  readonly targetValue: string;
  readonly deltaCents?: string;
  readonly message: string;
}

export interface CompatibilityReportV1 {
  readonly schema: typeof COMPATIBILITY_REPORT_VERSION;
  readonly corpusId: string;
  readonly corpusSha256: string;
  readonly target: CompatibilityCorpusV1['target'];
  readonly ok: boolean;
  readonly activationReady: boolean;
  readonly checked: {
    readonly vectors: number;
    readonly posteriorCheckpoints: number;
    readonly economicCases: number;
    readonly capCases: number;
  };
  readonly classifications: Readonly<Record<CompatibilityClassification, number>>;
  readonly observed: CompatibilityCorpusV1['observed'];
  readonly findings: readonly CompatibilityFinding[];
}
