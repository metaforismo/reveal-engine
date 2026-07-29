import type { ConformanceFailure, ModuleConformanceCheck } from '../../core/module.js';
import { add, equal, rational } from '../../core/rational.js';
import { COMMITMENT_VERSION, type RoundContext } from './contracts.js';
import { makeTranscript, verifyTranscriptDetailed } from './fairness.js';
import { posteriorFor, probability } from './posterior.js';
import type { ProgressiveMarketShape } from './shape.js';
import { assertDerivedEvidence } from './validation.js';

type Check = ModuleConformanceCheck<ProgressiveMarketShape>;

function bigintJson(_: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** A declarative adapter graph must be frozen before it can be trusted for replay. */
const frozenGraph: Check = {
  code: 'NOT_DEEP_FROZEN',
  description: 'Adapter declarative graph is deeply frozen',
  scope: 'definition',
  run({ definition: game }) {
    return Object.isFrozen(game) &&
      Object.isFrozen(game.outcomes) &&
      Object.isFrozen(game.priorWeights) &&
      Object.isFrozen(game.evidence) &&
      Object.isFrozen(game.pricing) &&
      Object.isFrozen(game.risk)
      ? []
      : [
          {
            code: 'NOT_DEEP_FROZEN',
            path: '$',
            message: 'Adapter declarative graph must be frozen',
          },
        ];
  },
};

/**
 * Sweeps every truth for one seed.
 *
 * Derivation must be deterministic, must return frozen data, and — critically —
 * must not leak the truth through likelihood strength or labels. An adapter
 * whose spike pattern differs by truth would let a player read the answer off
 * the evidence stream.
 */
const truthSweep: Check = {
  code: 'TRUTH_SWEEP',
  description: 'Evidence derivation is deterministic, frozen, and truth-independent in structure',
  scope: 'round',
  run({ definition: game, seedHex, roundId, seedIndex, count }) {
    const failures: ConformanceFailure[] = [];
    const context: RoundContext = { gameId: game.id, roundId, proofVersion: COMMITMENT_VERSION };
    let structural: string | undefined;
    for (let truth = 0; truth < game.outcomes.length; truth += 1) {
      const first = game.evidence.derive(seedHex, context, truth);
      const second = game.evidence.derive(seedHex, context, truth);
      assertDerivedEvidence(game, first);
      assertDerivedEvidence(game, second);
      count('truthsSwept');
      if (!Object.isFrozen(first) || first.some((event) => !Object.isFrozen(event)))
        failures.push({
          code: 'MUTABLE_DERIVATION',
          path: '$.evidence.derive',
          message: 'Derived arrays and events must be frozen',
        });
      const encodedFirst = JSON.stringify(first, bigintJson);
      if (encodedFirst !== JSON.stringify(second, bigintJson))
        failures.push({
          code: 'NON_DETERMINISTIC',
          path: '$.evidence.derive',
          message: `Seed ${seedIndex}, truth ${truth}`,
        });
      const shape = JSON.stringify(
        first.map((event) => [
          event.index,
          event.favour.toString(),
          event.other.toString(),
          event.label,
        ]),
      );
      if (structural !== undefined && shape !== structural)
        failures.push({
          code: 'TRUTH_DEPENDENT_MODEL',
          path: '$.evidence.derive',
          message: 'Likelihood schedule changes with truth',
        });
      structural = shape;
    }
    return failures;
  },
};

/** A freshly built transcript must verify against its own seed by pure re-derivation. */
const transcriptRoundTrip: Check = {
  code: 'TRANSCRIPT_ROUND_TRIP',
  description: 'Committed transcript re-derives and verifies from the revealed seed',
  scope: 'round',
  run({ definition: game, seedHex, roundId, count }) {
    const transcript = makeTranscript(seedHex, game, roundId);
    count('transcripts');
    const verification = verifyTranscriptDetailed(seedHex, game, transcript);
    return verification.ok
      ? []
      : [
          {
            code: verification.code,
            path: verification.path,
            message: verification.message,
          },
        ];
  },
};

/** Exact rational probabilities must sum to exactly one, not to one within epsilon. */
const normalizedPosterior: Check = {
  code: 'PROBABILITY_NOT_NORMALIZED',
  description: 'Posterior probabilities sum to exactly one',
  scope: 'round',
  run({ definition: game, seedHex, roundId }) {
    const transcript = makeTranscript(seedHex, game, roundId);
    const posterior = posteriorFor(game, transcript.evidence);
    const sum = game.outcomes.reduce(
      (current, _, outcome) => add(current, probability(posterior, outcome)),
      rational(0n),
    );
    return equal(sum, rational(1n))
      ? []
      : [
          {
            code: 'PROBABILITY_NOT_NORMALIZED',
            path: '$.posterior',
            message: 'Posterior probabilities do not sum to one',
          },
        ];
  },
};

export const PROGRESSIVE_MARKET_CHECKS: readonly Check[] = Object.freeze([
  frozenGraph,
  truthSweep,
  transcriptRoundTrip,
  normalizedPosterior,
]);
