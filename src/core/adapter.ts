import { createHash } from 'node:crypto';
import { encodeFields } from '../internal/canonical.js';
import { assertGameDefinition } from './validation.js';
import type { GameDefinition, Posterior } from './contracts.js';
import { fail } from '../api/errors.js';
import { assertPosterior } from './validation.js';

export function adapterFingerprint(game: GameDefinition): string {
  assertGameDefinition(game);
  const continuation = game.risk.continuation;
  const fields: Array<string | bigint | number> = [
    game.apiVersion,
    game.id,
    game.adapterVersion,
    game.evidence.modelVersion,
    game.evidence.eventCount,
    game.outcomes.length,
  ];
  game.outcomes.forEach((outcome, index) =>
    fields.push(index, outcome, game.priorWeights[index] ?? 0n),
  );
  fields.push(
    game.pricing.firstEntryRtp.numerator,
    game.pricing.firstEntryRtp.denominator,
    game.pricing.liquidationSpread.numerator,
    game.pricing.liquidationSpread.denominator,
    game.pricing.rounding,
    game.risk.maxWinMultiple,
    continuation ? 1 : 0,
  );
  if (continuation)
    fields.push(
      continuation.maxRides,
      continuation.rtpFloor.numerator,
      continuation.rtpFloor.denominator,
    );
  return createHash('sha256').update(encodeFields(fields)).digest('hex');
}

/** The only supported adapter construction path; clones and deep-freezes declarative state. */
export function defineGame(input: GameDefinition): GameDefinition {
  assertGameDefinition(input);
  const game: GameDefinition = {
    apiVersion: input.apiVersion,
    adapterVersion: input.adapterVersion,
    id: input.id,
    outcomes: Object.freeze([...input.outcomes]),
    priorWeights: Object.freeze([...input.priorWeights]),
    evidence: Object.freeze({
      modelVersion: input.evidence.modelVersion,
      eventCount: input.evidence.eventCount,
      derive: input.evidence.derive,
    }),
    pricing: Object.freeze({
      firstEntryRtp: Object.freeze({ ...input.pricing.firstEntryRtp }),
      liquidationSpread: Object.freeze({ ...input.pricing.liquidationSpread }),
      rounding: input.pricing.rounding,
    }),
    risk: Object.freeze({
      maxWinMultiple: input.risk.maxWinMultiple,
      ...(input.risk.continuation
        ? {
            continuation: Object.freeze({
              maxRides: input.risk.continuation.maxRides,
              rtpFloor: Object.freeze({ ...input.risk.continuation.rtpFloor }),
            }),
          }
        : {}),
    }),
  };
  assertGameDefinition(game);
  adapterFingerprint(game);
  return Object.freeze(game);
}

export function assertPosteriorForGame(
  posterior: unknown,
  game: GameDefinition,
  path = '$.posterior',
): asserts posterior is Posterior {
  assertGameDefinition(game);
  assertPosterior(posterior, undefined, path);
  if (
    posterior.adapterId !== game.id ||
    posterior.adapterVersion !== game.adapterVersion ||
    posterior.adapterFingerprint !== adapterFingerprint(game)
  )
    fail('ADAPTER_MISMATCH', 'Posterior was produced for a different adapter', path);
  assertPosterior(posterior, game.outcomes.length, path);
}
