import { adapterFingerprint } from '../core/adapter.js';
import {
  COMMITMENT_VERSION,
  ENGINE_API_VERSION,
  type EvidenceEvent,
  type GameDefinition,
} from '../core/contracts.js';
import { makeTranscript } from '../core/fairness.js';
import { payableWithinCap } from '../core/payments.js';
import { fairValueClaim, posteriorFor, quote } from '../core/posterior.js';
import { floor, multiply, rational } from '../core/rational.js';
import { fail } from '../api/errors.js';
import {
  COMPATIBILITY_REPORT_VERSION,
  type CompatibilityClassification,
  type CompatibilityCorpusV1,
  type CompatibilityField,
  type CompatibilityFinding,
  type CompatibilityPolicy,
  type CompatibilityReportV1,
} from './contracts.js';
import {
  compatibilityCorpusDigest,
  compatibilityEvidenceDigest,
  parseCompatibilityCorpus,
} from './corpus.js';

function evidenceFromWire(
  evidence: CompatibilityCorpusV1['vectors'][number]['host']['evidence'],
): readonly EvidenceEvent[] {
  return Object.freeze(
    evidence.map((event) =>
      Object.freeze({
        index: event.index,
        target: event.target,
        favour: BigInt(event.favour),
        other: BigInt(event.other),
        label: event.label,
      }),
    ),
  );
}

function targetEvidenceWire(evidence: readonly EvidenceEvent[]) {
  return evidence.map((event) => ({
    index: event.index,
    target: event.target,
    favour: event.favour.toString(10),
    other: event.other.toString(10),
    label: event.label,
  }));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

class ReportBuilder {
  readonly findings: CompatibilityFinding[] = [];
  readonly counts: Record<CompatibilityClassification, number> = {
    exact: 0,
    'expected-migration-delta': 0,
    'host-managed': 0,
    'unexpected-delta': 0,
    'target-drift': 0,
  };

  constructor(readonly policies: ReadonlyMap<CompatibilityField, CompatibilityPolicy>) {}

  string(
    field: CompatibilityField,
    hostValue: string,
    targetValue: string,
    context: { readonly vectorId?: string; readonly caseId?: string; readonly message: string },
  ): void {
    const policy = this.policy(field);
    if (hostValue === targetValue) {
      this.counts.exact += 1;
      return;
    }
    const classification =
      policy.expectation === 'expected-migration-delta'
        ? 'expected-migration-delta'
        : 'unexpected-delta';
    this.add(field, classification, policy.reason, hostValue, targetValue, context);
  }

  money(
    field: 'liquidation' | 'winning-settlement',
    hostValue: bigint,
    targetValue: bigint,
    context: { readonly vectorId: string; readonly caseId: string; readonly message: string },
  ): void {
    const policy = this.policy(field);
    const delta = targetValue - hostValue;
    if (delta === 0n) {
      this.counts.exact += 1;
      return;
    }
    const allowed = policy.allowedDeltaCents;
    const expected =
      policy.expectation === 'expected-migration-delta' &&
      allowed !== undefined &&
      delta >= BigInt(allowed.min) &&
      delta <= BigInt(allowed.max);
    this.add(
      field,
      expected ? 'expected-migration-delta' : 'unexpected-delta',
      policy.reason,
      hostValue.toString(10),
      targetValue.toString(10),
      context,
      delta.toString(10),
    );
  }

  exact(
    field: CompatibilityField,
    hostValue: string,
    targetValue: string,
    context: { readonly vectorId?: string; readonly caseId?: string; readonly message: string },
  ): void {
    if (hostValue === targetValue) {
      this.counts.exact += 1;
      return;
    }
    this.add(field, 'unexpected-delta', this.policy(field).reason, hostValue, targetValue, context);
  }

  drift(
    field: CompatibilityField,
    frozenTarget: string,
    currentTarget: string,
    context: { readonly vectorId?: string; readonly caseId?: string; readonly message: string },
  ): void {
    if (frozenTarget === currentTarget) return;
    this.add(
      field,
      'target-drift',
      this.policy(field).reason,
      frozenTarget,
      currentTarget,
      context,
    );
  }

  hostManaged(field: 'ride-lifecycle', message: string): void {
    const policy = this.policy(field);
    this.add(field, 'host-managed', policy.reason, 'host', 'not-in-engine-corpus-v1', { message });
  }

  private policy(field: CompatibilityField): CompatibilityPolicy {
    const policy = this.policies.get(field);
    if (!policy) fail('INVALID_COMPATIBILITY_CORPUS', 'Missing field policy', '$.policies');
    return policy;
  }

  private add(
    field: CompatibilityField,
    classification: CompatibilityClassification,
    reason: CompatibilityFinding['reason'],
    hostValue: string,
    targetValue: string,
    context: { readonly vectorId?: string; readonly caseId?: string; readonly message: string },
    deltaCents?: string,
  ): void {
    this.counts[classification] += 1;
    this.findings.push(
      Object.freeze({
        field,
        classification,
        reason,
        ...(context.vectorId === undefined ? {} : { vectorId: context.vectorId }),
        ...(context.caseId === undefined ? {} : { caseId: context.caseId }),
        hostValue,
        targetValue,
        ...(deltaCents === undefined ? {} : { deltaCents }),
        message: context.message,
      }),
    );
  }
}

function policyMap(
  corpus: CompatibilityCorpusV1,
): ReadonlyMap<CompatibilityField, CompatibilityPolicy> {
  return new Map(corpus.policies.map((policy) => [policy.field, policy]));
}

function assertAdapterIdentity(game: GameDefinition, corpus: CompatibilityCorpusV1): void {
  if (game.id !== corpus.target.adapterId || game.adapterVersion !== corpus.target.adapterVersion)
    fail(
      'ADAPTER_MISMATCH',
      'Compatibility corpus targets a different adapter ID or version',
      '$.target',
      {
        expectedId: corpus.target.adapterId,
        actualId: game.id,
        expectedVersion: corpus.target.adapterVersion,
        actualVersion: game.adapterVersion,
      },
    );
  if (adapterFingerprint(game) !== corpus.target.adapterFingerprint)
    fail(
      'ADAPTER_MISMATCH',
      'Compatibility corpus adapter fingerprint differs from the supplied game',
      '$.target.adapterFingerprint',
    );
}

function compareContract(
  game: GameDefinition,
  corpus: CompatibilityCorpusV1,
  report: ReportBuilder,
): void {
  report.exact('continuation', corpus.target.engineApiVersion, game.apiVersion, {
    message: 'Engine API version must remain exact.',
  });
  report.exact('continuation', ENGINE_API_VERSION, game.apiVersion, {
    message: 'Runtime engine API version must remain exact.',
  });
  report.exact('commitment', corpus.target.proofVersion, COMMITMENT_VERSION, {
    message: 'Target proof version must remain commit-v2.',
  });
  report.exact('commitment', corpus.target.transcriptSchema, 'reveal-engine/transcript-v2', {
    message: 'Target transcript schema must remain transcript-v2.',
  });
  report.exact('posterior', corpus.contract.outcomes.join(','), game.outcomes.join(','), {
    message: 'Outcome order is an exact adapter contract field.',
  });
  report.exact('posterior', corpus.contract.priorWeights.join(','), game.priorWeights.join(','), {
    message: 'Prior weights are an exact adapter contract field.',
  });
  report.exact(
    'evidence',
    String(Math.max(...corpus.sampling.posteriorFrames, ...corpus.sampling.exitFrames)),
    String(game.evidence.eventCount),
    { message: 'Frozen frame coverage must match the adapter evidence schedule.' },
  );
  report.exact(
    'winning-settlement',
    `${corpus.contract.firstEntryRtp.numerator}/${corpus.contract.firstEntryRtp.denominator}`,
    `${game.pricing.firstEntryRtp.numerator}/${game.pricing.firstEntryRtp.denominator}`,
    { message: 'First-entry RTP is an exact adapter contract field.' },
  );
  report.exact(
    'liquidation',
    `${corpus.contract.liquidationSpread.numerator}/${corpus.contract.liquidationSpread.denominator}:${corpus.contract.rounding}`,
    `${game.pricing.liquidationSpread.numerator}/${game.pricing.liquidationSpread.denominator}:${game.pricing.rounding}`,
    { message: 'Liquidation spread and rounding are exact adapter contract fields.' },
  );
  report.exact(
    'max-win-cap',
    corpus.contract.maxWinMultiple,
    game.risk.maxWinMultiple.toString(10),
    { message: 'Max-win multiple is an exact adapter contract field.' },
  );
  report.exact(
    'continuation',
    String(corpus.contract.continuation.maxRides),
    String(game.risk.continuation?.maxRides ?? -1),
    { message: 'Continuation count must match the frozen host configuration.' },
  );
  report.exact(
    'continuation',
    `${corpus.contract.continuation.rtpFloor.numerator}/${corpus.contract.continuation.rtpFloor.denominator}`,
    `${game.risk.continuation?.rtpFloor.numerator ?? -1n}/${game.risk.continuation?.rtpFloor.denominator ?? -1n}`,
    { message: 'Continuation RTP floor must match the frozen host configuration.' },
  );
}

/**
 * Replays a frozen shadow corpus against a supplied adapter. Expected migration
 * deltas remain visible findings; target drift and unexplained deltas fail the report.
 */
export function compareCompatibilityCorpus(
  game: GameDefinition,
  input: unknown,
): CompatibilityReportV1 {
  const corpus = parseCompatibilityCorpus(input);
  assertAdapterIdentity(game, corpus);
  const report = new ReportBuilder(policyMap(corpus));
  compareContract(game, corpus, report);

  let posteriorCheckpoints = 0;
  for (const vector of corpus.vectors) {
    const currentTarget = makeTranscript(vector.seed, game, vector.roundId);
    const currentEvidenceDigest = compatibilityEvidenceDigest(
      targetEvidenceWire(currentTarget.evidence),
    );
    report.drift('truth', String(vector.target.truth), String(currentTarget.truth), {
      vectorId: vector.vectorId,
      message: 'Current target truth differs from the frozen engine target.',
    });
    report.drift('evidence', vector.target.evidenceSha256, currentEvidenceDigest, {
      vectorId: vector.vectorId,
      message: 'Current target evidence differs from the frozen engine target.',
    });
    report.drift('commitment', vector.target.commitment, currentTarget.commitment, {
      vectorId: vector.vectorId,
      message: 'Current commit-v2 output differs from the frozen engine target.',
    });
    report.string('truth', String(vector.host.truth), String(currentTarget.truth), {
      vectorId: vector.vectorId,
      message: 'Legacy host and commit-v2 truth derivations are compared without normalization.',
    });
    const hostEvidence = evidenceFromWire(vector.host.evidence);
    const hostEvidenceDigest = compatibilityEvidenceDigest(vector.host.evidence);
    report.string('evidence', hostEvidenceDigest, currentEvidenceDigest, {
      vectorId: vector.vectorId,
      message: 'Legacy host and engine-v2 evidence schedules are compared by canonical digest.',
    });
    report.string('commitment', vector.host.commitment, currentTarget.commitment, {
      vectorId: vector.vectorId,
      message: 'Delimiter commitment and canonical commit-v2 remain explicitly distinct.',
    });

    for (const checkpoint of vector.host.posteriorCheckpoints) {
      const current = posteriorFor(game, hostEvidence.slice(0, checkpoint.frame));
      report.exact('posterior', checkpoint.weights.join(','), current.weights.join(','), {
        vectorId: vector.vectorId,
        caseId: `posterior-${checkpoint.frame}`,
        message: 'Identical frozen host evidence must produce identical exact posterior weights.',
      });
      posteriorCheckpoints += 1;
    }

    for (const economicCase of vector.economics) {
      const entryPosterior = posteriorFor(game, hostEvidence.slice(0, economicCase.entryFrame));
      const exitPosterior = posteriorFor(game, hostEvidence.slice(0, economicCase.exitFrame));
      const claim = multiply(
        rational(BigInt(economicCase.stakeCents)),
        quote(game, entryPosterior, economicCase.outcome, true, economicCase.entryFrame).multiplier,
      );
      const currentSell = floor(
        fairValueClaim(claim, exitPosterior, economicCase.outcome, game.pricing.liquidationSpread),
      );
      const currentSettlement = floor(claim);
      report.drift('liquidation', economicCase.targetSellCents, currentSell.toString(10), {
        vectorId: vector.vectorId,
        caseId: economicCase.caseId,
        message: 'Current exact-claim liquidation differs from the frozen engine target.',
      });
      report.drift(
        'winning-settlement',
        economicCase.targetWinningSettlementCents,
        currentSettlement.toString(10),
        {
          vectorId: vector.vectorId,
          caseId: economicCase.caseId,
          message: 'Current exact-claim settlement differs from the frozen engine target.',
        },
      );
      report.money('liquidation', BigInt(economicCase.hostSellCents), currentSell, {
        vectorId: vector.vectorId,
        caseId: economicCase.caseId,
        message: 'Host early-floor and engine exact-claim liquidation are both reported.',
      });
      report.money(
        'winning-settlement',
        BigInt(economicCase.hostWinningSettlementCents),
        currentSettlement,
        {
          vectorId: vector.vectorId,
          caseId: economicCase.caseId,
          message: 'Host early-floor and engine exact-claim settlement are both reported.',
        },
      );
    }
  }

  for (const capCase of corpus.capCases) {
    const payable = payableWithinCap(
      rational(BigInt(capCase.theoretical.numerator), BigInt(capCase.theoretical.denominator)),
      BigInt(capCase.originalStakeCents),
      BigInt(capCase.maxWinMultiple),
      BigInt(capCase.alreadyLiquidCents),
    );
    report.exact(
      'max-win-cap',
      `${capCase.expectedCreditedCents}:${capCase.expectedCapped}`,
      `${payable.credited}:${payable.capped}`,
      {
        caseId: capCase.caseId,
        message: 'Every sell/settlement credit must preserve the original chain cap basis.',
      },
    );
  }
  report.hostManaged(
    'ride-lifecycle',
    'Cross-round offers, timeouts, wallet effects, and ride-chain state remain host-owned.',
  );

  const ok = report.counts['unexpected-delta'] === 0 && report.counts['target-drift'] === 0;
  const activationReady = ok && corpus.policies.every((policy) => policy.expectation === 'exact');
  return deepFreeze({
    schema: COMPATIBILITY_REPORT_VERSION,
    corpusId: corpus.corpusId,
    corpusSha256: compatibilityCorpusDigest(corpus),
    target: corpus.target,
    ok,
    activationReady,
    checked: {
      vectors: corpus.vectors.length,
      posteriorCheckpoints,
      economicCases: corpus.sampling.economicCaseCount,
      capCases: corpus.capCases.length,
    },
    classifications: report.counts,
    observed: corpus.observed,
    findings: report.findings,
  });
}
