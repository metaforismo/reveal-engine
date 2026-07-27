import { floor, type Rational } from './rational.js';
import type { Payable } from './contracts.js';
/** Applies the cap at every credit boundary, including sell and settlement. */
export function payable(
  theoretical: Rational,
  originalStake: bigint,
  maxWinMultiple: bigint,
): Payable {
  if (originalStake <= 0n || maxWinMultiple <= 0n) throw new RangeError('Invalid cap basis');
  const uncapped = floor(theoretical);
  const ceiling = originalStake * maxWinMultiple;
  return Object.freeze({
    theoretical,
    credited: uncapped > ceiling ? ceiling : uncapped,
    capped: uncapped > ceiling,
  });
}
