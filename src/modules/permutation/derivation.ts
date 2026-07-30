import { fail } from '../../api/errors.js';
import { constantTimeHexEqual, sealCommitment } from '../../core/commitment.js';
import { samplerScopeOf, type RoundIdentity } from '../../core/module.js';
import { uniformPermutation } from '../../core/random.js';
import {
  classifyVerificationError,
  verificationFailure,
  verificationSuccess,
  type VerificationResult,
} from '../../core/verification.js';
import { COMMITMENT_VERSION } from '../../core/versions.js';
import { encodeFields, type CanonicalField } from '../../internal/canonical.js';
import { definitionFields, permutationFingerprint } from './definition.js';
import {
  PERMUTATION_MODULE_ID,
  PERMUTATION_TRANSCRIPT_SCHEMA,
  type PermutationDefinition,
  type PermutationOrder,
  type PermutationStep,
  type PermutationTranscript,
} from './contracts.js';
import { deserializePermutationTranscript } from './transcript.js';
import { assertPermutationDefinition } from './validation.js';

/**
 * The sampler domain for a round: the definition id, the round id, the scheme.
 *
 * `samplerScopeOf` uses `definitionId` as the domain and drops `moduleId`, so
 * two rounds of one game never share a draw by construction, while separation
 * between two *modules* rests on definition ids being unique across the
 * registry. That is an operational property, not a structural one; the
 * commitment body binds the module id regardless, so a collision would still
 * yield non-interchangeable proofs. See `docs/modules/permutation.md` §2.
 */
export function permutationRound(
  definition: PermutationDefinition,
  roundId: string,
): RoundIdentity {
  return Object.freeze({
    moduleId: PERMUTATION_MODULE_ID,
    definitionId: definition.id,
    fingerprint: permutationFingerprint(definition),
    roundId,
    proofVersion: COMMITMENT_VERSION,
  });
}

/**
 * The hidden truth: a uniform permutation of the declared items.
 *
 * `uniformPermutation` is core's seeded Fisher-Yates over core's rejection
 * sampler, and this module uses it unmodified. That is the whole point of the
 * boundary: modulo bias and domain reuse are the classic RNG failures and there
 * is exactly one implementation of the fix in this repository. Uniformity then
 * rests on three facts, each with its own evidence:
 *
 * 1. the shuffle is a bijection from draw vectors onto `S_n` —
 *    `SHUFFLE_NOT_BIJECTIVE`, by exhaustive enumeration;
 * 2. the sampler is unbiased for every modulus —
 *    `tests/sampler-unbiased.test.ts`, which checks the acceptance boundary,
 *    drives the rejection branch at a modulus that rejects half of all draws,
 *    and chi-squares the residues;
 * 3. **this function is the composition of the two** —
 *    `DERIVATION_OFF_SCHEDULE` and `tests/shuffle-uniformity.test.ts`, which
 *    re-derive the order from the raw sampler under the declared schedule and
 *    require this call to agree.
 *
 * The third is not pedantry. Facts 1 and 2 are both about something other than
 * this function, and with only those two in place a naive-bias edit to
 * `core/random.ts` passed conformance completely. See
 * `docs/modules/permutation.md` §2.
 *
 * Pure in `(seed, definition, roundId)`: an operator holding a published
 * commitment cannot change what it opens to, and no player decision reaches it.
 */
export function derivePermutationOrder(
  seedHex: string,
  definition: PermutationDefinition,
  roundId: string,
): PermutationOrder {
  assertPermutationDefinition(definition);
  return uniformPermutation(
    seedHex,
    samplerScopeOf(permutationRound(definition, roundId)),
    'order',
    definition.items.length,
  );
}

/**
 * The observable settle sequence: position 0 first, then 1, and so on.
 *
 * A round emits `n - 1` reveals, not `n`. The final position is forced — one
 * item remains and it has one place to go — so a step for it would carry no
 * information, and it would drive the marginal belief vector to all zeros, a
 * state `weightVector` correctly refuses as an impossible round. The settled
 * order in full is the truth, which is bound into the commitment body and
 * carried on the wire; a presentation layer renders the last slot from it.
 *
 * The schedule is a pure function of the truth and its *structure* — the
 * positions, in order, and how many there are — is identical for every truth. It
 * is only the items that differ, which is what stops the schedule leaking the
 * answer through its shape. `STEP_STRUCTURE_LEAKS_TRUTH` sweeps every one of the
 * `n!` truths and checks exactly that.
 */
export function derivePermutationSteps(
  definition: PermutationDefinition,
  order: PermutationOrder,
): readonly PermutationStep[] {
  assertPermutationDefinition(definition);
  assertOrder(definition, order);
  return Object.freeze(
    Array.from({ length: definition.items.length - 1 }, (_unused, position) =>
      Object.freeze({ position, item: order[position] as number }),
    ),
  );
}

/**
 * Rejects anything that is not a genuine permutation of the declared items.
 *
 * `steps.derive` and `transcript.commitmentBody` both take a truth from their
 * caller, and both are public. A short or repeating array would otherwise walk
 * straight into `encodeFields`, which has no opinion about what a truth is and
 * would surface a raw `TypeError` from inside the commitment layer — the one
 * place a typed error matters most, because a verifier has to classify it.
 */
function assertOrder(
  definition: PermutationDefinition,
  order: unknown,
  path = '$.truth',
): asserts order is PermutationOrder {
  const size = definition.items.length;
  if (!Array.isArray(order) || order.length !== size)
    fail('DERIVATION_FAILED', 'Truth must name every position exactly once', path);
  const seen = new Set<number>();
  // Indexed rather than `forEach`, which skips holes and would let `new
  // Array(n)` through with the right length and no entries at all.
  for (let position = 0; position < size; position += 1) {
    const item: unknown = order[position];
    if (
      !Number.isSafeInteger(item) ||
      (item as number) < 0 ||
      (item as number) >= size ||
      seen.has(item as number)
    )
      fail('DERIVATION_FAILED', 'Truth is not a permutation of the items', `${path}[${position}]`);
    seen.add(item as number);
  }
}

/**
 * The declared truth encoder.
 *
 * `commitmentBody` below composes this same function, so what the module
 * declares as `truth.encode` *is* the proof-bearing layout rather than a second
 * description of it that could drift.
 */
export function encodeOrder(order: PermutationOrder): readonly CanonicalField[] {
  if (!Array.isArray(order)) fail('DERIVATION_FAILED', 'Expected an order to encode', '$.truth');
  const fields: CanonicalField[] = [order.length];
  for (let position = 0; position < order.length; position += 1) {
    const item: unknown = order[position];
    // `encodeFields` has no opinion about what a truth is and would raise a raw
    // `TypeError` on a hole. The encoder is the last place before the bytes, so
    // it refuses rather than hands one down.
    if (!Number.isSafeInteger(item))
      fail('DERIVATION_FAILED', 'Order entry is not an integer', `$.truth[${position}]`);
    fields.push(item as number);
  }
  return Object.freeze(fields);
}

/** The declared step encoder; composed by `commitmentBody`, exactly as above. */
export function encodeStep(step: PermutationStep): readonly CanonicalField[] {
  if (
    typeof step !== 'object' ||
    step === null ||
    !Number.isSafeInteger(step.position) ||
    !Number.isSafeInteger(step.item)
  )
    fail('DERIVATION_FAILED', 'Expected a reveal to encode', '$.steps');
  return Object.freeze([step.position, step.item]);
}

export function ordersEqual(left: PermutationOrder, right: PermutationOrder): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  // Indexed, not `every`: a sparse array skips its holes, so two arrays that
  // agree only on the entries that exist would compare equal — and this
  // comparison is a verification phase.
  for (let position = 0; position < left.length; position += 1)
    if (left[position] !== right[position]) return false;
  return true;
}

export function stepsEqual(
  left: readonly PermutationStep[],
  right: readonly PermutationStep[],
): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (
      left[index]?.position !== right[index]?.position ||
      left[index]?.item !== right[index]?.item
    )
      return false;
  return true;
}

/**
 * The canonical bytes core seals under the seed.
 *
 * Binds the module id, the whole declarative definition and its fingerprint, the
 * round id, the proof version, the truth, and every step. Fields are
 * length-prefixed by `encodeFields`, so no two distinct rounds encode to the
 * same bytes. There is no choice log to bind: this module logs no player
 * decisions and rejects one that arrives anyway.
 */
export function permutationCommitmentBody(
  definition: PermutationDefinition,
  round: RoundIdentity,
  order: PermutationOrder,
  steps: readonly PermutationStep[],
): Buffer {
  assertPermutationDefinition(definition);
  assertOrder(definition, order);
  if (!Array.isArray(steps) || steps.length !== definition.items.length - 1)
    fail('DERIVATION_FAILED', 'A round seals exactly one reveal per settled position', '$.steps');
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (
      typeof step !== 'object' ||
      step === null ||
      step.position !== index ||
      !Number.isSafeInteger(step.item) ||
      step.item < 0 ||
      step.item >= definition.items.length
    )
      fail('DERIVATION_FAILED', 'Reveals must be a prefix in settle order', `$.steps[${index}]`);
  }
  return encodeFields([
    'Axiom Games Reveal Engine permutation commitment',
    COMMITMENT_VERSION,
    round.moduleId,
    ...definitionFields(definition),
    permutationFingerprint(definition),
    round.roundId,
    round.proofVersion,
    ...encodeOrder(order),
    steps.length,
    ...steps.flatMap((step) => [...encodeStep(step)]),
  ]);
}

export function makePermutationTranscript(
  seedHex: string,
  definition: PermutationDefinition,
  roundId: string,
): PermutationTranscript {
  assertPermutationDefinition(definition);
  const round = permutationRound(definition, roundId);
  const order = derivePermutationOrder(seedHex, definition, roundId);
  const reveals = derivePermutationSteps(definition, order);
  return Object.freeze({
    schema: PERMUTATION_TRANSCRIPT_SCHEMA,
    definition: Object.freeze({
      id: definition.id,
      version: definition.version,
      fingerprint: permutationFingerprint(definition),
    }),
    roundId,
    order,
    reveals,
    commitment: sealCommitment(
      seedHex,
      permutationCommitmentBody(definition, round, order, reveals),
    ),
  });
}

/**
 * Pure re-derivation verifier, in the contract's required phase order.
 *
 * Decode the wire form, check definition identity, re-derive the truth and
 * compare, re-derive the steps and compare, re-seal the commitment body and
 * compare in constant time. Every failure is one of the public verification
 * codes and every unexpected throw is classified: a verifier answers "is this
 * proof valid?" and never leaks a parser stack trace to do it.
 *
 * There is no seed pre-commitment phase because there are no logged choices:
 * `sealCommitment` over the finished round already predates every decision the
 * player can make, since the only decision is a ticket and the ticket is not an
 * input to the derivation.
 */
export function verifyPermutationTranscript(
  seedHex: string,
  definition: PermutationDefinition,
  input: unknown,
): VerificationResult {
  try {
    assertPermutationDefinition(definition);
    const transcript = deserializePermutationTranscript(input);
    if (
      transcript.definition.id !== definition.id ||
      transcript.definition.version !== definition.version ||
      !constantTimeHexEqual(transcript.definition.fingerprint, permutationFingerprint(definition))
    )
      return verificationFailure(
        'DEFINITION_MISMATCH',
        'Transcript belongs to another definition or fingerprint',
        '$.definition',
      );

    const round = permutationRound(definition, transcript.roundId);
    const order = derivePermutationOrder(seedHex, definition, transcript.roundId);
    if (!ordersEqual(order, transcript.order))
      return verificationFailure(
        'TRANSCRIPT_MISMATCH',
        'Re-derived order differs from the transcript',
        '$.order',
      );

    const reveals = derivePermutationSteps(definition, order);
    if (!stepsEqual(reveals, transcript.reveals))
      return verificationFailure(
        'TRANSCRIPT_MISMATCH',
        'Re-derived reveals differ from the transcript',
        '$.reveals',
      );

    const commitment = sealCommitment(
      seedHex,
      permutationCommitmentBody(definition, round, order, reveals),
    );
    if (!constantTimeHexEqual(commitment, transcript.commitment))
      return verificationFailure(
        'COMMITMENT_MISMATCH',
        'Commitment does not open to the revealed seed',
        '$.commitment',
      );
    return verificationSuccess(COMMITMENT_VERSION, commitment);
  } catch (error) {
    return classifyVerificationError(error);
  }
}
