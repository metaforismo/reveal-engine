import { RevealEngineError, asRevealEngineError } from '../api/errors.js';
import { adapterFingerprint } from '../core/adapter.js';
import { COMMITMENT_VERSION, type GameDefinition, type RoundContext } from '../core/contracts.js';
import { makeTranscript, verifyTranscriptDetailed } from '../core/fairness.js';
import { posteriorFor, probability } from '../core/posterior.js';
import { add, equal, rational } from '../core/rational.js';
import { assertDerivedEvidence, assertGameDefinition } from '../core/validation.js';

export interface ConformanceFailure {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}
export interface ConformanceReport {
  readonly schema: 'reveal-engine/adapter-conformance-v1';
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly fingerprint: string;
  readonly seeds: number;
  readonly transcripts: number;
  readonly ok: boolean;
  readonly failures: readonly ConformanceFailure[];
}

export function checkAdapterConformance(game: GameDefinition, seedCount = 8): ConformanceReport {
  const failures: ConformanceFailure[] = [];
  let fingerprint = '';
  let transcripts = 0;
  try {
    assertGameDefinition(game);
    fingerprint = adapterFingerprint(game);
    if (
      !Object.isFrozen(game) ||
      !Object.isFrozen(game.outcomes) ||
      !Object.isFrozen(game.priorWeights) ||
      !Object.isFrozen(game.evidence) ||
      !Object.isFrozen(game.pricing) ||
      !Object.isFrozen(game.risk)
    )
      failures.push({
        code: 'NOT_DEEP_FROZEN',
        path: '$',
        message: 'Adapter declarative graph must be frozen',
      });
    for (let seedIndex = 0; seedIndex < seedCount; seedIndex += 1) {
      const seed = seedIndex.toString(16).padStart(64, '0');
      const roundId = `conformance-${seedIndex}`;
      const context: RoundContext = { gameId: game.id, roundId, proofVersion: COMMITMENT_VERSION };
      let structural: string | undefined;
      for (let truth = 0; truth < game.outcomes.length; truth += 1) {
        const first = game.evidence.derive(seed, context, truth);
        const second = game.evidence.derive(seed, context, truth);
        assertDerivedEvidence(game, first);
        assertDerivedEvidence(game, second);
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
      const transcript = makeTranscript(seed, game, roundId);
      transcripts += 1;
      const verification = verifyTranscriptDetailed(seed, game, transcript);
      if (!verification.ok)
        failures.push({
          code: verification.code,
          path: verification.path,
          message: verification.message,
        });
      const posterior = posteriorFor(game, transcript.evidence);
      const sum = game.outcomes.reduce(
        (current, _, outcome) => add(current, probability(posterior, outcome)),
        rational(0n),
      );
      if (!equal(sum, rational(1n)))
        failures.push({
          code: 'PROBABILITY_NOT_NORMALIZED',
          path: '$.posterior',
          message: 'Posterior probabilities do not sum to one',
        });
    }
  } catch (error) {
    const failure =
      error instanceof RevealEngineError
        ? error
        : asRevealEngineError(error, 'INVALID_ADAPTER', 'Conformance failed');
    failures.push({ code: failure.code, path: failure.path, message: failure.message });
  }
  return Object.freeze({
    schema: 'reveal-engine/adapter-conformance-v1',
    adapterId: typeof game?.id === 'string' ? game.id : '<invalid>',
    adapterVersion: typeof game?.adapterVersion === 'string' ? game.adapterVersion : '<invalid>',
    fingerprint,
    seeds: seedCount,
    transcripts,
    ok: failures.length === 0,
    failures: Object.freeze(failures),
  });
}

export function assertAdapterConforms(game: GameDefinition, seedCount = 8): ConformanceReport {
  const report = checkAdapterConformance(game, seedCount);
  if (!report.ok)
    throw new RevealEngineError(
      'INVALID_ADAPTER',
      `Adapter conformance failed: ${report.failures.map((failure) => `${failure.code}@${failure.path}`).join(', ')}`,
    );
  return report;
}
function bigintJson(_: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
