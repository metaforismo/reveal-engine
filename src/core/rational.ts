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

export function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator === 0n) throw new RangeError('Zero denominator');
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  return Object.freeze({
    numerator: (sign * numerator) / divisor,
    denominator: (sign * denominator) / divisor,
  });
}
export function add(a: Rational, b: Rational): Rational {
  return rational(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}
export function multiply(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.numerator, a.denominator * b.denominator);
}
export function divide(a: Rational, b: Rational): Rational {
  if (b.numerator === 0n) throw new RangeError('Division by zero');
  return rational(a.numerator * b.denominator, a.denominator * b.numerator);
}
export function floor(a: Rational): bigint {
  if (a.numerator < 0n) throw new RangeError('Negative payable value');
  return a.numerator / a.denominator;
}
export function equal(a: Rational, b: Rational): boolean {
  return a.numerator === b.numerator && a.denominator === b.denominator;
}
