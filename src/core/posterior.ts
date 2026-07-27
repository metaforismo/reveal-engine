import { divide, multiply, rational, type Rational } from './rational.js';
import type { EvidenceEvent, GameDefinition, Posterior, PriceQuote } from './contracts.js';

function validateIndex(index: number, length: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length)
    throw new RangeError('Unknown outcome index');
}
function reduce(weights: bigint[]): bigint[] {
  let a = weights[0] ?? 0n;
  for (let i = 1; i < weights.length; i += 1) {
    let b = weights[i] ?? 0n;
    while (b !== 0n) [a, b] = [b, a % b];
  }
  return a > 1n ? weights.map((w) => w / a) : weights;
}
export function initialPosterior(game: GameDefinition): Posterior {
  validateGame(game);
  const weights = Object.freeze([...game.priorWeights]);
  return Object.freeze({ weights, total: weights.reduce((a, b) => a + b, 0n) });
}
export function updatePosterior(previous: Posterior, event: EvidenceEvent): Posterior {
  validateIndex(event.target, previous.weights.length);
  if (event.favour <= 0n || event.other <= 0n)
    throw new RangeError('Evidence likelihoods must be positive');
  const weights = reduce(
    previous.weights.map((w, i) => w * (i === event.target ? event.favour : event.other)),
  );
  return Object.freeze({
    weights: Object.freeze(weights),
    total: weights.reduce((a, b) => a + b, 0n),
  });
}
export function posteriorFor(game: GameDefinition, events: readonly EvidenceEvent[]): Posterior {
  return events.reduce(updatePosterior, initialPosterior(game));
}
export function probability(posterior: Posterior, outcome: number): Rational {
  validateIndex(outcome, posterior.weights.length);
  return rational(posterior.weights[outcome] ?? 0n, posterior.total);
}
export function quote(
  game: GameDefinition,
  posterior: Posterior,
  outcome: number,
  firstEntry: boolean,
  frameRevision: number,
): PriceQuote {
  const p = probability(posterior, outcome);
  const multiplier = firstEntry ? divide(game.pricing.firstEntryRtp, p) : divide(rational(1n), p);
  return Object.freeze({ frameRevision, outcome, firstEntry, multiplier });
}
export function fairValue(
  contingentPayout: bigint,
  posterior: Posterior,
  outcome: number,
  spread: Rational,
): Rational {
  if (contingentPayout < 0n) throw new RangeError('Negative payout');
  return multiply(
    multiply(rational(contingentPayout), probability(posterior, outcome)),
    rational(spread.denominator - spread.numerator, spread.denominator),
  );
}
export function validateGame(game: GameDefinition): void {
  if (game.outcomes.length < 2 || game.outcomes.length !== game.priorWeights.length)
    throw new RangeError('Game needs matching arrays with >=2 outcomes');
  if (
    new Set(game.outcomes).size !== game.outcomes.length ||
    game.priorWeights.some((w) => w <= 0n)
  )
    throw new RangeError('Outcomes must be unique and prior weights positive');
  if (
    game.pricing.firstEntryRtp.numerator <= 0n ||
    game.pricing.firstEntryRtp.numerator > game.pricing.firstEntryRtp.denominator ||
    game.pricing.liquidationSpread.numerator < 0n ||
    game.pricing.liquidationSpread.numerator >= game.pricing.liquidationSpread.denominator
  )
    throw new RangeError('Invalid pricing policy');
  if (game.risk.maxWinMultiple <= 0n) throw new RangeError('Invalid max win');
}
