import { createHash, createHmac } from 'node:crypto';
import { fail } from '../api/errors.js';
import { ENGINE_LIMITS } from '../api/limits.js';
import {
  COMPATIBILITY_CORPUS_VERSION,
  type CompatibilityCorpusV1,
  type CompatibilityEvidenceEvent,
  type CompatibilityField,
  type CompatibilityPolicy,
} from './contracts.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail('INVALID_COMPATIBILITY_CORPUS', 'Object has missing or unknown fields', path);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail('INVALID_COMPATIBILITY_CORPUS', 'Expected object', path);
  return value;
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    fail('INVALID_COMPATIBILITY_CORPUS', 'Expected bounded array', path);
  return value;
}

function text(value: unknown, path: string, maxBytes = 256): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail('INVALID_COMPATIBILITY_CORPUS', 'Expected bounded printable string', path);
  return value;
}

function sha256(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    fail('INVALID_COMPATIBILITY_CORPUS', 'Expected lowercase SHA-256', path);
  return value;
}

function seedHex(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    fail('INVALID_COMPATIBILITY_CORPUS', 'Expected canonical 32-byte seed hex', path);
  return value;
}

function gitRevision(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value))
    fail('INVALID_COMPATIBILITY_CORPUS', 'Expected full lowercase Git SHA-1', path);
  return value;
}

function safeInteger(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    fail('INVALID_COMPATIBILITY_CORPUS', 'Expected non-negative safe integer', path);
  return Number(value);
}

function decimal(value: unknown, path: string, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,1233})$/u.test(value))
    fail('INVALID_COMPATIBILITY_CORPUS', 'Expected canonical non-negative integer string', path);
  const parsed = BigInt(value);
  if ((positive && parsed <= 0n) || parsed.toString(2).length > ENGINE_LIMITS.maxBigIntBits)
    fail('INVALID_COMPATIBILITY_CORPUS', 'Integer is outside compatibility limits', path);
  return value;
}

function signedDecimal(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]{0,1233})$/u.test(value))
    fail('INVALID_COMPATIBILITY_CORPUS', 'Expected canonical integer string', path);
  if ((BigInt(value) < 0n ? -BigInt(value) : BigInt(value)).toString(2).length > 4096)
    fail('INVALID_COMPATIBILITY_CORPUS', 'Integer is outside compatibility limits', path);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_COMPATIBILITY_CORPUS', 'Non-finite JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  fail('INVALID_COMPATIBILITY_CORPUS', 'Corpus contains a non-JSON value');
}

/** SHA-256 over recursively key-sorted JSON, excluding the top-level integrity field. */
export function compatibilityCorpusDigest(input: unknown): string {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      fail('INVALID_COMPATIBILITY_CORPUS', 'Corpus is not valid JSON');
    }
  }
  const source = record(value, '$');
  const withoutIntegrity = Object.fromEntries(
    Object.entries(source).filter(([key]) => key !== 'integrity'),
  );
  return createHash('sha256').update(canonicalJson(withoutIntegrity)).digest('hex');
}

export function compatibilityEvidenceDigest(
  evidence: readonly CompatibilityEvidenceEvent[],
): string {
  return createHash('sha256').update(canonicalJson(evidence)).digest('hex');
}

function validateRational(value: unknown, path: string): void {
  const rational = record(value, path);
  exactKeys(rational, ['numerator', 'denominator'], path);
  decimal(rational.numerator, `${path}.numerator`);
  decimal(rational.denominator, `${path}.denominator`, true);
}

const fields: readonly CompatibilityField[] = [
  'truth',
  'evidence',
  'commitment',
  'posterior',
  'liquidation',
  'winning-settlement',
  'max-win-cap',
  'continuation',
  'ride-lifecycle',
];

function validatePolicies(value: unknown): Map<CompatibilityField, CompatibilityPolicy> {
  const policies = array(value, '$.policies', fields.length);
  if (policies.length !== fields.length)
    fail(
      'INVALID_COMPATIBILITY_CORPUS',
      'Every compatibility field needs one policy',
      '$.policies',
    );
  const map = new Map<CompatibilityField, CompatibilityPolicy>();
  policies.forEach((item, index) => {
    const path = `$.policies[${index}]`;
    const policy = record(item, path);
    const hasDelta = 'allowedDeltaCents' in policy;
    exactKeys(
      policy,
      ['field', 'expectation', 'reason', ...(hasDelta ? ['allowedDeltaCents'] : [])],
      path,
    );
    if (!fields.includes(policy.field as CompatibilityField))
      fail('INVALID_COMPATIBILITY_CORPUS', 'Unknown compatibility field', `${path}.field`);
    const field = policy.field as CompatibilityField;
    if (map.has(field))
      fail('INVALID_COMPATIBILITY_CORPUS', 'Duplicate compatibility policy', `${path}.field`);
    const expected: readonly [string, string] | readonly [string, string, boolean] =
      field === 'truth'
        ? ['expected-migration-delta', 'legacy-truth-derivation']
        : field === 'evidence'
          ? ['expected-migration-delta', 'legacy-evidence-derivation']
          : field === 'commitment'
            ? ['expected-migration-delta', 'proof-version-upgrade']
            : field === 'liquidation' || field === 'winning-settlement'
              ? ['expected-migration-delta', 'early-payable-rounding', true]
              : field === 'ride-lifecycle'
                ? ['host-managed', 'host-managed-continuation']
                : ['exact', 'none'];
    if (policy.expectation !== expected[0] || policy.reason !== expected[1])
      fail(
        'INVALID_COMPATIBILITY_CORPUS',
        'Policy expectation/reason is not approved for this field',
        path,
      );
    if (expected[2]) {
      const delta = record(policy.allowedDeltaCents, `${path}.allowedDeltaCents`);
      exactKeys(delta, ['min', 'max'], `${path}.allowedDeltaCents`);
      const min = BigInt(signedDecimal(delta.min, `${path}.allowedDeltaCents.min`));
      const max = BigInt(signedDecimal(delta.max, `${path}.allowedDeltaCents.max`));
      if (min > max) fail('INVALID_COMPATIBILITY_CORPUS', 'Allowed delta range is inverted', path);
    } else if (hasDelta) {
      fail('INVALID_COMPATIBILITY_CORPUS', 'This field cannot declare a numeric tolerance', path);
    }
    map.set(field, policy as unknown as CompatibilityPolicy);
  });
  return map;
}

function hostTruth(
  seedHex: string,
  roundId: string,
  domainTemplate: string,
  outcomeCount: number,
): number {
  const seed = Buffer.from(seedHex, 'hex');
  const domain = domainTemplate.replace('{roundId}', roundId);
  if (!domainTemplate.includes('{roundId}') || domain.includes('{roundId}'))
    fail(
      'INVALID_COMPATIBILITY_CORPUS',
      'Truth domain template must contain one round placeholder',
    );
  const range = 1n << 64n;
  const modulus = BigInt(outcomeCount);
  const limit = range - (range % modulus);
  for (let counter = 0n; ; counter += 1n) {
    const counterBytes = Buffer.allocUnsafe(8);
    counterBytes.writeBigUInt64BE(counter);
    const draw = createHmac('sha256', seed)
      .update(Buffer.from(domain, 'utf8'))
      .update(counterBytes)
      .digest()
      .readBigUInt64BE(0);
    if (draw < limit) return Number(draw % modulus);
  }
}

function hostCommitment(
  seedHex: string,
  roundId: string,
  truth: number,
  evidence: readonly CompatibilityEvidenceEvent[],
): string {
  return createHash('sha256')
    .update(Buffer.from(seedHex, 'hex'))
    .update(`|${roundId}|${truth}|${evidence.map((event) => event.target).join(',')}`)
    .digest('hex');
}

function validateSource(value: unknown): void {
  const source = record(value, '$.source');
  exactKeys(
    source,
    [
      'repository',
      'branch',
      'revision',
      'revisionDate',
      'observedDirtyState',
      'files',
      'generator',
    ],
    '$.source',
  );
  text(source.repository, '$.source.repository');
  text(source.branch, '$.source.branch');
  gitRevision(source.revision, '$.source.revision');
  text(source.revisionDate, '$.source.revisionDate');
  array(source.observedDirtyState, '$.source.observedDirtyState', 16).forEach((item, index) =>
    text(item, `$.source.observedDirtyState[${index}]`, 512),
  );
  const sourceFiles = array(source.files, '$.source.files', 64);
  if (sourceFiles.length === 0)
    fail('INVALID_COMPATIBILITY_CORPUS', 'Source provenance needs at least one file');
  const paths = new Set<string>();
  sourceFiles.forEach((item, index) => {
    const path = `$.source.files[${index}]`;
    const file = record(item, path);
    exactKeys(file, ['path', 'sha256'], path);
    const name = text(file.path, `${path}.path`, 512);
    if (name.startsWith('/') || name.includes('..') || paths.has(name))
      fail('INVALID_COMPATIBILITY_CORPUS', 'Source file path is unsafe or duplicated', path);
    paths.add(name);
    sha256(file.sha256, `${path}.sha256`);
  });
  const generator = record(source.generator, '$.source.generator');
  exactKeys(generator, ['name', 'version'], '$.source.generator');
  text(generator.name, '$.source.generator.name');
  text(generator.version, '$.source.generator.version');
}

function validateTarget(value: unknown): void {
  const target = record(value, '$.target');
  exactKeys(
    target,
    [
      'engineApiVersion',
      'packageVersion',
      'adapterId',
      'adapterVersion',
      'adapterFingerprint',
      'proofVersion',
      'transcriptSchema',
    ],
    '$.target',
  );
  for (const key of [
    'engineApiVersion',
    'packageVersion',
    'adapterId',
    'adapterVersion',
    'proofVersion',
    'transcriptSchema',
  ])
    text(target[key], `$.target.${key}`);
  sha256(target.adapterFingerprint, '$.target.adapterFingerprint');
}

function validateHostContracts(value: unknown): string {
  const contracts = record(value, '$.hostContracts');
  exactKeys(
    contracts,
    ['truth', 'evidence', 'commitment', 'pricing', 'continuation'],
    '$.hostContracts',
  );
  const truth = record(contracts.truth, '$.hostContracts.truth');
  exactKeys(truth, ['algorithm', 'domainTemplate'], '$.hostContracts.truth');
  if (truth.algorithm !== 'hmac-sha256-uint64-rejection-v1')
    fail('INVALID_COMPATIBILITY_CORPUS', 'Unsupported host truth algorithm');
  const domainTemplate = text(truth.domainTemplate, '$.hostContracts.truth.domainTemplate', 512);
  const evidence = record(contracts.evidence, '$.hostContracts.evidence');
  exactKeys(evidence, ['algorithm'], '$.hostContracts.evidence');
  if (evidence.algorithm !== 'frozen-events-v1')
    fail('INVALID_COMPATIBILITY_CORPUS', 'Unsupported host evidence contract');
  const commitment = record(contracts.commitment, '$.hostContracts.commitment');
  exactKeys(commitment, ['algorithm'], '$.hostContracts.commitment');
  if (commitment.algorithm !== 'sha256-seed-pipe-round-truth-targets-v1')
    fail('INVALID_COMPATIBILITY_CORPUS', 'Unsupported host commitment contract');
  const pricing = record(contracts.pricing, '$.hostContracts.pricing');
  exactKeys(pricing, ['algorithm', 'scale'], '$.hostContracts.pricing');
  if (pricing.algorithm !== 'fixed-point-early-floor-v1')
    fail('INVALID_COMPATIBILITY_CORPUS', 'Unsupported host pricing contract');
  decimal(pricing.scale, '$.hostContracts.pricing.scale', true);
  const continuation = record(contracts.continuation, '$.hostContracts.continuation');
  exactKeys(continuation, ['ownership'], '$.hostContracts.continuation');
  if (continuation.ownership !== 'host')
    fail('INVALID_COMPATIBILITY_CORPUS', 'Continuation must remain host-owned in corpus v1');
  return domainTemplate;
}

function validateContract(value: unknown): number {
  const contract = record(value, '$.contract');
  exactKeys(
    contract,
    [
      'outcomes',
      'priorWeights',
      'firstEntryRtp',
      'liquidationSpread',
      'rounding',
      'maxWinMultiple',
      'continuation',
    ],
    '$.contract',
  );
  const outcomes = array(contract.outcomes, '$.contract.outcomes', ENGINE_LIMITS.maxOutcomes);
  if (outcomes.length < 2)
    fail('INVALID_COMPATIBILITY_CORPUS', 'At least two outcomes are required');
  const outcomeIds = new Set<string>();
  outcomes.forEach((item, index) => {
    const id = text(item, `$.contract.outcomes[${index}]`);
    if (outcomeIds.has(id))
      fail('INVALID_COMPATIBILITY_CORPUS', 'Outcome IDs must be unique', '$.contract.outcomes');
    outcomeIds.add(id);
  });
  const priors = array(contract.priorWeights, '$.contract.priorWeights', outcomes.length);
  if (priors.length !== outcomes.length)
    fail('INVALID_COMPATIBILITY_CORPUS', 'Prior count differs from outcomes');
  priors.forEach((item, index) => decimal(item, `$.contract.priorWeights[${index}]`, true));
  validateRational(contract.firstEntryRtp, '$.contract.firstEntryRtp');
  validateRational(contract.liquidationSpread, '$.contract.liquidationSpread');
  if (contract.rounding !== 'floor')
    fail('INVALID_COMPATIBILITY_CORPUS', 'Unsupported corpus rounding contract');
  decimal(contract.maxWinMultiple, '$.contract.maxWinMultiple', true);
  const continuation = record(contract.continuation, '$.contract.continuation');
  exactKeys(continuation, ['maxRides', 'rtpFloor'], '$.contract.continuation');
  const maxRides = safeInteger(continuation.maxRides, '$.contract.continuation.maxRides');
  if (maxRides > 64) fail('INVALID_COMPATIBILITY_CORPUS', 'Continuation count exceeds 64');
  validateRational(continuation.rtpFloor, '$.contract.continuation.rtpFloor');
  return outcomes.length;
}

interface SamplingShape {
  readonly seedCount: number;
  readonly posteriorFrames: readonly number[];
  readonly entryFrames: readonly number[];
  readonly exitFrames: readonly number[];
  readonly outcomes: readonly number[];
  readonly stakes: readonly string[];
  readonly economicCaseCount: number;
}

function integerArray(value: unknown, path: string, max: number): number[] {
  const values = array(value, path, max).map((item, index) =>
    safeInteger(item, `${path}[${index}]`),
  );
  if (new Set(values).size !== values.length)
    fail('INVALID_COMPATIBILITY_CORPUS', 'Sampling values must be unique', path);
  return values;
}

function validateSampling(value: unknown, outcomeCount: number): SamplingShape {
  const sampling = record(value, '$.sampling');
  exactKeys(
    sampling,
    [
      'seedCount',
      'seedDerivation',
      'roundIdTemplate',
      'posteriorFrames',
      'entryFrames',
      'exitFrames',
      'outcomes',
      'stakesCents',
      'economicCaseCount',
    ],
    '$.sampling',
  );
  const seedCount = safeInteger(sampling.seedCount, '$.sampling.seedCount', 1);
  if (seedCount > ENGINE_LIMITS.maxCompatibilityVectors)
    fail('INVALID_COMPATIBILITY_CORPUS', 'Too many compatibility seeds');
  if (sampling.seedDerivation !== 'counter-as-32-byte-big-endian-hex')
    fail('INVALID_COMPATIBILITY_CORPUS', 'Unsupported seed derivation');
  if (sampling.roundIdTemplate !== 'audit-{index}')
    fail('INVALID_COMPATIBILITY_CORPUS', 'Unsupported round ID template');
  const posteriorFrames = integerArray(sampling.posteriorFrames, '$.sampling.posteriorFrames', 256);
  const entryFrames = integerArray(sampling.entryFrames, '$.sampling.entryFrames', 256);
  const exitFrames = integerArray(sampling.exitFrames, '$.sampling.exitFrames', 256);
  const outcomes = integerArray(sampling.outcomes, '$.sampling.outcomes', outcomeCount);
  if (outcomes.some((outcome) => outcome >= outcomeCount))
    fail('INVALID_COMPATIBILITY_CORPUS', 'Sampling contains unknown outcome');
  const stakes = array(sampling.stakesCents, '$.sampling.stakesCents', 256).map((item, index) =>
    decimal(item, `$.sampling.stakesCents[${index}]`, true),
  );
  if (new Set(stakes).size !== stakes.length)
    fail('INVALID_COMPATIBILITY_CORPUS', 'Sampling stakes must be unique');
  const economicCaseCount = safeInteger(sampling.economicCaseCount, '$.sampling.economicCaseCount');
  const framePairs = entryFrames.reduce(
    (sum, entry) => sum + exitFrames.filter((exit) => exit >= entry).length,
    0,
  );
  const expected = seedCount * framePairs * outcomes.length * stakes.length;
  if (economicCaseCount !== expected || expected > ENGINE_LIMITS.maxCompatibilityEconomicCases)
    fail('INVALID_COMPATIBILITY_CORPUS', 'Economic sampling cardinality is inconsistent');
  return {
    seedCount,
    posteriorFrames,
    entryFrames,
    exitFrames,
    outcomes,
    stakes,
    economicCaseCount,
  };
}

function validateEvent(
  value: unknown,
  path: string,
  index: number,
  outcomes: number,
): CompatibilityEvidenceEvent {
  const event = record(value, path);
  exactKeys(event, ['index', 'target', 'favour', 'other', 'label'], path);
  if (safeInteger(event.index, `${path}.index`) !== index)
    fail('INVALID_COMPATIBILITY_CORPUS', 'Evidence index is not canonical', `${path}.index`);
  const target = safeInteger(event.target, `${path}.target`);
  if (target >= outcomes)
    fail('INVALID_COMPATIBILITY_CORPUS', 'Evidence targets unknown outcome', `${path}.target`);
  decimal(event.favour, `${path}.favour`, true);
  decimal(event.other, `${path}.other`, true);
  text(event.label, `${path}.label`, ENGINE_LIMITS.maxLabelBytes);
  return event as unknown as CompatibilityEvidenceEvent;
}

interface ComputedObserved {
  truthMatches: number;
  evidenceScheduleMatches: number;
  sellExactMatches: number;
  sellExpectedDeltas: number;
  settlementExactMatches: number;
  settlementExpectedDeltas: number;
  maxSellDeltaCents: bigint;
  maxSettlementDeltaCents: bigint;
}

function validateVectors(
  value: unknown,
  outcomeCount: number,
  sampling: SamplingShape,
  truthDomain: string,
): ComputedObserved {
  const vectors = array(value, '$.vectors', ENGINE_LIMITS.maxCompatibilityVectors);
  if (vectors.length !== sampling.seedCount)
    fail('INVALID_COMPATIBILITY_CORPUS', 'Vector count differs from sampling contract');
  let totalEconomicCases = 0;
  const observed: ComputedObserved = {
    truthMatches: 0,
    evidenceScheduleMatches: 0,
    sellExactMatches: 0,
    sellExpectedDeltas: 0,
    settlementExactMatches: 0,
    settlementExpectedDeltas: 0,
    maxSellDeltaCents: 0n,
    maxSettlementDeltaCents: 0n,
  };
  vectors.forEach((item, vectorIndex) => {
    const path = `$.vectors[${vectorIndex}]`;
    const vector = record(item, path);
    exactKeys(vector, ['vectorId', 'seed', 'roundId', 'host', 'target', 'economics'], path);
    text(vector.vectorId, `${path}.vectorId`);
    const seed = seedHex(vector.seed, `${path}.seed`);
    const expectedSeed = vectorIndex.toString(16).padStart(64, '0');
    if (seed !== expectedSeed)
      fail(
        'INVALID_COMPATIBILITY_CORPUS',
        'Vector seed differs from declared derivation',
        `${path}.seed`,
      );
    const roundId = text(vector.roundId, `${path}.roundId`);
    if (roundId !== `audit-${vectorIndex}`)
      fail(
        'INVALID_COMPATIBILITY_CORPUS',
        'Vector round ID differs from template',
        `${path}.roundId`,
      );
    const host = record(vector.host, `${path}.host`);
    exactKeys(host, ['truth', 'evidence', 'commitment', 'posteriorCheckpoints'], `${path}.host`);
    const hostTruthValue = safeInteger(host.truth, `${path}.host.truth`);
    if (hostTruthValue >= outcomeCount)
      fail('INVALID_COMPATIBILITY_CORPUS', 'Host truth is outside outcomes', `${path}.host.truth`);
    if (hostTruth(seed, roundId, truthDomain, outcomeCount) !== hostTruthValue)
      fail(
        'INVALID_COMPATIBILITY_CORPUS',
        'Frozen host truth does not replay',
        `${path}.host.truth`,
      );
    const evidenceValues = array(
      host.evidence,
      `${path}.host.evidence`,
      ENGINE_LIMITS.maxEvidenceEvents,
    );
    const evidence = evidenceValues.map((event, index) =>
      validateEvent(event, `${path}.host.evidence[${index}]`, index, outcomeCount),
    );
    const maximumFrame = Math.max(...sampling.posteriorFrames, ...sampling.exitFrames);
    if (evidence.length !== maximumFrame)
      fail('INVALID_COMPATIBILITY_CORPUS', 'Frozen evidence length differs from sampling frames');
    const commitment = sha256(host.commitment, `${path}.host.commitment`);
    if (hostCommitment(seed, roundId, hostTruthValue, evidence) !== commitment)
      fail('INVALID_COMPATIBILITY_CORPUS', 'Frozen host commitment does not replay');
    const checkpoints = array(
      host.posteriorCheckpoints,
      `${path}.host.posteriorCheckpoints`,
      sampling.posteriorFrames.length,
    );
    if (checkpoints.length !== sampling.posteriorFrames.length)
      fail('INVALID_COMPATIBILITY_CORPUS', 'Posterior checkpoint count mismatch');
    checkpoints.forEach((checkpointValue, checkpointIndex) => {
      const checkpointPath = `${path}.host.posteriorCheckpoints[${checkpointIndex}]`;
      const checkpoint = record(checkpointValue, checkpointPath);
      exactKeys(checkpoint, ['frame', 'weights'], checkpointPath);
      if (checkpoint.frame !== sampling.posteriorFrames[checkpointIndex])
        fail('INVALID_COMPATIBILITY_CORPUS', 'Posterior frames are not canonical', checkpointPath);
      const weights = array(checkpoint.weights, `${checkpointPath}.weights`, outcomeCount);
      if (weights.length !== outcomeCount)
        fail('INVALID_COMPATIBILITY_CORPUS', 'Posterior outcome count mismatch', checkpointPath);
      weights.forEach((weight, weightIndex) =>
        decimal(weight, `${checkpointPath}.weights[${weightIndex}]`, true),
      );
    });
    const target = record(vector.target, `${path}.target`);
    exactKeys(target, ['truth', 'evidenceSha256', 'commitment'], `${path}.target`);
    const targetTruth = safeInteger(target.truth, `${path}.target.truth`);
    if (targetTruth >= outcomeCount)
      fail('INVALID_COMPATIBILITY_CORPUS', 'Target truth is outside outcomes');
    const targetEvidence = sha256(target.evidenceSha256, `${path}.target.evidenceSha256`);
    sha256(target.commitment, `${path}.target.commitment`);
    if (hostTruthValue === targetTruth) observed.truthMatches += 1;
    if (compatibilityEvidenceDigest(evidence) === targetEvidence)
      observed.evidenceScheduleMatches += 1;

    const cases = array(
      vector.economics,
      `${path}.economics`,
      ENGINE_LIMITS.maxCompatibilityEconomicCases,
    );
    const expectedPerVector = sampling.economicCaseCount / sampling.seedCount;
    if (cases.length !== expectedPerVector)
      fail(
        'INVALID_COMPATIBILITY_CORPUS',
        'Vector economic case count mismatch',
        `${path}.economics`,
      );
    const tuples = new Set<string>();
    cases.forEach((caseValue, caseIndex) => {
      const casePath = `${path}.economics[${caseIndex}]`;
      const economicCase = record(caseValue, casePath);
      exactKeys(
        economicCase,
        [
          'caseId',
          'entryFrame',
          'exitFrame',
          'outcome',
          'stakeCents',
          'hostSellCents',
          'targetSellCents',
          'hostWinningSettlementCents',
          'targetWinningSettlementCents',
        ],
        casePath,
      );
      text(economicCase.caseId, `${casePath}.caseId`);
      const entry = safeInteger(economicCase.entryFrame, `${casePath}.entryFrame`);
      const exit = safeInteger(economicCase.exitFrame, `${casePath}.exitFrame`);
      const outcome = safeInteger(economicCase.outcome, `${casePath}.outcome`);
      const stake = decimal(economicCase.stakeCents, `${casePath}.stakeCents`, true);
      if (
        !sampling.entryFrames.includes(entry) ||
        !sampling.exitFrames.includes(exit) ||
        exit < entry ||
        !sampling.outcomes.includes(outcome) ||
        !sampling.stakes.includes(stake)
      )
        fail('INVALID_COMPATIBILITY_CORPUS', 'Economic case lies outside sampling grid', casePath);
      const tuple = `${entry}:${exit}:${outcome}:${stake}`;
      if (tuples.has(tuple))
        fail('INVALID_COMPATIBILITY_CORPUS', 'Duplicate economic sampling tuple', casePath);
      tuples.add(tuple);
      const hostSell = BigInt(decimal(economicCase.hostSellCents, `${casePath}.hostSellCents`));
      const targetSell = BigInt(
        decimal(economicCase.targetSellCents, `${casePath}.targetSellCents`),
      );
      const hostSettlement = BigInt(
        decimal(economicCase.hostWinningSettlementCents, `${casePath}.hostWinningSettlementCents`),
      );
      const targetSettlement = BigInt(
        decimal(
          economicCase.targetWinningSettlementCents,
          `${casePath}.targetWinningSettlementCents`,
        ),
      );
      const sellDelta = targetSell - hostSell;
      const settlementDelta = targetSettlement - hostSettlement;
      if (sellDelta === 0n) observed.sellExactMatches += 1;
      else observed.sellExpectedDeltas += 1;
      if (settlementDelta === 0n) observed.settlementExactMatches += 1;
      else observed.settlementExpectedDeltas += 1;
      const absSell = sellDelta < 0n ? -sellDelta : sellDelta;
      const absSettlement = settlementDelta < 0n ? -settlementDelta : settlementDelta;
      if (absSell > observed.maxSellDeltaCents) observed.maxSellDeltaCents = absSell;
      if (absSettlement > observed.maxSettlementDeltaCents)
        observed.maxSettlementDeltaCents = absSettlement;
    });
    totalEconomicCases += cases.length;
  });
  if (totalEconomicCases !== sampling.economicCaseCount)
    fail('INVALID_COMPATIBILITY_CORPUS', 'Economic corpus cardinality mismatch');
  return observed;
}

function validateObserved(value: unknown, computed: ComputedObserved, total: number): void {
  const observed = record(value, '$.observed');
  exactKeys(
    observed,
    [
      'truthMatches',
      'evidenceScheduleMatches',
      'sellExactMatches',
      'sellExpectedDeltas',
      'settlementExactMatches',
      'settlementExpectedDeltas',
      'maxSellDeltaCents',
      'maxSettlementDeltaCents',
    ],
    '$.observed',
  );
  const numeric: Array<
    [keyof Omit<ComputedObserved, 'maxSellDeltaCents' | 'maxSettlementDeltaCents'>, number]
  > = [
    ['truthMatches', computed.truthMatches],
    ['evidenceScheduleMatches', computed.evidenceScheduleMatches],
    ['sellExactMatches', computed.sellExactMatches],
    ['sellExpectedDeltas', computed.sellExpectedDeltas],
    ['settlementExactMatches', computed.settlementExactMatches],
    ['settlementExpectedDeltas', computed.settlementExpectedDeltas],
  ];
  for (const [key, expected] of numeric)
    if (safeInteger(observed[key], `$.observed.${key}`) !== expected)
      fail(
        'INVALID_COMPATIBILITY_CORPUS',
        'Observed summary differs from frozen vectors',
        `$.observed.${key}`,
      );
  if (
    computed.sellExactMatches + computed.sellExpectedDeltas !== total ||
    computed.settlementExactMatches + computed.settlementExpectedDeltas !== total
  )
    fail('INVALID_COMPATIBILITY_CORPUS', 'Observed economic totals are incomplete');
  if (
    BigInt(decimal(observed.maxSellDeltaCents, '$.observed.maxSellDeltaCents')) !==
      computed.maxSellDeltaCents ||
    BigInt(decimal(observed.maxSettlementDeltaCents, '$.observed.maxSettlementDeltaCents')) !==
      computed.maxSettlementDeltaCents
  )
    fail('INVALID_COMPATIBILITY_CORPUS', 'Observed maximum delta differs from vectors');
}

function validateCapCases(value: unknown): void {
  const cases = array(value, '$.capCases', 256);
  if (cases.length === 0) fail('INVALID_COMPATIBILITY_CORPUS', 'At least one cap case is required');
  const ids = new Set<string>();
  cases.forEach((caseValue, index) => {
    const path = `$.capCases[${index}]`;
    const capCase = record(caseValue, path);
    exactKeys(
      capCase,
      [
        'caseId',
        'theoretical',
        'originalStakeCents',
        'maxWinMultiple',
        'alreadyLiquidCents',
        'expectedCreditedCents',
        'expectedCapped',
      ],
      path,
    );
    const id = text(capCase.caseId, `${path}.caseId`);
    if (ids.has(id)) fail('INVALID_COMPATIBILITY_CORPUS', 'Duplicate cap case ID', path);
    ids.add(id);
    validateRational(capCase.theoretical, `${path}.theoretical`);
    decimal(capCase.originalStakeCents, `${path}.originalStakeCents`, true);
    decimal(capCase.maxWinMultiple, `${path}.maxWinMultiple`, true);
    decimal(capCase.alreadyLiquidCents, `${path}.alreadyLiquidCents`);
    decimal(capCase.expectedCreditedCents, `${path}.expectedCreditedCents`);
    if (typeof capCase.expectedCapped !== 'boolean')
      fail('INVALID_COMPATIBILITY_CORPUS', 'Expected cap boolean', `${path}.expectedCapped`);
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Parses, integrity-checks, semantically validates, and freezes corpus v1. */
export function parseCompatibilityCorpus(input: unknown): CompatibilityCorpusV1 {
  let value = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > ENGINE_LIMITS.maxCompatibilityCorpusBytes)
      fail('PAYLOAD_TOO_LARGE', 'Compatibility corpus exceeds byte limit');
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      fail('INVALID_COMPATIBILITY_CORPUS', 'Corpus is not valid JSON');
    }
  } else {
    let encoded: string;
    try {
      encoded = JSON.stringify(input);
    } catch {
      fail('INVALID_COMPATIBILITY_CORPUS', 'Corpus object is not JSON-serializable');
    }
    if (Buffer.byteLength(encoded, 'utf8') > ENGINE_LIMITS.maxCompatibilityCorpusBytes)
      fail('PAYLOAD_TOO_LARGE', 'Compatibility corpus exceeds byte limit');
  }
  const corpus = record(value, '$');
  exactKeys(
    corpus,
    [
      'schema',
      'corpusId',
      'source',
      'target',
      'hostContracts',
      'contract',
      'policies',
      'sampling',
      'observed',
      'vectors',
      'capCases',
      'integrity',
    ],
    '$',
  );
  if (corpus.schema !== COMPATIBILITY_CORPUS_VERSION)
    fail('UNSUPPORTED_VERSION', 'Unsupported compatibility corpus schema', '$.schema');
  text(corpus.corpusId, '$.corpusId');
  const integrity = record(corpus.integrity, '$.integrity');
  exactKeys(integrity, ['algorithm', 'sha256'], '$.integrity');
  if (integrity.algorithm !== 'sha256-canonical-json-v1')
    fail('UNSUPPORTED_VERSION', 'Unsupported corpus integrity algorithm', '$.integrity.algorithm');
  const declaredDigest = sha256(integrity.sha256, '$.integrity.sha256');
  if (compatibilityCorpusDigest(corpus) !== declaredDigest)
    fail(
      'COMPATIBILITY_INTEGRITY_MISMATCH',
      'Compatibility corpus integrity check failed',
      '$.integrity.sha256',
    );
  validateSource(corpus.source);
  validateTarget(corpus.target);
  const truthDomain = validateHostContracts(corpus.hostContracts);
  const outcomeCount = validateContract(corpus.contract);
  validatePolicies(corpus.policies);
  const sampling = validateSampling(corpus.sampling, outcomeCount);
  const computed = validateVectors(corpus.vectors, outcomeCount, sampling, truthDomain);
  validateObserved(corpus.observed, computed, sampling.economicCaseCount);
  validateCapCases(corpus.capCases);
  return deepFreeze(corpus as unknown as CompatibilityCorpusV1);
}
