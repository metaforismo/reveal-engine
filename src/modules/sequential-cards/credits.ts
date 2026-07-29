import { fail } from '../../api/errors.js';
import { samplerScopeOf, type RoundIdentity } from '../../core/module.js';
import { normalizeSeed, sha256Hex, uniformBigInt } from '../../core/random.js';
import { floor as floorRational, type Rational } from '../../core/rational.js';
import { COMMITMENT_VERSION } from '../../core/versions.js';
import { encodeFields } from '../../internal/canonical.js';
import type { SequentialCardsDefinition } from './contracts.js';

/**
 * The credit boundary: where an exact rational claim becomes whole credits.
 *
 * This is the **only** place in the module a rational becomes an integer, and
 * `pricing.rounding` is the economic parameter that decides how. Two rules are
 * implemented and they are not two spellings of one thing:
 *
 * - **`floor`** keeps the fractional part. Every credit event is biased against
 *   the player by exactly `r/d`, so the realised return in credits is strictly
 *   below `entryRtp` at every finite stake and has to be bounded by a minimum
 *   stake.
 * - **`stochastic`** pays `q + 1` with probability exactly `r/d` and `q`
 *   otherwise. `E[credits] = q·(d−r)/d + (q+1)·r/d = q + r/d`, the claim itself,
 *   so the bias is exactly zero and the realised return equals the exact one at
 *   every stake and under every policy. `triad/docs/MATH.md` §13.2 prices both
 *   and §13.3 is the settlement draw this implements.
 *
 * `ceiling` remains declarable and unimplemented: it publishes an RTP the game
 * does not pay, with `floor`'s defect and the sign flipped, and it is farmable
 * at the minimum stake.
 *
 * ## Where the draw comes from, and why it is not the round seed
 *
 * A draw has to be a deterministic function of committed randomness or it is not
 * verifiable, and `CardsBook` deliberately **holds no round seed** — a book that
 * held one would be holding it before the reveal it is supposed to commit to
 * (§6.2). So the book is handed a `roundingSeed`: `H('cards-rounding-seed' ‖
 * version ‖ definitionFingerprint ‖ roundId ‖ seed)`, a one-way derivative of
 * the sealed round seed under a label disjoint from `cards:deal` and
 * `cards:selector`. It reveals nothing about the deal — inverting it is
 * inverting SHA-256 — and it re-derives at settlement from the revealed seed, so
 * `settle` refuses a round whose credits came from a different tape.
 *
 * **It is a round secret until then, on the same footing as the round seed.**
 * A uniform draw in `[0, d)` is necessarily a function of `d`, so a party who
 * knows the rounding seed can compute the draw for each claim a decision window
 * offers and take the branch that pays the extra credit. The edge is bounded by
 * **one credit per credit event** and it is real at the minimum stake, where one
 * credit can be most of a small payout. The module cannot see whether a host
 * leaked the tape, so this is stated as a host obligation in
 * `docs/integration-checklist.md` rather than implied to be closed.
 */

/** Sampler label for the settlement draw. Disjoint from the deal and the selectors. */
export const CARDS_CREDIT_LABEL = 'cards:credit';

/** The largest denominator a draw can be taken over; `uniformBigInt`'s own bound. */
const MAX_DRAW_MODULUS = 1n << 256n;

/**
 * Identifies one credit event inside a round.
 *
 * `triad/docs/ENGINE.md` §5.5 requires the ordering to be by market selection id
 * and then by ledger sequence, and requires it not to be the host's to choose.
 * Both are true here: the selection id comes from the ticket and the sequence is
 * the receipt's own `ledgerRevision`, so two credit events in one round cannot
 * collide even when one settlement receipt credits several rows at once.
 */
export interface CreditEvent {
  readonly selectionId: string;
  readonly sequence: number;
}

/** The committed tape a stochastic round draws its settlement credits from. */
export interface CreditTape {
  readonly roundingSeed: string;
  readonly round: RoundIdentity;
}

/** One conversion, with everything a verifier needs to re-derive it. */
export interface CreditConversion {
  readonly whole: bigint;
  readonly remainder: bigint;
  readonly denominator: bigint;
  /** The uniform draw in `[0, denominator)`, or `null` under a deterministic rule. */
  readonly draw: bigint | null;
  readonly credits: bigint;
}

/**
 * The rounding seed for one round: a one-way derivative of the sealed seed.
 *
 * Taking the definition fingerprint means two definitions that differ in any
 * declarative field — the rounding rule included — never share a tape, and
 * taking the round id means two rounds under one seed never do either.
 */
export function deriveRoundingSeed(
  seedHex: string,
  definitionFingerprint: string,
  roundId: string,
): string {
  const seed = normalizeSeed(seedHex);
  if (!/^[0-9a-f]{64}$/u.test(definitionFingerprint))
    fail(
      'INVALID_CONTEXT',
      'Definition fingerprint must be 32 bytes of hexadecimal',
      '$.fingerprint',
    );
  if (typeof roundId !== 'string' || roundId.length === 0)
    fail('INVALID_CONTEXT', 'A rounding seed needs the round it belongs to', '$.roundId');
  return sha256Hex(
    encodeFields([
      'cards-rounding-seed',
      COMMITMENT_VERSION,
      definitionFingerprint,
      roundId,
      Buffer.from(seed, 'hex'),
    ]),
  );
}

/**
 * The public commitment to a rounding tape.
 *
 * Bound into the `open` receipt's fingerprint so a snapshot cannot swap the tape
 * a round's credits were drawn from, and safe to publish: it is a hash of a hash
 * of the seed.
 */
export function roundingCommitment(roundingSeed: string): string {
  return sha256Hex(
    encodeFields([
      'cards-rounding-commitment',
      COMMITMENT_VERSION,
      Buffer.from(normalizeSeed(roundingSeed), 'hex'),
    ]),
  );
}

/**
 * The uniform draw for one credit event, in `[0, denominator)`.
 *
 * Two-step by design. The event seed binds the selection id and the ledger
 * sequence into 32 bytes, and `uniformBigInt` then does exact rejection sampling
 * against the denominator — so a selection id of any legal length cannot
 * overflow a sampler label, and two rows credited by one settlement receipt draw
 * independently.
 */
export function creditDraw(tape: CreditTape, event: CreditEvent, denominator: bigint): bigint {
  if (typeof event.selectionId !== 'string' || event.selectionId.length === 0)
    fail('INVALID_CONTEXT', 'A credit event names the selection it credits', '$.selectionId');
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0)
    fail('INVALID_CONTEXT', 'A credit event sequence must be a non-negative integer', '$.sequence');
  if (denominator <= 0n || denominator >= MAX_DRAW_MODULUS)
    fail('INVALID_RATIONAL', 'A settlement draw needs a denominator inside the sampler bound');
  const eventSeed = sha256Hex(
    encodeFields([
      'cards-credit-draw',
      COMMITMENT_VERSION,
      Buffer.from(normalizeSeed(tape.roundingSeed), 'hex'),
      tape.round.moduleId,
      tape.round.definitionId,
      tape.round.roundId,
      event.selectionId,
      event.sequence,
    ]),
  );
  return uniformBigInt(
    eventSeed,
    samplerScopeOf(tape.round),
    CARDS_CREDIT_LABEL,
    event.sequence,
    denominator,
  );
}

/**
 * The credits a draw buys, given the claim it is drawn against.
 *
 * Separated from `convertToCredits` so a conformance check can sweep the whole
 * draw space of a claim and count how many values pay the extra credit. That
 * count has to be exactly the remainder, and counting it through this function
 * is what makes `E[credits] = claim` evidence rather than a restatement of the
 * comparison operator.
 */
export function creditsFromDraw(claim: Rational, draw: bigint): bigint {
  const whole = floorRational(claim);
  const remainder = claim.numerator - whole * claim.denominator;
  if (draw < 0n || draw >= claim.denominator)
    fail('INVALID_RATIONAL', 'A settlement draw is outside the claim denominator', '$.draw');
  return whole + (draw < remainder ? 1n : 0n);
}

/**
 * Converts one exact claim to credits under the definition's declared rule.
 *
 * A stochastic definition without a tape is a **failure**, never a silent
 * fallback to flooring: the two rules pay differently, both are inside the
 * definition fingerprint, and a round that quietly credited under the other one
 * would be paying an economics nobody declared.
 */
export function convertToCredits(
  definition: SequentialCardsDefinition,
  claim: Rational,
  event: CreditEvent,
  tape: CreditTape | undefined,
): CreditConversion {
  const whole = floorRational(claim);
  const denominator = claim.denominator;
  const remainder = claim.numerator - whole * denominator;
  if (definition.pricing.rounding === 'floor')
    return Object.freeze({ whole, remainder, denominator, draw: null, credits: whole });
  if (definition.pricing.rounding !== 'stochastic')
    fail(
      'INVALID_ADAPTER',
      `Rounding rule '${String(definition.pricing.rounding)}' is not implemented`,
      '$.pricing.rounding',
      { reason: 'INVALID_ROUNDING_POLICY' },
    );
  if (tape === undefined)
    fail(
      'CLAIM_REJECTED',
      'This definition credits with the settlement draw and the round has no committed tape',
      '$.roundingSeed',
      { reason: 'INVALID_ROUNDING_POLICY' },
    );
  // A whole claim needs no draw at all, which is not an optimisation: it is the
  // reason `triad`'s 25-credit stake lattice exists, so the main line of the
  // main market never touches the mechanism.
  if (remainder === 0n)
    return Object.freeze({ whole, remainder, denominator, draw: null, credits: whole });
  const draw = creditDraw(tape, event, denominator);
  return Object.freeze({
    whole,
    remainder,
    denominator,
    draw,
    credits: creditsFromDraw(claim, draw),
  });
}
