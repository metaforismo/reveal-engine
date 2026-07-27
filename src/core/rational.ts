import { fail } from '../api/errors.js';
import { ENGINE_LIMITS } from '../api/limits.js';

export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}
function checkBits(value: bigint): boolean {
  return (value < 0n ? -value : value).toString(2).length <= ENGINE_LIMITS.maxBigIntBits;
}
export function rational(numerator: bigint, denominator = 1n): Rational {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint')
    fail('INVALID_RATIONAL', 'Rational parts must be BigInts');
  if (denominator === 0n) fail('INVALID_RATIONAL', 'Zero denominator', '$.denominator');
  if (!checkBits(numerator) || !checkBits(denominator))
    fail('INVALID_RATIONAL', 'Rational exceeds the public BigInt limit');
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  return Object.freeze({
    numerator: (sign * numerator) / divisor,
    denominator: (sign * denominator) / divisor,
  });
}
function normalized(value: Rational): Rational {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.numerator !== 'bigint' ||
    typeof value.denominator !== 'bigint' ||
    value.denominator <= 0n
  )
    fail('INVALID_RATIONAL', 'Expected rational with a positive denominator');
  return rational(value.numerator, value.denominator);
}
export function add(a: Rational, b: Rational): Rational {
  a = normalized(a);
  b = normalized(b);
  return rational(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}
export function subtract(a: Rational, b: Rational): Rational {
  a = normalized(a);
  b = normalized(b);
  return rational(
    a.numerator * b.denominator - b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}
export function multiply(a: Rational, b: Rational): Rational {
  a = normalized(a);
  b = normalized(b);
  return rational(a.numerator * b.numerator, a.denominator * b.denominator);
}
export function divide(a: Rational, b: Rational): Rational {
  a = normalized(a);
  b = normalized(b);
  if (b.numerator === 0n) fail('INVALID_RATIONAL', 'Division by zero');
  return rational(a.numerator * b.denominator, a.denominator * b.numerator);
}
export function floor(a: Rational): bigint {
  a = normalized(a);
  if (a.numerator < 0n) fail('INVALID_RATIONAL', 'Negative payable value');
  return a.numerator / a.denominator;
}
export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  a = normalized(a);
  b = normalized(b);
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
export function equal(a: Rational, b: Rational): boolean {
  return compare(a, b) === 0;
}
