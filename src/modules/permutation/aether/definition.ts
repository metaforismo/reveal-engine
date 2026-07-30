import { createHash } from 'node:crypto';
import { RevealEngineError, fail } from '../../../api/errors.js';
import { equal, multiply, rational, type Rational } from '../../../core/rational.js';
import { sha256Hex } from '../../../core/random.js';
import { encodeFields, type CanonicalField } from '../../../internal/canonical.js';
import { assertPrintableIdentifier, isRecord, type SeedContext } from './context.js';
import {
  allPermutations,
  factorial,
  outcomeViewOf,
  type BetFamily,
  type BetInstance,
  type OutcomeView,
} from './families.js';
import {
  AETHER_ORDER_GAME_ID,
  ENGINE_API_VERSION,
  PERMUTATION_LIMITS,
  PERMUTATION_MODULE_VERSION,
  PLAY_POLICY_DOMAIN,
} from './identity.js';

export interface PermutationPricingPolicy {
  readonly targetRtp: Rational;
  readonly multipliers: Readonly<Record<string, Rational>>;
  readonly rounding: 'floor';
  readonly stakeQuantum: bigint;
}

export interface PermutationRiskPolicy {
  readonly maxWinMultiple: bigint;
  readonly maxLinesPerTicket: number;
  readonly minLineStake: bigint;
  readonly maxLineStake: bigint;
  readonly maxTicketStake: bigint;
  readonly requireDistinctLines: boolean;
}

export interface PermutationPlayPolicy {
  readonly minRoundCycleMs: number;
  readonly maxRoundsPerRollingHour: number;
  readonly realityCheckMinutes: readonly number[];
  readonly realityCheckRecurrenceMinutes: number;
  readonly playerRealityCheckIntervalOptions: readonly number[];
  readonly realityCheckOverride: 'tighten-only';
  readonly skipShortensPresentationOnly: true;
  readonly autoplay: 'none';
}

export interface PermutationGameDefinition {
  readonly apiVersion: typeof ENGINE_API_VERSION;
  readonly moduleVersion: typeof PERMUTATION_MODULE_VERSION;
  readonly adapterVersion: string;
  readonly id: string;
  readonly variantId: string;
  readonly n: number;
  readonly elements: readonly string[];
  readonly bets: readonly BetFamily[];
  readonly pricing: PermutationPricingPolicy;
  readonly risk: PermutationRiskPolicy;
  readonly play: PermutationPlayPolicy;
}

const catalogueCache = new WeakMap<PermutationGameDefinition, string>();
const fingerprintCache = new WeakMap<PermutationGameDefinition, string>();
const viewsCache = new WeakMap<PermutationGameDefinition, readonly OutcomeView[]>();
const instancesCache = new WeakMap<
  PermutationGameDefinition,
  Map<string, readonly BetInstance[]>
>();
const instanceIndexCache = new WeakMap<
  PermutationGameDefinition,
  Map<string, Map<string, BetInstance>>
>();
const claimCache = new WeakMap<PermutationGameDefinition, Map<string, string>>();

/** Internal-only bridge for immutable, frozen v1 verification fixtures. */
export function registerLegacyAdapterFingerprint(
  game: PermutationGameDefinition,
  fingerprint: string,
): void {
  if (!/^[0-9a-f]{64}$/u.test(fingerprint))
    fail('INVALID_ADAPTER', 'Legacy adapter fingerprint is malformed', '$.fingerprint');
  fingerprintCache.set(game, fingerprint);
}

function cloneRational(value: unknown, path: string, upperBoundOne = false): Rational {
  if (
    !isRecord(value) ||
    typeof value.numerator !== 'bigint' ||
    typeof value.denominator !== 'bigint'
  )
    fail('INVALID_ADAPTER', 'Expected a positive bounded Rational', path);
  let normalized: Rational;
  try {
    normalized = rational(value.numerator, value.denominator);
  } catch (error) {
    if (error instanceof RevealEngineError)
      fail('INVALID_ADAPTER', 'Rational is outside the engine arithmetic limits', path);
    throw error;
  }
  if (
    normalized.numerator <= 0n ||
    (upperBoundOne && normalized.numerator > normalized.denominator)
  )
    fail(
      'INVALID_ADAPTER',
      upperBoundOne ? 'Target RTP must be in (0, 1]' : 'Multiplier must be strictly positive',
      path,
    );
  return normalized;
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    fail('INVALID_ADAPTER', 'Expected a positive safe integer', path);
  return Number(value);
}

function positiveBigInt(value: unknown, path: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n)
    fail('INVALID_ADAPTER', 'Expected a positive BigInt', path);
  return value;
}

function cloneFamily(family: BetFamily, index: number): BetFamily {
  if (!isRecord(family))
    fail('INVALID_ADAPTER', 'Bet family must be a plain object', `$.bets[${index}]`);
  const code = assertPrintableIdentifier(
    family.code,
    `$.bets[${index}].code`,
    PERMUTATION_LIMITS.maxLabelBytes,
  );
  const name = assertPrintableIdentifier(
    family.name,
    `$.bets[${index}].name`,
    PERMUTATION_LIMITS.maxLabelBytes,
  );
  if (family.tier !== 'FLOW' && family.tier !== 'FORM' && family.tier !== 'ORDER')
    fail('INVALID_ADAPTER', 'Unknown bet tier', `$.bets[${index}].tier`);
  if (typeof family.enumerateInstances !== 'function' || typeof family.resolve !== 'function')
    fail(
      'INVALID_ADAPTER',
      'Bet family must supply enumerateInstances and resolve',
      `$.bets[${index}]`,
    );
  return Object.freeze({
    code,
    name,
    tier: family.tier,
    picks: String(family.picks),
    rule: String(family.rule),
    enumerateInstances: family.enumerateInstances.bind(family),
    resolve: family.resolve.bind(family),
  });
}

function factorialBigInt(value: number): bigint {
  let result = 1n;
  for (let factor = 2n; factor <= BigInt(value); factor += 1n) result *= factor;
  return result;
}

/**
 * Rejects synchronous constructions whose worst-case behavioural sweep would
 * monopolise the event loop. The estimate is deliberately conservative: every
 * family is allowed up to `n!` instances, each checked across `n!` outcomes,
 * once for the fingerprint and once for mandatory economics.
 */
function assertBehavioralWorkBudget(n: number, familyCount: number): void {
  const permutations = factorialBigInt(n);
  const estimate = 2n * BigInt(familyCount) * permutations * permutations;
  if (estimate > BigInt(PERMUTATION_LIMITS.maxBehavioralEvaluations))
    fail(
      'INVALID_ADAPTER',
      `Definition requires an estimated ${estimate.toString()} synchronous predicate evaluations; the budget is ${PERMUTATION_LIMITS.maxBehavioralEvaluations}`,
      '$.n',
    );
}

function assertEconomicConformance(game: PermutationGameDefinition): void {
  const views = viewsFor(game);
  for (const family of game.bets) {
    const multiplier = game.pricing.multipliers[family.code];
    if (multiplier === undefined)
      fail(
        'INVALID_ADAPTER',
        'Bet family has no multiplier',
        `$.pricing.multipliers.${family.code}`,
      );
    if (game.pricing.stakeQuantum % multiplier.denominator !== 0n)
      fail(
        'INVALID_ADAPTER',
        'Stake quantum cannot pay this multiplier exactly',
        `$.pricing.multipliers.${family.code}`,
      );
    for (const instance of instancesFor(game, family)) {
      let wins = 0n;
      for (const view of views) {
        const verdict = family.resolve(instance, view);
        if (verdict !== true && verdict !== false)
          fail('INVALID_ADAPTER', 'Bet resolver must return a boolean', `$.bets.${family.code}`);
        if (verdict) wins += 1n;
      }
      if (wins === 0n)
        fail('INVALID_ADAPTER', 'Bet instance can never win', `$.bets.${family.code}`);
      const probability = rational(wins, BigInt(views.length));
      if (!equal(multiply(probability, multiplier), game.pricing.targetRtp))
        fail(
          'INVALID_ADAPTER',
          'Multiplier does not price the target RTP exactly',
          `$.pricing.multipliers.${family.code}`,
        );
    }
  }
}

/**
 * The sole supported construction path. It snapshots every declarative value,
 * freezes the graph, then pays the behavioral-fingerprint cost once at startup.
 */
function preparePermutationGame(input: PermutationGameDefinition): PermutationGameDefinition {
  if (!isRecord(input)) fail('INVALID_ADAPTER', 'Definition must be a plain object', '$');
  if (input.apiVersion !== ENGINE_API_VERSION)
    fail('INVALID_ADAPTER', 'Unknown engine API version', '$.apiVersion');
  if (input.moduleVersion !== PERMUTATION_MODULE_VERSION)
    fail('INVALID_ADAPTER', 'Unknown permutation module version', '$.moduleVersion');
  const id = assertPrintableIdentifier(input.id, '$.id', PERMUTATION_LIMITS.maxRoundIdBytes);
  const variantId = assertPrintableIdentifier(
    input.variantId,
    '$.variantId',
    PERMUTATION_LIMITS.maxRoundIdBytes,
  );
  const adapterVersion = assertPrintableIdentifier(
    input.adapterVersion,
    '$.adapterVersion',
    PERMUTATION_LIMITS.maxRoundIdBytes,
  );
  if (!Number.isSafeInteger(input.n) || input.n < 2 || input.n > PERMUTATION_LIMITS.maxElements)
    fail('INVALID_ADAPTER', 'Permutation size must be in [2, 12]', '$.n');
  if (input.n > PERMUTATION_LIMITS.maxExhaustiveElements)
    fail('INVALID_ADAPTER', 'Behavioral fingerprinting supports at most 8 elements', '$.n');
  if (!Array.isArray(input.elements) || input.elements.length !== input.n)
    fail('INVALID_ADAPTER', 'Element count must equal n', '$.elements');
  const elements = Object.freeze(
    input.elements.map((element, index) =>
      assertPrintableIdentifier(element, `$.elements[${index}]`, PERMUTATION_LIMITS.maxLabelBytes),
    ),
  );
  if (new Set(elements).size !== elements.length)
    fail('INVALID_ADAPTER', 'Element identifiers must be unique', '$.elements');
  if (!Array.isArray(input.bets) || input.bets.length === 0 || input.bets.length > 32)
    fail('INVALID_ADAPTER', 'Definition needs at least one bet family', '$.bets');
  const bets = Object.freeze(input.bets.map(cloneFamily));
  if (new Set(bets.map((family) => family.code)).size !== bets.length)
    fail('INVALID_ADAPTER', 'Bet family codes must be unique', '$.bets');
  if (!isRecord(input.pricing) || !isRecord(input.pricing.multipliers))
    fail('INVALID_ADAPTER', 'Pricing policy is malformed', '$.pricing');
  const multipliers = Object.freeze(
    Object.fromEntries(
      Object.entries(input.pricing.multipliers).map(([code, value]) => [
        code,
        cloneRational(value, `$.pricing.multipliers.${code}`),
      ]),
    ),
  );
  if (input.pricing.rounding !== 'floor')
    fail('INVALID_ADAPTER', 'Only floor rounding is specified', '$.pricing.rounding');
  if (!isRecord(input.risk) || !isRecord(input.play))
    fail('INVALID_ADAPTER', 'Risk and play policies are required', '$');

  const realityChecks = Object.freeze(
    Array.prototype.slice.call(input.play.realityCheckMinutes) as number[],
  );
  const playerOptions = Object.freeze(
    Array.prototype.slice.call(input.play.playerRealityCheckIntervalOptions) as number[],
  );
  if (
    realityChecks.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    playerOptions.some((value) => !Number.isSafeInteger(value) || value <= 0)
  )
    fail('INVALID_ADAPTER', 'Reality-check intervals must be positive integers', '$.play');
  const recurrence = positiveSafeInteger(
    input.play.realityCheckRecurrenceMinutes,
    '$.play.realityCheckRecurrenceMinutes',
  );
  if (playerOptions.some((value) => value > recurrence))
    fail(
      'INVALID_ADAPTER',
      'Player reality-check options may only tighten the recurrence',
      '$.play.playerRealityCheckIntervalOptions',
    );
  if (
    input.play.realityCheckOverride !== 'tighten-only' ||
    input.play.skipShortensPresentationOnly !== true ||
    input.play.autoplay !== 'none'
  )
    fail('INVALID_ADAPTER', 'Play policy weakens a required safety invariant', '$.play');

  const definition: PermutationGameDefinition = Object.freeze({
    apiVersion: ENGINE_API_VERSION,
    moduleVersion: PERMUTATION_MODULE_VERSION,
    adapterVersion,
    id,
    variantId,
    n: input.n,
    elements,
    bets,
    pricing: Object.freeze({
      targetRtp: cloneRational(input.pricing.targetRtp, '$.pricing.targetRtp', true),
      multipliers,
      rounding: 'floor',
      stakeQuantum: positiveBigInt(input.pricing.stakeQuantum, '$.pricing.stakeQuantum'),
    }),
    risk: Object.freeze({
      maxWinMultiple: positiveBigInt(input.risk.maxWinMultiple, '$.risk.maxWinMultiple'),
      maxLinesPerTicket: positiveSafeInteger(
        input.risk.maxLinesPerTicket,
        '$.risk.maxLinesPerTicket',
      ),
      minLineStake: positiveBigInt(input.risk.minLineStake, '$.risk.minLineStake'),
      maxLineStake: positiveBigInt(input.risk.maxLineStake, '$.risk.maxLineStake'),
      maxTicketStake: positiveBigInt(input.risk.maxTicketStake, '$.risk.maxTicketStake'),
      requireDistinctLines: input.risk.requireDistinctLines === true,
    }),
    play: Object.freeze({
      minRoundCycleMs: positiveSafeInteger(input.play.minRoundCycleMs, '$.play.minRoundCycleMs'),
      maxRoundsPerRollingHour: positiveSafeInteger(
        input.play.maxRoundsPerRollingHour,
        '$.play.maxRoundsPerRollingHour',
      ),
      realityCheckMinutes: realityChecks,
      realityCheckRecurrenceMinutes: recurrence,
      playerRealityCheckIntervalOptions: playerOptions,
      realityCheckOverride: 'tighten-only',
      skipShortensPresentationOnly: true,
      autoplay: 'none',
    }),
  });
  if (
    definition.risk.minLineStake > definition.risk.maxLineStake ||
    definition.risk.maxLineStake > definition.risk.maxTicketStake
  )
    fail('INVALID_ADAPTER', 'Stake bounds are not ordered', '$.risk');
  return definition;
}

export function definePermutationGame(input: PermutationGameDefinition): PermutationGameDefinition {
  if (!isRecord(input) || !Array.isArray(input.bets))
    fail('INVALID_ADAPTER', 'Definition must carry bet families', '$.bets');
  assertBehavioralWorkBudget(Number(input.n), input.bets.length);
  const definition = preparePermutationGame(input);
  assertEconomicConformance(definition);
  permutationAdapterFingerprint(definition);
  return definition;
}

/**
 * Exhaustively validates a larger declaration without monopolising the event
 * loop. The same economics and behavioural fingerprint are proven as by the
 * synchronous constructor; only the scheduling differs.
 */
export async function definePermutationGameAsync(
  input: PermutationGameDefinition,
  options: { readonly yieldEvery?: number } = {},
): Promise<PermutationGameDefinition> {
  const every = options.yieldEvery ?? 10_000;
  if (!Number.isSafeInteger(every) || every < 1)
    fail('INVALID_ADAPTER', 'Yield interval must be a positive integer', '$.yieldEvery');
  const definition = preparePermutationGame(input);
  const views = viewsFor(definition);
  let evaluations = 0;
  for (const family of definition.bets) {
    const multiplier = definition.pricing.multipliers[family.code];
    if (multiplier === undefined)
      fail('INVALID_ADAPTER', 'Bet family has no multiplier', `$.pricing.${family.code}`);
    if (definition.pricing.stakeQuantum % multiplier.denominator !== 0n)
      fail(
        'INVALID_ADAPTER',
        'Stake quantum cannot pay this multiplier exactly',
        `$.pricing.${family.code}`,
      );
    for (const instance of instancesFor(definition, family)) {
      let wins = 0n;
      for (const view of views) {
        const verdict = family.resolve(instance, view);
        if (verdict !== true && verdict !== false)
          fail('INVALID_ADAPTER', 'Bet resolver must return a boolean', `$.bets.${family.code}`);
        if (verdict) wins += 1n;
        evaluations += 1;
        if (evaluations % every === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (
        wins === 0n ||
        !equal(
          multiply(rational(wins, BigInt(views.length)), multiplier),
          definition.pricing.targetRtp,
        )
      )
        fail(
          'INVALID_ADAPTER',
          'Multiplier does not price the target RTP exactly',
          `$.pricing.${family.code}`,
        );
    }
  }
  const digest = await computePermutationCatalogueDigestAsync(definition, every);
  catalogueCache.set(definition, digest);
  fingerprintCache.set(
    definition,
    sha256Hex(encodeFields(permutationFingerprintFields(definition, digest))),
  );
  return definition;
}

export function canonicalParams(params: object): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${String((params as Record<string, unknown>)[key])}`)
    .join(',');
}

export function snapshotParams(
  value: unknown,
  path = '$.params',
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) fail('UNKNOWN_INSTANCE', 'Bet parameters must be a plain object', path);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor')
      fail('UNKNOWN_INSTANCE', 'Dangerous parameter key is forbidden', path);
    const child = value[key];
    if (typeof child !== 'string' && typeof child !== 'number' && typeof child !== 'boolean')
      fail('UNKNOWN_INSTANCE', 'Bet parameters must be flat scalar values', `${path}.${key}`);
    if (typeof child === 'number' && !Number.isSafeInteger(child))
      fail('UNKNOWN_INSTANCE', 'Numeric parameters must be safe integers', `${path}.${key}`);
    result[key] = child;
  }
  return Object.freeze(result);
}

function sameParams(left: object, right: object): boolean {
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        leftRecord[key] === rightRecord[key],
    )
  );
}

export function instancesFor(
  game: PermutationGameDefinition,
  family: BetFamily,
): readonly BetInstance[] {
  let byFamily = instancesCache.get(game);
  if (!byFamily) {
    byFamily = new Map();
    instancesCache.set(game, byFamily);
  }
  const existing = byFamily.get(family.code);
  if (existing) return existing;
  const raw = family.enumerateInstances(game.n);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > factorial(game.n))
    fail('INVALID_ADAPTER', 'Bet family enumerated no instances', `$.bets.${family.code}`);
  const instances = Object.freeze(
    Array.prototype.slice.call(raw).map((value: unknown, index: number) => {
      if (!isRecord(value))
        fail(
          'INVALID_ADAPTER',
          'Bet instance must be a plain object',
          `$.bets.${family.code}[${index}]`,
        );
      if (value.code !== family.code)
        fail(
          'INVALID_ADAPTER',
          'Instance code disagrees with its family',
          `$.bets.${family.code}[${index}].code`,
        );
      const label = assertPrintableIdentifier(
        value.label,
        `$.bets.${family.code}[${index}].label`,
        PERMUTATION_LIMITS.maxLabelBytes,
      );
      return Object.freeze({
        code: family.code,
        params: snapshotParams(value.params, `$.bets.${family.code}[${index}].params`),
        label,
      });
    }),
  );
  byFamily.set(family.code, instances);
  return instances;
}

export function findFamily(
  game: PermutationGameDefinition,
  code: unknown,
  path = '$.code',
): BetFamily {
  if (typeof code !== 'string') fail('UNKNOWN_BET', 'Bet code must be a string', path);
  const family = game.bets.find((candidate) => candidate.code === code);
  if (!family) fail('UNKNOWN_BET', 'Unknown bet code', path);
  return family;
}

export function findInstance(
  game: PermutationGameDefinition,
  family: BetFamily,
  params: unknown,
  path = '$.params',
): BetInstance {
  const requested = snapshotParams(params, path);
  let gameIndexes = instanceIndexCache.get(game);
  if (!gameIndexes) {
    gameIndexes = new Map();
    instanceIndexCache.set(game, gameIndexes);
  }
  let index = gameIndexes.get(family.code);
  if (!index) {
    index = new Map();
    for (const instance of instancesFor(game, family))
      index.set(canonicalParams(instance.params), instance);
    gameIndexes.set(family.code, index);
  }
  const candidate = index.get(canonicalParams(requested));
  if (!candidate || !sameParams(candidate.params, requested))
    fail('UNKNOWN_INSTANCE', 'Bet parameters are not a legal instance', path);
  return candidate;
}

export function viewsFor(game: PermutationGameDefinition): readonly OutcomeView[] {
  const existing = viewsCache.get(game);
  if (existing) return existing;
  const views = Object.freeze(
    allPermutations(game.n).map((permutation) => outcomeViewOf(permutation, game.n)),
  );
  viewsCache.set(game, views);
  return views;
}

export function permutationClaimSignature(
  game: PermutationGameDefinition,
  code: string,
  instance: BetInstance,
): string {
  const family = findFamily(game, code);
  const canonical = findInstance(game, family, instance.params);
  let cache = claimCache.get(game);
  if (!cache) {
    cache = new Map();
    claimCache.set(game, cache);
  }
  const key = `${code}|${canonicalParams(canonical.params)}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const views = viewsFor(game);
  const bitmap = Buffer.alloc(Math.ceil(views.length / 8));
  for (let index = 0; index < views.length; index += 1)
    if (family.resolve(canonical, views[index] as OutcomeView) === true)
      bitmap[index >> 3] = (bitmap[index >> 3] as number) | (1 << (index & 7));
  const signature = sha256Hex(bitmap);
  cache.set(key, signature);
  return signature;
}

export function computePermutationCatalogueDigest(
  game: PermutationGameDefinition,
  families: readonly BetFamily[] = game.bets,
): string {
  const views = viewsFor(game);
  const hash = createHash('sha256');
  hash.update(
    encodeFields([
      'catalogue',
      PERMUTATION_MODULE_VERSION,
      game.id,
      game.variantId,
      game.n,
      views.length,
      families.length,
    ]),
  );
  const bitmap = Buffer.alloc(Math.ceil(views.length / 8));
  for (const family of families) {
    const instances =
      families === game.bets ? instancesFor(game, family) : family.enumerateInstances(game.n);
    hash.update(encodeFields(['family', family.code, family.tier, instances.length]));
    for (const instance of instances) {
      bitmap.fill(0);
      for (let index = 0; index < views.length; index += 1)
        if (family.resolve(instance, views[index] as OutcomeView) === true)
          bitmap[index >> 3] = (bitmap[index >> 3] as number) | (1 << (index & 7));
      hash.update(encodeFields([instance.label, canonicalParams(instance.params), bitmap]));
    }
  }
  return hash.digest('hex');
}

async function computePermutationCatalogueDigestAsync(
  game: PermutationGameDefinition,
  yieldEvery: number,
): Promise<string> {
  const views = viewsFor(game);
  const hash = createHash('sha256');
  hash.update(
    encodeFields([
      'catalogue',
      PERMUTATION_MODULE_VERSION,
      game.id,
      game.variantId,
      game.n,
      views.length,
      game.bets.length,
    ]),
  );
  const bitmap = Buffer.alloc(Math.ceil(views.length / 8));
  let evaluations = 0;
  for (const family of game.bets) {
    const instances = instancesFor(game, family);
    hash.update(encodeFields(['family', family.code, family.tier, instances.length]));
    for (const instance of instances) {
      bitmap.fill(0);
      for (let index = 0; index < views.length; index += 1) {
        if (family.resolve(instance, views[index] as OutcomeView) === true)
          bitmap[index >> 3] = (bitmap[index >> 3] as number) | (1 << (index & 7));
        evaluations += 1;
        if (evaluations % yieldEvery === 0)
          await new Promise<void>((resolve) => setImmediate(resolve));
      }
      hash.update(encodeFields([instance.label, canonicalParams(instance.params), bitmap]));
    }
  }
  return hash.digest('hex');
}

export function permutationCatalogueDigest(game: PermutationGameDefinition): string {
  const existing = catalogueCache.get(game);
  if (existing) return existing;
  const digest = computePermutationCatalogueDigest(game);
  catalogueCache.set(game, digest);
  return digest;
}

export function permutationFingerprintFields(
  game: PermutationGameDefinition,
  catalogueDigest = permutationCatalogueDigest(game),
): readonly CanonicalField[] {
  const fields: CanonicalField[] = [
    'adapter',
    PERMUTATION_MODULE_VERSION,
    game.id,
    game.adapterVersion,
    game.variantId,
    game.n,
    game.elements.length,
  ];
  game.elements.forEach((element, index) => fields.push(index, element));
  fields.push(game.bets.length);
  for (const family of game.bets) {
    const multiplier = game.pricing.multipliers[family.code];
    if (!multiplier)
      fail('INVALID_ADAPTER', `No multiplier for ${family.code}`, '$.pricing.multipliers');
    fields.push(family.code, multiplier.numerator, multiplier.denominator);
  }
  fields.push(
    'catalogue-behaviour',
    catalogueDigest,
    game.pricing.targetRtp.numerator,
    game.pricing.targetRtp.denominator,
    game.pricing.rounding,
    game.pricing.stakeQuantum,
    game.risk.maxWinMultiple,
    game.risk.maxLinesPerTicket,
    game.risk.minLineStake,
    game.risk.maxLineStake,
    game.risk.maxTicketStake,
    PERMUTATION_LIMITS.maxClientSeedBytes,
    PERMUTATION_LIMITS.maxRoundIdBytes,
    PERMUTATION_LIMITS.maxLabelBytes,
    game.risk.requireDistinctLines ? 1 : 0,
  );
  return Object.freeze(fields);
}

export function permutationAdapterFingerprint(game: PermutationGameDefinition): string {
  const existing = fingerprintCache.get(game);
  if (existing) return existing;
  const digest = sha256Hex(encodeFields(permutationFingerprintFields(game)));
  fingerprintCache.set(game, digest);
  return digest;
}

export function permutationPlayPolicyDigest(policy: PermutationPlayPolicy): string {
  return sha256Hex(
    encodeFields([
      PLAY_POLICY_DOMAIN,
      PERMUTATION_MODULE_VERSION,
      AETHER_ORDER_GAME_ID,
      String(policy.minRoundCycleMs),
      String(policy.maxRoundsPerRollingHour),
      Array.prototype.slice.call(policy.realityCheckMinutes).join(','),
      String(policy.realityCheckRecurrenceMinutes),
      Array.prototype.slice.call(policy.playerRealityCheckIntervalOptions).join(','),
      String(policy.realityCheckOverride),
      String(policy.skipShortensPresentationOnly === true),
      String(policy.autoplay),
    ]),
  );
}

/** Compile-time anchor: a seed context intentionally carries no player seed. */
export type PublishedSeedContext = SeedContext;

export function permutationCount(game: PermutationGameDefinition): number {
  return factorial(game.n);
}
