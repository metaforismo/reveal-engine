import { fail } from '../api/errors.js';
import { floor, type Rational } from './rational.js';

export interface Payable {
  readonly theoretical: Rational;
  readonly credited: bigint;
  readonly capped: boolean;
}

/** Applies the cap at every credit boundary, including sell and settlement. */
export function payable(
  theoretical: Rational,
  originalStake: bigint,
  maxWinMultiple: bigint,
): Payable {
  if (originalStake <= 0n || maxWinMultiple <= 0n) fail('INVALID_RATIONAL', 'Invalid cap basis');
  const uncapped = floor(theoretical);
  const ceiling = originalStake * maxWinMultiple;
  return Object.freeze({
    theoretical,
    credited: uncapped > ceiling ? ceiling : uncapped,
    capped: uncapped > ceiling,
  });
}

/** Applies a chain cap while preserving value already withdrawn from the active claim. */
export function payableWithinCap(
  theoretical: Rational,
  originalStake: bigint,
  maxWinMultiple: bigint,
  alreadyLiquid: bigint,
): Payable {
  if (originalStake <= 0n || maxWinMultiple <= 0n || alreadyLiquid < 0n)
    fail('INVALID_RATIONAL', 'Invalid chain cap state');
  const uncapped = floor(theoretical);
  const ceiling = originalStake * maxWinMultiple;
  const remaining = ceiling > alreadyLiquid ? ceiling - alreadyLiquid : 0n;
  return Object.freeze({
    theoretical,
    credited: uncapped > remaining ? remaining : uncapped,
    capped: uncapped > remaining,
  });
}
