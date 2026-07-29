import { fail } from '../../api/errors.js';
import { ENGINE_LIMITS } from '../../api/limits.js';
import {
  compare,
  equal,
  multiply,
  rational,
  subtract,
  type Rational,
} from '../../core/rational.js';
import { assertIdentifier, assertRational, byteLength, isRecord } from '../../core/validation.js';
import { ENGINE_API_VERSION } from '../../core/versions.js';
import {
  SURVIVAL_LIMITS,
  type RoundRef,
  type StageContract,
  type SurvivalChoice,
  type SurvivalDefinition,
} from './contracts.js';

/**
 * Structural validation for `staged-survival`.
 *
 * Everything here fails closed with a typed `RevealEngineError`. The definition
 * assert is the one a hand-rolled object cannot route around: `defineSurvivalGame()`
 * calls it, and so does every derivation, so a definition that never went
 * through the supported construction path is still held to the same arithmetic.
 */

const ONE = rational(1n);
const ZERO = rational(0n);

/** Separator between the two halves of a round reference. Illegal inside a round id. */
export const ROUND_REF_SEPARATOR = '|';

/** Binary width of a BigInt magnitude. `0` is zero bits wide. */
function bitWidth(value: bigint): number {
  const magnitude = value < 0n ? -value : value;
  return magnitude === 0n ? 0 : magnitude.toString(2).length;
}

/** Width of the wider half of a rational: what the public BigInt limit sees. */
function rationalWidth(value: Rational): number {
  return Math.max(bitWidth(value.numerator), bitWidth(value.denominator));
}

/** Bytes left for the operator round id once the entropy half and separator are spent. */
export const MAX_ROUND_ID_BYTES =
  ENGINE_LIMITS.maxIdentifierBytes - SURVIVAL_LIMITS.clientEntropyBytes * 2 - 1;

function normalizedRational(value: unknown, path: string): Rational {
  assertRational(value, path);
  return rational(value.numerator, value.denominator);
}

/** `low <= value <= high`, with each endpoint independently open or closed. */
function assertInUnitRange(
  value: Rational,
  path: string,
  allowZero: boolean,
  allowOne: boolean,
): void {
  const low = compare(value, ZERO);
  const high = compare(value, ONE);
  if (low < 0 || (!allowZero && low === 0) || high > 0 || (!allowOne && high === 0))
    fail(
      'INVALID_ADAPTER',
      `Probability must be in ${allowZero ? '[' : '('}0, 1${allowOne ? ']' : ')'}`,
      path,
    );
}

/**
 * The exact marginal survival of one entity under a contract.
 *
 * `(1 - q) * c`. Identical for every entity of the contract whatever the lane
 * geometry is: the geometry moves the *joint* distribution, never the marginal.
 */
export function marginalSurvival(contract: StageContract): Rational {
  return multiply(
    subtract(
      ONE,
      rational(contract.profile.laneFailure.numerator, contract.profile.laneFailure.denominator),
    ),
    rational(
      contract.profile.entitySurvival.numerator,
      contract.profile.entitySurvival.denominator,
    ),
  );
}

function assertContract(
  contract: unknown,
  definition: SurvivalDefinition,
  path: string,
): asserts contract is StageContract {
  if (!isRecord(contract)) fail('INVALID_ADAPTER', 'Expected a stage contract', path);
  assertIdentifier(contract.id, `${path}.id`, 'INVALID_ADAPTER', 64);
  assertIdentifier(contract.label, `${path}.label`, 'INVALID_ADAPTER', 128);
  if (
    !Number.isSafeInteger(contract.laneWidth) ||
    (contract.laneWidth as number) < 1 ||
    (contract.laneWidth as number) > definition.entities
  )
    fail('INVALID_ADAPTER', 'Lane width must be in [1, entities]', `${path}.laneWidth`);
  if (
    !Number.isSafeInteger(contract.minEntities) ||
    (contract.minEntities as number) < 1 ||
    (contract.minEntities as number) > definition.entities
  )
    fail('INVALID_ADAPTER', 'Contract minEntities must be in [1, entities]', `${path}.minEntities`);
  if (!isRecord(contract.profile))
    fail('INVALID_ADAPTER', 'Expected a lane profile', `${path}.profile`);
  const laneFailure = normalizedRational(
    contract.profile.laneFailure,
    `${path}.profile.laneFailure`,
  );
  const entitySurvival = normalizedRational(
    contract.profile.entitySurvival,
    `${path}.profile.entitySurvival`,
  );
  // `q = 0` is legal and load-bearing: it is how a contract declares that its
  // entities are exactly independent. `q = 1` is not — a lane that always
  // collapses prices nothing.
  assertInUnitRange(laneFailure, `${path}.profile.laneFailure`, true, false);
  assertInUnitRange(entitySurvival, `${path}.profile.entitySurvival`, false, true);
  const multiplier = normalizedRational(contract.multiplier, `${path}.multiplier`);
  if (compare(multiplier, ZERO) <= 0)
    fail('INVALID_ADAPTER', 'Contract multiplier must be positive', `${path}.multiplier`);
  for (const [field, value] of [
    ['profile.laneFailure', laneFailure],
    ['profile.entitySurvival', entitySurvival],
  ] as const)
    if (definition.drawModulus % value.denominator !== 0n)
      fail(
        'INVALID_ADAPTER',
        'Every contract denominator must divide the draw modulus exactly',
        `${path}.${field}`,
      );
  // The fairness identity, checked here rather than only at construction: a
  // contract whose hazard and multiplier do not exactly cancel makes one route
  // worth more than another, and the round's return a function of policy.
  const survival = multiply(subtract(ONE, laneFailure), entitySurvival);
  if (!equal(multiply(survival, multiplier), definition.pricing.continuationReturn))
    fail(
      'INVALID_ADAPTER',
      'marginalSurvival * multiplier must equal pricing.continuationReturn exactly',
      `${path}.multiplier`,
    );
  assertDerivedWidths(
    { laneWidth: contract.laneWidth as number, multiplier },
    definition,
    laneFailure,
    entitySurvival,
    path,
  );
}

/**
 * Refuses a declaration whose **derived** quantities would exceed the engine's
 * public BigInt limit.
 *
 * Every other bound in this file constrains a declared field on its own: the
 * entity count, the stage count, the draw modulus, the menu size, the tape.
 * None of them constrains what the module builds *out of* those fields, and the
 * derived quantities grow as powers — the field survivor law carries
 * `den(c)^entities`, and the maximum round return carries `mu^stages`. So a
 * declaration can satisfy every field-level bound, and satisfy `p * mu == 1`
 * exactly, and still make `survivorDistribution()` or `maxRoundReturn()` raise
 * `INVALID_RATIONAL` from inside the rational primitives. That is an adapter
 * defect surfacing as an arithmetic failure, at the first derivation rather than
 * at define time, and it aborts a conformance run part way through its checks.
 *
 * ### The two bounds
 *
 * Write `W(x)` for the binary width of an integer and `W(r)` for the wider half
 * of a rational. Let `q = laneFailure`, `h = 1 - q`, `c = entitySurvival`,
 * `m = 1 - c`, `w = laneWidth`, `n = entities`, `S = stages`, `mu = multiplier`.
 *
 * **The field survivor law.** One lane of size `s <= w` contributes
 * `C(s, j) * h * c^j * m^(s-j)`, plus a point mass `q` at zero survivors, so the
 * widest integer any lane term holds is at most
 *
 * ```
 * laneBits = W(den h) + W(den q) + w * max(W(den c), W(den m)) + w
 * ```
 *
 * — the trailing `w` covers the binomial, since `C(s, j) <= 2^w`, and every
 * numerator is bounded by its denominator because `h`, `c` and `m` all lie in
 * `[0, 1]`. `survivorDistribution()` convolves `ceil(n / w)` such lanes, and the
 * running distribution's denominators divide the product of the lanes processed
 * so far, so the widest value it holds is `laneCount * laneBits`. Conformance
 * then takes the mean (a factor of at most `n`) and the fairness identity (a
 * factor of `mu`).
 *
 * The convolution accumulates with `add()`, which forms `a.den * b.den` *before*
 * reducing — and `rational()` checks its arguments before it reduces them — so a
 * sum of two values of width `B` transiently constructs one of width `2B`.
 * Hence:
 *
 * ```
 * fieldBits = 2 * ceil(n / w) * laneBits + W(n) + W(mu) + 2
 * ```
 *
 * The mean's factor of `n` and the identity's factor of `mu` are applied once,
 * after the convolution, so they are not doubled.
 *
 * **The pricing chain.** `maxRoundReturn()` is `entryReturn * max(mu)^S` by
 * repeated multiplication, and `assertCapIsUnreachable()` compares it against
 * `maxWinMultiple`. The same chain prices a claim: an entry opens at
 * `stake * entryReturn` and is multiplied by `mu` once per survived stage, and
 * `bank()` and `settle()` then **sum** up to `n` such claims — one `add()`, so
 * one doubling.
 *
 * ```
 * pricingBits = 2 * (W(entryReturn) + S * W(mu) + W(maxWinMultiple))
 *             + maxStakeBits + W(n) + 1
 * ```
 *
 * `maxStakeBits` is in there because the stake is the one input to this chain
 * that is a runtime argument rather than a declaration. Reserving its width here
 * is what lets `enter()` refuse an over-wide stake with a typed `CLAIM_REJECTED`
 * instead of letting it through to a half-applied `INVALID_RATIONAL` several
 * mutations later: `fundStake()` has already moved the cap basis and the entry
 * list by the time the claim value is constructed.
 *
 * The bounds are **sufficient, not tight**: they cover the widest unreduced
 * integer each derivation can construct, and reduction usually makes the real
 * value much smaller. A declaration refused here might have worked. The refusal
 * is deliberate and fails closed — the alternative is discovering the overflow
 * from a derivation deep inside a round. Both shipped references clear it by
 * more than an order of magnitude.
 */
function assertDerivedWidths(
  contract: { readonly laneWidth: number; readonly multiplier: Rational },
  definition: SurvivalDefinition,
  laneFailure: Rational,
  entitySurvival: Rational,
  path: string,
): void {
  const multiplier = contract.multiplier;
  const entryReturn = rational(
    definition.pricing.entryReturn.numerator,
    definition.pricing.entryReturn.denominator,
  );
  const held = subtract(ONE, laneFailure);
  const missed = subtract(ONE, entitySurvival);
  const perEntity = Math.max(bitWidth(entitySurvival.denominator), bitWidth(missed.denominator));
  const laneBits =
    bitWidth(held.denominator) +
    bitWidth(laneFailure.denominator) +
    contract.laneWidth * perEntity +
    contract.laneWidth;
  const laneCount = Math.ceil(definition.entities / contract.laneWidth);
  const entityBits = bitWidth(BigInt(definition.entities));
  const fieldBits = 2 * laneCount * laneBits + entityBits + rationalWidth(multiplier) + 2;
  if (fieldBits > ENGINE_LIMITS.maxBigIntBits)
    fail(
      'INVALID_ADAPTER',
      `Survivor distribution would need up to ${fieldBits} bits, past the ${ENGINE_LIMITS.maxBigIntBits}-bit engine limit`,
      `${path}.profile`,
    );
  const pricingBits =
    2 *
      (rationalWidth(entryReturn) +
        definition.stages * rationalWidth(multiplier) +
        bitWidth(definition.risk.maxWinMultiple)) +
    SURVIVAL_LIMITS.maxStakeBits +
    entityBits +
    1;
  if (pricingBits > ENGINE_LIMITS.maxBigIntBits)
    fail(
      'INVALID_ADAPTER',
      `Maximum round return would need up to ${pricingBits} bits, past the ${ENGINE_LIMITS.maxBigIntBits}-bit engine limit`,
      `${path}.multiplier`,
    );
}

/** Validates a definition graph, including the arithmetic identities it declares. */
export function assertSurvivalDefinition(
  value: unknown,
  path = '$',
): asserts value is SurvivalDefinition {
  if (!isRecord(value)) fail('INVALID_ADAPTER', 'Expected a survival definition', path);
  const definition = value as unknown as SurvivalDefinition;
  if (definition.apiVersion !== ENGINE_API_VERSION)
    fail('UNSUPPORTED_VERSION', 'Unsupported engine API version', `${path}.apiVersion`);
  assertIdentifier(definition.id, `${path}.id`, 'INVALID_ADAPTER', 64);
  assertIdentifier(definition.version, `${path}.version`, 'INVALID_ADAPTER', 32);
  if (
    !Number.isSafeInteger(definition.entities) ||
    definition.entities < 1 ||
    definition.entities > SURVIVAL_LIMITS.maxEntities
  )
    fail('INVALID_ADAPTER', 'Entity count is outside module limits', `${path}.entities`);
  if (
    !Number.isSafeInteger(definition.stages) ||
    definition.stages < 1 ||
    definition.stages > SURVIVAL_LIMITS.maxStages
  )
    fail('INVALID_ADAPTER', 'Stage count is outside module limits', `${path}.stages`);
  if (
    typeof definition.drawModulus !== 'bigint' ||
    definition.drawModulus <= 0n ||
    definition.drawModulus >= 1n << 256n
  )
    fail('INVALID_ADAPTER', 'Draw modulus must be in [1, 2^256)', `${path}.drawModulus`);

  if (!isRecord(definition.pricing))
    fail('INVALID_ADAPTER', 'Expected a pricing policy', `${path}.pricing`);
  const entryReturn = normalizedRational(
    definition.pricing.entryReturn,
    `${path}.pricing.entryReturn`,
  );
  assertInUnitRange(entryReturn, `${path}.pricing.entryReturn`, false, true);
  const continuationReturn = normalizedRational(
    definition.pricing.continuationReturn,
    `${path}.pricing.continuationReturn`,
  );
  // Pinned, not merely validated. See `SurvivalPricing.continuationReturn`.
  if (!equal(continuationReturn, ONE))
    fail(
      'INVALID_ADAPTER',
      'pricing.continuationReturn must be exactly 1: money already in the round rides at fair odds',
      `${path}.pricing.continuationReturn`,
    );
  if (definition.pricing.rounding !== 'floor')
    fail('INVALID_ADAPTER', 'Only floor rounding is supported', `${path}.pricing.rounding`);

  if (!isRecord(definition.risk)) fail('INVALID_ADAPTER', 'Expected a risk policy', `${path}.risk`);
  if (typeof definition.risk.maxWinMultiple !== 'bigint' || definition.risk.maxWinMultiple <= 0n)
    fail(
      'INVALID_ADAPTER',
      'maxWinMultiple must be a positive BigInt',
      `${path}.risk.maxWinMultiple`,
    );
  if (definition.risk.capBasis !== 'round-external-stake')
    fail(
      'INVALID_ADAPTER',
      'The only cap basis this module proves is round-external-stake',
      `${path}.risk.capBasis`,
    );
  if (typeof definition.risk.capMustBeUnreachable !== 'boolean')
    fail(
      'INVALID_ADAPTER',
      'capMustBeUnreachable must be declared',
      `${path}.risk.capMustBeUnreachable`,
    );

  if (
    !Array.isArray(definition.contracts) ||
    definition.contracts.length === 0 ||
    definition.contracts.length > SURVIVAL_LIMITS.maxContracts
  )
    fail('INVALID_ADAPTER', 'Contract menu size is outside module limits', `${path}.contracts`);
  const seen = new Set<string>();
  definition.contracts.forEach((contract, index) => {
    assertContract(contract, definition, `${path}.contracts[${index}]`);
    if (seen.has(contract.id))
      fail('INVALID_ADAPTER', 'Duplicate contract id', `${path}.contracts[${index}].id`);
    seen.add(contract.id);
  });
  // A round that opens with no legal move is not a round.
  if (!definition.contracts.some((contract) => contract.minEntities <= definition.entities))
    fail('INVALID_ADAPTER', 'No contract is available at the full field', `${path}.contracts`);

  // The tape is counterfactually complete, so its size is a declared quantity
  // and it is bounded here rather than at the first draw that would exceed it.
  const draws = definition.stages * definition.contracts.length * definition.entities * 2;
  if (draws > ENGINE_LIMITS.maxTapeDraws)
    fail(
      'INVALID_ADAPTER',
      'Counterfactually complete tape exceeds the engine draw budget',
      `${path}.stages`,
    );
}

/** Exact upper bound on what one unit of external stake can be credited in a round. */
export function maxRoundReturn(definition: SurvivalDefinition): Rational {
  assertSurvivalDefinition(definition);
  let best = rational(
    definition.contracts[0]?.multiplier.numerator ?? 1n,
    definition.contracts[0]?.multiplier.denominator ?? 1n,
  );
  for (const contract of definition.contracts) {
    const candidate = rational(contract.multiplier.numerator, contract.multiplier.denominator);
    if (compare(candidate, best) > 0) best = candidate;
  }
  let total = rational(
    definition.pricing.entryReturn.numerator,
    definition.pricing.entryReturn.denominator,
  );
  for (let stage = 0; stage < definition.stages; stage += 1) total = multiply(total, best);
  return total;
}

/**
 * Refuses a configuration in which the cap could clip an advertised win.
 *
 * `entryReturn * maxMultiple^stages` is a sound upper bound on the credit one
 * unit of external stake can produce: a claim opens at `stake * entryReturn` and
 * is multiplied once per survived stage by at most `max(mu)`, and flooring only
 * ever reduces it. Requiring it to sit strictly below `maxWinMultiple` is
 * therefore sufficient for "the cap never binds".
 *
 * It is also **attained** — and so the check is not merely conservative —
 * whenever the highest-multiplier contract is available at the full field, since
 * every entity surviving every stage under it is a positive-probability outcome
 * and the field never shrinks along that path. Both shipped references satisfy
 * that, so for them the bound is the exact supremum.
 */
export function assertCapIsUnreachable(definition: SurvivalDefinition): void {
  const bound = maxRoundReturn(definition);
  if (compare(bound, rational(definition.risk.maxWinMultiple)) >= 0)
    fail(
      'INVALID_ADAPTER',
      'risk.maxWinMultiple does not strictly exceed the exact maximum round return',
      '$.risk.maxWinMultiple',
    );
}

/** Canonical string form of a round reference: `<roundId>|<clientEntropy>`. */
export function roundRefId(ref: RoundRef): string {
  assertRoundRef(ref);
  return `${ref.roundId}${ROUND_REF_SEPARATOR}${ref.clientEntropy}`;
}

export function assertRoundRef(value: unknown, path = '$.round'): asserts value is RoundRef {
  if (!isRecord(value)) fail('INVALID_CONTEXT', 'Expected a round reference', path);
  assertClientEntropy(value.clientEntropy, `${path}.clientEntropy`);
  assertOperatorRoundId(value.roundId, `${path}.roundId`);
}

export function assertOperatorRoundId(value: unknown, path: string): asserts value is string {
  assertIdentifier(value, path, 'INVALID_CONTEXT', MAX_ROUND_ID_BYTES);
  if ((value as string).includes(ROUND_REF_SEPARATOR))
    fail('INVALID_CONTEXT', `Operator round id must not contain '${ROUND_REF_SEPARATOR}'`, path);
}

export function assertClientEntropy(value: unknown, path: string): asserts value is string {
  const width = SURVIVAL_LIMITS.clientEntropyBytes * 2;
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${width}}$`, 'u').test(value))
    fail(
      'INVALID_CONTEXT',
      `Client entropy must be exactly ${SURVIVAL_LIMITS.clientEntropyBytes} bytes of lowercase hexadecimal`,
      path,
    );
}

/**
 * Splits a canonical round id back into its two halves.
 *
 * The separator is illegal inside an operator round id, so exactly one
 * occurrence is expected and anything else fails closed. This is the untrusted
 * boundary for the round pair: a verifier reaches it with a transcript field.
 */
export function parseRoundRefId(value: unknown, path = '$.roundId'): RoundRef {
  assertIdentifier(value, path, 'INVALID_CONTEXT');
  const parts = (value as string).split(ROUND_REF_SEPARATOR);
  if (parts.length !== 2)
    fail('INVALID_CONTEXT', 'A staged-survival round id is <roundId>|<clientEntropy>', path);
  const [roundId, clientEntropy] = parts as [string, string];
  assertOperatorRoundId(roundId, `${path}.roundId`);
  assertClientEntropy(clientEntropy, `${path}.clientEntropy`);
  return Object.freeze({ roundId, clientEntropy });
}

/** Contracts the menu offers to a field of `liveCount` entities, in declaration order. */
export function contractMenu(
  definition: SurvivalDefinition,
  liveCount: number,
): readonly StageContract[] {
  assertSurvivalDefinition(definition);
  if (!Number.isSafeInteger(liveCount) || liveCount < 0 || liveCount > definition.entities)
    fail('INVALID_CHOICE', 'Live field size is outside the definition', '$.liveCount');
  return Object.freeze(
    definition.contracts.filter((contract) => contract.minEntities <= liveCount),
  );
}

/** Resolves a contract id against the menu available to a field of `liveCount`. */
export function contractFor(
  definition: SurvivalDefinition,
  contractId: unknown,
  liveCount: number,
): StageContract {
  if (typeof contractId !== 'string')
    fail('INVALID_CHOICE', 'Stage contract id must be a string', '$.choice.contractId');
  const declared = definition.contracts.find((candidate) => candidate.id === contractId);
  if (!declared) fail('INVALID_CHOICE', 'Unknown stage contract', '$.choice.contractId');
  if (declared.minEntities > liveCount)
    fail(
      'INVALID_CHOICE',
      'Stage contract is not offered to a field this small',
      '$.choice.contractId',
    );
  return declared;
}

/**
 * One entry stake: a positive BigInt inside `SURVIVAL_LIMITS.maxStakeBits`.
 *
 * The width matters, not just the sign. A claim value is
 * `stake * entryReturn * prod(mu)`, and `enter()` builds it *after*
 * `fundStake()` has already moved the cap basis and the entry list — so a stake
 * wide enough to overflow that product would leave the book half-mutated, with
 * an inflated basis, an entry that has no claim, and no receipt, in a state that
 * `restore()` then cannot even parse. `assertSurvivalDefinition` reserves this
 * much width for the stake, so a stake that clears this check cannot overflow
 * anywhere in the round.
 *
 * `code` is a parameter because the same rule guards two boundaries with two
 * taxonomies: a live command argument (`CLAIM_REJECTED`) and a restored
 * snapshot field (`INVALID_SNAPSHOT`).
 */
export function assertSurvivalStake(
  value: unknown,
  path: string,
  code: 'CLAIM_REJECTED' | 'INVALID_SNAPSHOT' = 'CLAIM_REJECTED',
): asserts value is bigint {
  if (typeof value !== 'bigint' || value <= 0n) fail(code, 'Stake must be a positive BigInt', path);
  if (bitWidth(value) > SURVIVAL_LIMITS.maxStakeBits)
    fail(code, `Stake must fit in ${SURVIVAL_LIMITS.maxStakeBits} bits`, path);
}

/** A bank subset: ascending, distinct, and inside the definition's entity space. */
export function assertEntitySubset(
  value: unknown,
  definition: SurvivalDefinition,
  path: string,
): asserts value is readonly number[] {
  if (!Array.isArray(value) || value.length > definition.entities)
    fail('INVALID_CHOICE', 'Entity subset is not a bounded array', path);
  let previous = -1;
  value.forEach((entity, index) => {
    if (!Number.isSafeInteger(entity) || entity < 0 || entity >= definition.entities)
      fail('INVALID_CHOICE', 'Unknown entity', `${path}[${index}]`);
    if (entity <= previous)
      fail('INVALID_CHOICE', 'Entity subset must be ascending and distinct', `${path}[${index}]`);
    previous = entity as number;
  });
}

export function assertSurvivalChoice(
  value: unknown,
  definition: SurvivalDefinition,
  path: string,
): asserts value is SurvivalChoice {
  if (!isRecord(value)) fail('INVALID_CHOICE', 'Expected a stage choice', path);
  if (typeof value.contractId !== 'string')
    fail('INVALID_CHOICE', 'Stage choice must name a contract', `${path}.contractId`);
  assertEntitySubset(value.banked, definition, `${path}.banked`);
}

export { byteLength };
