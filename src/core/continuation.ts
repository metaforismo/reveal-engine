import { fail } from '../api/errors.js';
import { multiply, rational, type Rational } from './rational.js';
import { assertRational } from './validation.js';

/**
 * Derives the largest continuation count n for which r^(n + 1) remains at or
 * above the configured RTP floor. The initial round is exponent one; each
 * continuation adds one independently-priced round.
 *
 * Adopted from `origin/agent/black-signal-adoption-bridge`; see
 * `docs/adr/0001-branch-adoption.md`.
 */
export function deriveMaxContinuations(
  roundRtp: Rational,
  rtpFloor: Rational,
  searchLimit = 64,
): number {
  assertRational(roundRtp, '$.roundRtp');
  assertRational(rtpFloor, '$.rtpFloor');
  if (roundRtp.numerator <= 0n || roundRtp.numerator > roundRtp.denominator)
    fail('INVALID_RATIONAL', 'Round RTP must be in (0,1]', '$.roundRtp');
  if (rtpFloor.numerator < 0n || rtpFloor.numerator > rtpFloor.denominator)
    fail('INVALID_RATIONAL', 'RTP floor must be in [0,1]', '$.rtpFloor');
  if (!Number.isSafeInteger(searchLimit) || searchLimit < 0 || searchLimit > 64)
    fail('INVALID_CONTEXT', 'Continuation search limit must be an integer in [0,64]');

  let worstCase = rational(roundRtp.numerator, roundRtp.denominator);
  for (let continuations = 0; continuations < searchLimit; continuations += 1) {
    const nextWorstCase = multiply(worstCase, roundRtp);
    if (
      nextWorstCase.numerator * rtpFloor.denominator <
      rtpFloor.numerator * nextWorstCase.denominator
    )
      return continuations;
    worstCase = nextWorstCase;
  }
  return searchLimit;
}
