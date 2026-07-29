import { fail } from '../../../api/errors.js';

export type ElementIndex = number;
export type SlotIndex = number;
export type Permutation = readonly ElementIndex[];

export interface BetInstance<P extends object = object> {
  readonly code: string;
  readonly params: Readonly<P>;
  readonly label: string;
}

export interface OutcomeView {
  readonly n: number;
  readonly perm: Permutation;
  readonly pos: readonly SlotIndex[];
  readonly rank: number;
  readonly order: string;
}

export interface BetFamily<P extends object = object> {
  readonly code: string;
  readonly name: string;
  readonly tier: 'FLOW' | 'FORM' | 'ORDER';
  readonly picks: string;
  readonly rule: string;
  enumerateInstances(n: number): readonly BetInstance<P>[];
  resolve(instance: BetInstance<P>, view: OutcomeView): boolean;
}

export function factorialBig(n: number): bigint {
  if (!Number.isInteger(n) || n < 0) fail('INVALID_CONTEXT', 'Factorial needs n >= 0', '$.n');
  let result = 1n;
  for (let value = 2n; value <= BigInt(n); value += 1n) result *= value;
  return result;
}

export function factorial(n: number): number {
  const result = factorialBig(n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    fail('INVALID_CONTEXT', 'Factorial exceeds the safe integer range', '$.n');
  return Number(result);
}

export function allPermutations(n: number): readonly Permutation[] {
  if (!Number.isInteger(n) || n < 1 || n > 9)
    fail('INVALID_CONTEXT', 'Permutation enumeration supports n in [1, 9]', '$.n');
  const result: number[][] = [];
  const current: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const walk = (): void => {
    if (current.length === n) {
      result.push(Object.freeze([...current]) as number[]);
      return;
    }
    for (let element = 0; element < n; element += 1) {
      if (used[element]) continue;
      used[element] = true;
      current.push(element);
      walk();
      current.pop();
      used[element] = false;
    }
  };
  walk();
  return Object.freeze(result);
}

export function positionsOf(permutation: Permutation): readonly SlotIndex[] {
  const positions = new Array<number>(permutation.length);
  for (let slot = 0; slot < permutation.length; slot += 1)
    positions[permutation[slot] as number] = slot;
  return Object.freeze(positions);
}

export function orderKey(permutation: Permutation): string {
  return Array.prototype.join.call(permutation, '-') as string;
}

export function permutationRank(permutation: Permutation): number {
  let rank = 0;
  for (let index = 0; index < permutation.length; index += 1) {
    let smaller = 0;
    for (let later = index + 1; later < permutation.length; later += 1)
      if ((permutation[later] as number) < (permutation[index] as number)) smaller += 1;
    rank = rank * (permutation.length - index) + smaller;
  }
  return rank;
}

export function unrankPermutation(n: number, rank: number): Permutation {
  const total = factorial(n);
  if (!Number.isInteger(rank) || rank < 0 || rank >= total)
    fail('INVALID_CONTEXT', `Rank must be in [0, ${total})`, '$.rank');
  const available = Array.from({ length: n }, (_, index) => index);
  const result = new Array<number>(n);
  let remainder = rank;
  for (let index = 0; index < n; index += 1) {
    const block = factorial(n - index - 1);
    const selected = Math.floor(remainder / block);
    remainder -= selected * block;
    result[index] = available[selected] as number;
    available.splice(selected, 1);
  }
  return Object.freeze(result);
}

export function outcomeViewOf(permutation: Permutation, n = permutation.length): OutcomeView {
  const copy = Object.freeze(Array.prototype.slice.call(permutation) as number[]);
  return Object.freeze({
    n,
    perm: copy,
    pos: positionsOf(copy),
    rank: permutationRank(copy),
    order: orderKey(copy),
  });
}

export function allDrawVectors(n: number): readonly (readonly number[])[] {
  const ranges = Array.from({ length: n - 1 }, (_, index) => n - index);
  const current = new Array<number>(n - 1).fill(0);
  const result: (readonly number[])[] = [];
  for (;;) {
    result.push(Object.freeze([...current]));
    let index = n - 2;
    while (index >= 0) {
      current[index] = (current[index] as number) + 1;
      if ((current[index] as number) < (ranges[index] as number)) break;
      current[index] = 0;
      index -= 1;
    }
    if (index < 0) return Object.freeze(result);
  }
}

export function fisherYates(n: number, draws: readonly number[]): Permutation {
  if (draws.length !== n - 1) fail('INVALID_CONTEXT', 'Wrong shuffle draw count', '$.draws');
  const result = Array.from({ length: n }, (_, index) => index);
  for (let counter = 0; counter < n - 1; counter += 1) {
    const index = n - 1 - counter;
    const pick = draws[counter];
    if (!Number.isInteger(pick) || Number(pick) < 0 || Number(pick) > index)
      fail('INVALID_CONTEXT', 'Shuffle draw is out of range', `$.draws[${counter}]`);
    const saved = result[index] as number;
    result[index] = result[pick as number] as number;
    result[pick as number] = saved;
  }
  return Object.freeze(result);
}
