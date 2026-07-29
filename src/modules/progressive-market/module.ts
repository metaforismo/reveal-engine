import type { CanonicalField } from '../../internal/canonical.js';
import {
  defineLifecycleModule,
  type LifecycleModule,
  type LifecycleShape,
  type RoundIdentity,
} from '../../core/module.js';
import { MODULE_API_VERSION } from '../../core/versions.js';
import { weightVector, type WeightVector } from '../../core/weights.js';
import { adapterFingerprint, adapterIdentity, defineGame } from './adapter.js';
import { PROGRESSIVE_MARKET_CHECKS } from './checks.js';
import {
  PROGRESSIVE_MARKET_MODULE_ID,
  PROGRESSIVE_MARKET_MODULE_VERSION,
  ROUND_BOOK_SCHEMA,
  TRANSCRIPT_SCHEMA,
  type RoundContext,
} from './contracts.js';
import {
  binaryBeaconReference,
  blackSignalReference,
  constellationReference,
} from './references/index.js';
import {
  canonicalTranscriptBytes,
  deriveEvidence,
  deriveTruth,
  evidenceEqual,
  makeTranscript,
  roundContext,
  verifyTranscriptDetailed,
} from './fairness.js';
import { initialPosterior, posteriorFor } from './posterior.js';
import { RoundBook, ROUND_ACTIONS } from './round-book.js';
import {
  ACCEPTED_TRANSCRIPT_SCHEMAS,
  deserializeTranscript,
  transcriptToWire,
} from './transcript.js';
import type { ProgressiveMarketShape } from './shape.js';
import { assertGameDefinition } from './validation.js';

export type { ProgressiveMarketShape };

function contextOf(round: RoundIdentity): RoundContext {
  return Object.freeze({
    gameId: round.definitionId,
    roundId: round.roundId,
    proofVersion: round.proofVersion,
  });
}

export const progressiveMarket: LifecycleModule<ProgressiveMarketShape> =
  defineLifecycleModule<ProgressiveMarketShape>({
    moduleApiVersion: MODULE_API_VERSION,
    id: PROGRESSIVE_MARKET_MODULE_ID,
    version: PROGRESSIVE_MARKET_MODULE_VERSION,
    summary:
      'Single hidden truth, a Bayesian evidence stream, and a single-position book with fair-value sell and re-entry.',

    definitions: {
      define: defineGame,
      assert: assertGameDefinition,
      fingerprint: adapterFingerprint,
      identity: adapterIdentity,
    },

    truth: {
      kind: 'scalar-index',
      derive: (seedHex, definition, roundId) => deriveTruth(seedHex, definition, roundId),
      encode: (truth): readonly CanonicalField[] => [truth],
      equal: (left, right) => left === right,
      enumerate: (definition) => Object.freeze(definition.outcomes.map((_outcome, index) => index)),
    },

    steps: {
      maxSteps: 10_000,
      choiceTiming: 'none',
      // One scalar truth among `outcomes`: the weight vector is the pricing space.
      beliefSpace: 'outcomes',
      count: (definition) => definition.evidence.eventCount,
      derive: (seedHex, definition, round, truth) =>
        deriveEvidence(seedHex, definition, contextOf(round), truth),
      encode: (step): readonly CanonicalField[] => [
        step.index,
        step.target,
        step.favour,
        step.other,
        step.label,
      ],
      equal: evidenceEqual,
      belief: (definition, steps): WeightVector =>
        weightVector(posteriorFor(definition, steps).weights),
    },

    transcript: {
      schema: TRANSCRIPT_SCHEMA,
      acceptedSchemas: ACCEPTED_TRANSCRIPT_SCHEMAS,
      build: (seedHex, definition, roundId) => makeTranscript(seedHex, definition, roundId),
      // `choiceTiming` is 'none', so the contract guarantees `_choices` is empty.
      commitmentBody: (definition, round, truth, steps, _choices) =>
        canonicalTranscriptBytes(definition, contextOf(round), truth, steps),
      toWire: transcriptToWire,
      fromWire: deserializeTranscript,
    },

    book: {
      snapshotSchema: ROUND_BOOK_SCHEMA,
      positions: 'single',
      settlement: 'winner-takes-claim',
      maxOpenClaims: 1,
      actions: ROUND_ACTIONS,
      create: (definition) => new RoundBook(definition, initialPosterior(definition)),
      restore: (definition, snapshot) =>
        RoundBook.restore(definition, snapshot as Parameters<typeof RoundBook.restore>[1]),
      snapshot: (book) => book.snapshot(),
    },

    conformance: {
      defaultSeeds: 8,
      checks: PROGRESSIVE_MARKET_CHECKS,
      references: [
        { id: blackSignalReference.id, definition: blackSignalReference },
        { id: constellationReference.id, definition: constellationReference },
        { id: binaryBeaconReference.id, definition: binaryBeaconReference },
      ],
    },

    verify: verifyTranscriptDetailed,
  });

export { roundContext };
