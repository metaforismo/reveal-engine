import { fail } from '../../api/errors.js';
import { divide, multiply, rational, type Rational } from '../../core/rational.js';
import { reduceWeights, weightVector, type WeightVector } from '../../core/weights.js';
import { adapterFingerprint, assertPosteriorForGame } from './adapter.js';
import type { EvidenceEvent, GameDefinition, Posterior, PriceQuote } from './contracts.js';
import {
  assertEvidenceEvent,
  assertGameDefinition,
  assertPosterior,
  assertRational,
} from './validation.js';

function validateIndex(index: number, length: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length)
    fail('UNKNOWN_OUTCOME', 'Unknown outcome index', '$.outcome');
}

export function initialPosterior(game: GameDefinition): Posterior {
  assertGameDefinition(game);
  const weights = Object.freeze([...game.priorWeights]);
  return Object.freeze({
    adapterId: game.id,
    adapterVersion: game.adapterVersion,
    adapterFingerprint: adapterFingerprint(game),
    weights,
    total: weights.reduce((a, b) => a + b, 0n),
  });
}

/** Exact Bayesian update: multiply, then divide out the common factor. No floats. */
export function updatePosterior(previous: Posterior, event: EvidenceEvent): Posterior {
  assertPosterior(previous);
  validateIndex(event.target, previous.weights.length);
  assertEvidenceEvent(event, previous.weights.length);
  const weights = reduceWeights(
    previous.weights.map((w, i) => w * (i === event.target ? event.favour : event.other)),
  );
  return Object.freeze({
    adapterId: previous.adapterId,
    adapterVersion: previous.adapterVersion,
    adapterFingerprint: previous.adapterFingerprint,
    weights: Object.freeze(weights),
    total: weights.reduce((a, b) => a + b, 0n),
  });
}

export function posteriorFor(game: GameDefinition, events: readonly EvidenceEvent[]): Posterior {
  assertGameDefinition(game);
  if (events.length > game.evidence.eventCount)
    fail('INVALID_EVIDENCE', 'Evidence exceeds declared schedule length', '$.events');
  return events.reduce((posterior, event, index) => {
    assertEvidenceEvent(event, game.outcomes.length, index, `$.events[${index}]`);
    return updatePosterior(posterior, event);
  }, initialPosterior(game));
}

/** Adapter-bound posterior as a core weight vector, for module-agnostic consumers. */
export function posteriorWeights(posterior: Posterior): WeightVector {
  assertPosterior(posterior);
  return weightVector(posterior.weights);
}

export function probability(posterior: Posterior, outcome: number): Rational {
  assertPosterior(posterior);
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
  assertGameDefinition(game);
  assertPosteriorForGame(posterior, game);
  if (!Number.isSafeInteger(frameRevision) || frameRevision < 0)
    fail(
      'INVALID_POSTERIOR',
      'Frame revision must be a non-negative safe integer',
      '$.frameRevision',
    );
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
  if (contingentPayout < 0n) fail('INVALID_RATIONAL', 'Negative payout', '$.contingentPayout');
  assertPosterior(posterior);
  assertRational(spread, '$.spread');
  if (spread.numerator < 0n || spread.numerator >= spread.denominator)
    fail('INVALID_RATIONAL', 'Spread must be in [0,1)', '$.spread');
  return multiply(
    multiply(rational(contingentPayout), probability(posterior, outcome)),
    rational(spread.denominator - spread.numerator, spread.denominator),
  );
}

export function fairValueClaim(
  contingentPayout: Rational,
  posterior: Posterior,
  outcome: number,
  spread: Rational,
): Rational {
  assertRational(contingentPayout, '$.contingentPayout');
  if (contingentPayout.numerator < 0n)
    fail('INVALID_RATIONAL', 'Negative payout', '$.contingentPayout');
  assertPosterior(posterior);
  assertRational(spread, '$.spread');
  if (spread.numerator < 0n || spread.numerator >= spread.denominator)
    fail('INVALID_RATIONAL', 'Spread must be in [0,1)', '$.spread');
  return multiply(
    multiply(contingentPayout, probability(posterior, outcome)),
    rational(spread.denominator - spread.numerator, spread.denominator),
  );
}

export function validateGame(game: GameDefinition): void {
  assertGameDefinition(game);
}
