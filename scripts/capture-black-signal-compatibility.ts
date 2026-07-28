import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adapterFingerprint } from '../src/core/adapter.js';
import { COMMITMENT_VERSION, ENGINE_API_VERSION } from '../src/core/contracts.js';
import { makeTranscript } from '../src/core/fairness.js';
import { fairValueClaim, posteriorFor, quote } from '../src/core/posterior.js';
import { floor, multiply, rational } from '../src/core/rational.js';
import {
  COMPATIBILITY_CORPUS_VERSION,
  type CompatibilityCorpusV1,
  type CompatibilityEvidenceEvent,
} from '../src/compatibility/contracts.js';
import {
  compatibilityCorpusDigest,
  compatibilityEvidenceDigest,
} from '../src/compatibility/corpus.js';
import { blackSignalReference } from '../src/reference/index.js';

const EXPECTED_SOURCE_REVISION = '7c63ebae28756df3b0ae96b917db37791cfcc588';
const EXPECTED_SOURCE_BRANCH = 'v8-signal-identity';
const EXPECTED_DIRTY_STATE = [' D black_signal_dossier.pdf', '?? .claude/'] as const;
const SOURCE_FILES = [
  'shared/config.ts',
  'shared/game.ts',
  'server/math.ts',
  'server/fairness.ts',
  'server/stream.ts',
  'server/positions.ts',
  'server/ride.ts',
  'tests/backend.ev-invariance.test.ts',
  'docs/superpowers/specs/2026-07-25-black-signal-v7-loop-design.md',
  'docs/superpowers/specs/2026-07-25-black-signal-signal-identity-design.md',
] as const;

interface TickStrength {
  readonly a: number;
  readonly b: number;
}
interface TickPlan {
  readonly index: number;
  readonly target: number;
  readonly strength: TickStrength;
  readonly isSpike: boolean;
}
interface HostPosterior {
  readonly weights: readonly bigint[];
  readonly denominator: bigint;
}
interface HostConfig {
  readonly outcomeCount: number;
  readonly tickCount: number;
  readonly rtpFixed: number;
  readonly rtpFloorFixed: number;
  readonly maxWinX: number;
  readonly sellSpreadFixed: number;
}

function argumentsForCapture(): { readonly source: string; readonly output: string } {
  const args = process.argv.slice(2);
  const sourceIndex = args.indexOf('--source');
  const outputIndex = args.indexOf('--output');
  const source = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined;
  const output =
    outputIndex >= 0 ? args[outputIndex + 1] : 'compatibility-corpora/black-signal-v1.json';
  if (!source || !output) {
    process.stderr.write(
      'Usage: npm run compatibility:capture -- --source <read-only-title-checkout> [--output <corpus>]\n',
    );
    process.exit(1);
  }
  return { source: resolve(source), output: resolve(output) };
}

function git(source: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trimEnd();
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertSource(source: string): { readonly revisionDate: string; readonly dirty: string[] } {
  const revision = git(source, ['rev-parse', 'HEAD']);
  const branch = git(source, ['branch', '--show-current']);
  const dirty = git(source, ['status', '--short']).split('\n').filter(Boolean);
  if (revision !== EXPECTED_SOURCE_REVISION || branch !== EXPECTED_SOURCE_BRANCH)
    throw new Error(
      `Source must remain pinned to ${EXPECTED_SOURCE_BRANCH}@${EXPECTED_SOURCE_REVISION}`,
    );
  if (JSON.stringify(dirty) !== JSON.stringify(EXPECTED_DIRTY_STATE))
    throw new Error(`Unexpected BLACK SIGNAL dirty state: ${JSON.stringify(dirty)}`);
  return { revisionDate: git(source, ['show', '-s', '--format=%cI', 'HEAD']), dirty };
}

function wireEvidence(ticks: readonly TickPlan[]): readonly CompatibilityEvidenceEvent[] {
  return ticks.map((tick) => ({
    index: tick.index,
    target: tick.target,
    favour: String(tick.strength.a),
    other: String(tick.strength.b),
    label: tick.isSpike ? 'spike' : 'weak',
  }));
}

async function capture(): Promise<void> {
  const { source, output } = argumentsForCapture();
  const sourceState = assertSource(source);
  const configModule = (await import(pathToFileURL(join(source, 'shared/config.ts')).href)) as {
    DEFAULT_CONFIG: HostConfig;
    RTP_LADDER: Readonly<Record<string, number>>;
    deriveMaxRides(rtp: number, floor: number): number;
  };
  const fairnessModule = (await import(pathToFileURL(join(source, 'server/fairness.ts')).href)) as {
    rejectionSampleUint(seed: Buffer, prefix: Buffer, modulus: number): number;
    commitRoundTranscript(
      seedHex: string,
      roundId: string,
      truth: number,
      targets: readonly number[],
    ): string;
  };
  const streamModule = (await import(pathToFileURL(join(source, 'server/stream.ts')).href)) as {
    deriveStreamSync(
      seedHex: string,
      roundId: string,
      truth: number,
      config: HostConfig,
    ): readonly TickPlan[];
  };
  const mathModule = (await import(pathToFileURL(join(source, 'server/math.ts')).href)) as {
    posteriorForTicks(
      targets: readonly number[],
      strengths: readonly TickStrength[],
      outcomes: number,
    ): HostPosterior;
    buyMultiplierFixed(posterior: HostPosterior, outcome: number, rtpFixed: number): number;
    payoutCentsFor(stake: number, multiplier: number): number;
    sellValueCents(
      payout: number,
      posterior: HostPosterior,
      outcome: number,
      spread: number,
    ): number;
  };
  const config = configModule.DEFAULT_CONFIG;
  const posteriorFrames = [0, 17, 52, 120] as const;
  const entryFrames = [0, 17, 52] as const;
  const exitFrames = [17, 52, 120] as const;
  const outcomes = [0, 1, 2, 3] as const;
  const stakes = [333, 1000] as const;
  const vectors: CompatibilityCorpusV1['vectors'][number][] = [];

  for (let sample = 0; sample < 64; sample += 1) {
    const seed = sample.toString(16).padStart(64, '0');
    const roundId = `audit-${sample}`;
    const truth = fairnessModule.rejectionSampleUint(
      Buffer.from(seed, 'hex'),
      Buffer.from(`black-signal-v1|${roundId}|truth|`),
      config.outcomeCount,
    );
    const ticks = streamModule.deriveStreamSync(seed, roundId, truth, config);
    const evidence = wireEvidence(ticks);
    const targetTranscript = makeTranscript(seed, blackSignalReference, roundId);
    const targetEvidence = targetTranscript.evidence.map((event) => ({
      index: event.index,
      target: event.target,
      favour: event.favour.toString(10),
      other: event.other.toString(10),
      label: event.label,
    }));
    const economics: CompatibilityCorpusV1['vectors'][number]['economics'][number][] = [];
    for (const entryFrame of entryFrames) {
      for (const exitFrame of exitFrames) {
        if (exitFrame < entryFrame) continue;
        for (const outcome of outcomes) {
          for (const stake of stakes) {
            const entryTicks = ticks.slice(0, entryFrame);
            const exitTicks = ticks.slice(0, exitFrame);
            const hostEntry = mathModule.posteriorForTicks(
              entryTicks.map((tick) => tick.target),
              entryTicks.map((tick) => tick.strength),
              config.outcomeCount,
            );
            const hostExit = mathModule.posteriorForTicks(
              exitTicks.map((tick) => tick.target),
              exitTicks.map((tick) => tick.strength),
              config.outcomeCount,
            );
            const hostMultiplier = mathModule.buyMultiplierFixed(
              hostEntry,
              outcome,
              config.rtpFixed,
            );
            const hostClaim = mathModule.payoutCentsFor(stake, hostMultiplier);
            const hostSell = mathModule.sellValueCents(
              hostClaim,
              hostExit,
              outcome,
              config.sellSpreadFixed,
            );
            const entryPosterior = posteriorFor(
              blackSignalReference,
              evidence.slice(0, entryFrame).map((event) => ({
                ...event,
                favour: BigInt(event.favour),
                other: BigInt(event.other),
              })),
            );
            const exitPosterior = posteriorFor(
              blackSignalReference,
              evidence.slice(0, exitFrame).map((event) => ({
                ...event,
                favour: BigInt(event.favour),
                other: BigInt(event.other),
              })),
            );
            const claim = multiply(
              rational(BigInt(stake)),
              quote(blackSignalReference, entryPosterior, outcome, true, entryFrame).multiplier,
            );
            economics.push({
              caseId: `e${entryFrame}-x${exitFrame}-o${outcome}-s${stake}`,
              entryFrame,
              exitFrame,
              outcome,
              stakeCents: String(stake),
              hostSellCents: String(hostSell),
              targetSellCents: floor(
                fairValueClaim(
                  claim,
                  exitPosterior,
                  outcome,
                  blackSignalReference.pricing.liquidationSpread,
                ),
              ).toString(10),
              hostWinningSettlementCents: String(hostClaim),
              targetWinningSettlementCents: floor(claim).toString(10),
            });
          }
        }
      }
    }
    vectors.push({
      vectorId: `sample-${sample.toString().padStart(2, '0')}`,
      seed,
      roundId,
      host: {
        truth,
        evidence,
        commitment: fairnessModule.commitRoundTranscript(
          seed,
          roundId,
          truth,
          ticks.map((tick) => tick.target),
        ),
        posteriorCheckpoints: posteriorFrames.map((frame) => ({
          frame,
          weights: mathModule
            .posteriorForTicks(
              ticks.slice(0, frame).map((tick) => tick.target),
              ticks.slice(0, frame).map((tick) => tick.strength),
              config.outcomeCount,
            )
            .weights.map(String),
        })),
      },
      target: {
        truth: targetTranscript.truth,
        evidenceSha256: compatibilityEvidenceDigest(targetEvidence),
        commitment: targetTranscript.commitment,
      },
      economics,
    });
  }

  const economicCases = vectors.flatMap((vector) => vector.economics);
  const sellDeltas = economicCases.map(
    (item) => BigInt(item.targetSellCents) - BigInt(item.hostSellCents),
  );
  const settlementDeltas = economicCases.map(
    (item) => BigInt(item.targetWinningSettlementCents) - BigInt(item.hostWinningSettlementCents),
  );
  const corpusWithoutIntegrity = {
    schema: COMPATIBILITY_CORPUS_VERSION,
    corpusId: 'black-signal-v1-to-reveal-engine-v0.3-shadow',
    source: {
      repository: 'metaforismo/blacksignal',
      branch: EXPECTED_SOURCE_BRANCH,
      revision: EXPECTED_SOURCE_REVISION,
      revisionDate: sourceState.revisionDate,
      observedDirtyState: sourceState.dirty,
      files: SOURCE_FILES.map((path) => ({ path, sha256: sha256File(join(source, path)) })),
      generator: { name: 'capture-black-signal-compatibility', version: '1.0.0' },
    },
    target: {
      engineApiVersion: ENGINE_API_VERSION,
      packageVersion: '0.3.0',
      adapterId: blackSignalReference.id,
      adapterVersion: blackSignalReference.adapterVersion,
      adapterFingerprint: adapterFingerprint(blackSignalReference),
      proofVersion: COMMITMENT_VERSION,
      transcriptSchema: 'reveal-engine/transcript-v2',
    },
    hostContracts: {
      truth: {
        algorithm: 'hmac-sha256-uint64-rejection-v1' as const,
        domainTemplate: 'black-signal-v1|{roundId}|truth|',
      },
      evidence: { algorithm: 'frozen-events-v1' as const },
      commitment: { algorithm: 'sha256-seed-pipe-round-truth-targets-v1' as const },
      pricing: { algorithm: 'fixed-point-early-floor-v1' as const, scale: '10000' },
      continuation: { ownership: 'host' as const },
    },
    contract: {
      outcomes: blackSignalReference.outcomes,
      priorWeights: blackSignalReference.priorWeights.map(String),
      firstEntryRtp: {
        numerator: blackSignalReference.pricing.firstEntryRtp.numerator.toString(10),
        denominator: blackSignalReference.pricing.firstEntryRtp.denominator.toString(10),
      },
      liquidationSpread: {
        numerator: blackSignalReference.pricing.liquidationSpread.numerator.toString(10),
        denominator: blackSignalReference.pricing.liquidationSpread.denominator.toString(10),
      },
      rounding: 'floor' as const,
      maxWinMultiple: blackSignalReference.risk.maxWinMultiple.toString(10),
      continuation: {
        maxRides: blackSignalReference.risk.continuation?.maxRides ?? -1,
        rtpFloor: {
          numerator:
            blackSignalReference.risk.continuation?.rtpFloor.numerator.toString(10) ?? '-1',
          denominator:
            blackSignalReference.risk.continuation?.rtpFloor.denominator.toString(10) ?? '-1',
        },
      },
    },
    policies: [
      {
        field: 'truth',
        expectation: 'expected-migration-delta',
        reason: 'legacy-truth-derivation',
      },
      {
        field: 'evidence',
        expectation: 'expected-migration-delta',
        reason: 'legacy-evidence-derivation',
      },
      {
        field: 'commitment',
        expectation: 'expected-migration-delta',
        reason: 'proof-version-upgrade',
      },
      { field: 'posterior', expectation: 'exact', reason: 'none' },
      {
        field: 'liquidation',
        expectation: 'expected-migration-delta',
        reason: 'early-payable-rounding',
        allowedDeltaCents: { min: '0', max: '1' },
      },
      {
        field: 'winning-settlement',
        expectation: 'expected-migration-delta',
        reason: 'early-payable-rounding',
        allowedDeltaCents: { min: '0', max: '1' },
      },
      { field: 'max-win-cap', expectation: 'exact', reason: 'none' },
      { field: 'continuation', expectation: 'exact', reason: 'none' },
      {
        field: 'ride-lifecycle',
        expectation: 'host-managed',
        reason: 'host-managed-continuation',
      },
    ],
    sampling: {
      seedCount: 64,
      seedDerivation: 'counter-as-32-byte-big-endian-hex' as const,
      roundIdTemplate: 'audit-{index}' as const,
      posteriorFrames,
      entryFrames,
      exitFrames,
      outcomes,
      stakesCents: stakes.map(String),
      economicCaseCount: economicCases.length,
    },
    observed: {
      truthMatches: vectors.filter((vector) => vector.host.truth === vector.target.truth).length,
      evidenceScheduleMatches: vectors.filter(
        (vector) =>
          compatibilityEvidenceDigest(vector.host.evidence) === vector.target.evidenceSha256,
      ).length,
      sellExactMatches: sellDeltas.filter((delta) => delta === 0n).length,
      sellExpectedDeltas: sellDeltas.filter((delta) => delta !== 0n).length,
      settlementExactMatches: settlementDeltas.filter((delta) => delta === 0n).length,
      settlementExpectedDeltas: settlementDeltas.filter((delta) => delta !== 0n).length,
      maxSellDeltaCents: sellDeltas
        .reduce((max, delta) => (delta > max ? delta : max), 0n)
        .toString(),
      maxSettlementDeltaCents: settlementDeltas
        .reduce((max, delta) => (delta > max ? delta : max), 0n)
        .toString(),
    },
    vectors,
    capCases: [
      {
        caseId: 'below-cap',
        theoretical: { numerator: '499999', denominator: '1' },
        originalStakeCents: '100',
        maxWinMultiple: '5000',
        alreadyLiquidCents: '0',
        expectedCreditedCents: '499999',
        expectedCapped: false,
      },
      {
        caseId: 'at-cap',
        theoretical: { numerator: '500000', denominator: '1' },
        originalStakeCents: '100',
        maxWinMultiple: '5000',
        alreadyLiquidCents: '0',
        expectedCreditedCents: '500000',
        expectedCapped: false,
      },
      {
        caseId: 'over-cap',
        theoretical: { numerator: '500001', denominator: '1' },
        originalStakeCents: '100',
        maxWinMultiple: '5000',
        alreadyLiquidCents: '0',
        expectedCreditedCents: '500000',
        expectedCapped: true,
      },
      {
        caseId: 'prior-liquid-cannot-bypass-cap',
        theoretical: { numerator: '400001', denominator: '1' },
        originalStakeCents: '100',
        maxWinMultiple: '5000',
        alreadyLiquidCents: '200000',
        expectedCreditedCents: '300000',
        expectedCapped: true,
      },
    ],
  } satisfies Omit<CompatibilityCorpusV1, 'integrity'>;

  const observed = corpusWithoutIntegrity.observed;
  if (
    observed.truthMatches !== 18 ||
    observed.evidenceScheduleMatches !== 0 ||
    observed.sellExpectedDeltas !== 1182 ||
    observed.settlementExpectedDeltas !== 14 ||
    observed.maxSellDeltaCents !== '1' ||
    observed.maxSettlementDeltaCents !== '1'
  )
    throw new Error(`Pinned audit findings drifted: ${JSON.stringify(observed)}`);
  if (
    configModule.deriveMaxRides(config.rtpFixed, config.rtpFloorFixed) !== 2 ||
    JSON.stringify(
      Object.values(configModule.RTP_LADDER).map((rtp) =>
        configModule.deriveMaxRides(rtp, config.rtpFloorFixed),
      ),
    ) !== JSON.stringify([4, 3, 2, 1])
  )
    throw new Error('Pinned title continuation ladder drifted');

  const corpus: CompatibilityCorpusV1 = {
    ...corpusWithoutIntegrity,
    integrity: {
      algorithm: 'sha256-canonical-json-v1',
      sha256: compatibilityCorpusDigest(corpusWithoutIntegrity),
    },
  };
  writeFileSync(output, `${JSON.stringify(corpus, null, 2)}\n`, { encoding: 'utf8' });
  process.stdout.write(
    `${output}\n${JSON.stringify({ revision: EXPECTED_SOURCE_REVISION, ...observed }, null, 2)}\n`,
  );
}

capture().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
