import { defineLifecycleModule, type LifecycleModule } from '../../core/module.js';
import { MODULE_API_VERSION } from '../../core/versions.js';
import { cardsFingerprint, cardsIdentity, defineCardsGame } from './adapter.js';
import { SEQUENTIAL_CARDS_CHECKS } from './checks.js';
import {
  CARDS_ACTIONS,
  CARDS_BOOK_SCHEMA,
  CARDS_TRANSCRIPT_SCHEMA,
  SEQUENTIAL_CARDS_MODULE_ID,
  SEQUENTIAL_CARDS_MODULE_VERSION,
} from './contracts.js';
import { cardsBeliefVector, claimProbability } from './deck.js';
import {
  SEQUENTIAL_CARDS_REFERENCES,
  cascadeMiddleReference,
  duoMiddleReference,
  triadMiddleReference,
} from './references.js';
import { CardsBook } from './round-book.js';
import { deriveRevealSteps, encodeRevealStep, revealStepsEqual } from './steps.js';
import {
  ACCEPTED_CARDS_TRANSCRIPT_SCHEMAS,
  buildCardsTranscript,
  cardsChoicesOf,
  cardsCommitmentBody,
  cardsSeedCommitment,
  cardsTranscriptToWire,
  deserializeCardsTranscript,
  verifyCardsTranscript,
} from './transcript.js';
import { dealEqual, deriveDeal, encodeDeal, enumerateDeals } from './truth.js';
import { CARDS_MAX_STEPS, CARDS_MAX_OPEN_CLAIMS, assertCardsDefinition } from './validation.js';
import type { SequentialCardsShape } from './shape.js';

export type { SequentialCardsShape };

/**
 * The sequential-cards lifecycle module.
 *
 * A committed deterministic shuffle of a declared finite deck; reveals that
 * drive a position's posterior to **exactly zero** by counting the completions
 * that survive rather than by damping a weight; and a multi-position book whose
 * claims are exact rationals until the single credit boundary each one crosses.
 *
 * The belief space is `marginal` and not `outcomes`, and the distinction is
 * load-bearing rather than bookkeeping: the flat weight vector over board
 * positions is the elimination view, while a side market prices over the
 * objective **rank**, which is a different space counted over the same
 * enumeration. `price()` is what carries the money.
 */
export const sequentialCards: LifecycleModule<SequentialCardsShape> =
  defineLifecycleModule<SequentialCardsShape>({
    moduleApiVersion: MODULE_API_VERSION,
    id: SEQUENTIAL_CARDS_MODULE_ID,
    version: SEQUENTIAL_CARDS_MODULE_VERSION,
    summary:
      'A committed deck shuffle, reveals that eliminate outcomes to exactly zero, and a multi-position book with independent fair-value sells and self-financed switches.',

    definitions: {
      define: defineCardsGame,
      assert: assertCardsDefinition,
      fingerprint: cardsFingerprint,
      identity: cardsIdentity,
    },

    truth: {
      // A deal is an ordered tuple of ranks, plus the selectors sealed with it.
      kind: 'vector',
      derive: deriveDeal,
      // The commitment body composes this same function, so the declared
      // encoding and the proof-bearing one are one layout rather than two.
      encode: encodeDeal,
      equal: dealEqual,
      enumerate: enumerateDeals,
    },

    steps: {
      maxSteps: CARDS_MAX_STEPS,
      // The backed position is an input to reveal derivation, so it must be
      // logged before the reveal it constrains.
      choiceTiming: 'before-step',
      beliefSpace: 'marginal',
      count: (definition) => definition.reveal.count,
      derive: (_seedHex, definition, _round, truth, choices) =>
        deriveRevealSteps(definition, truth, choices),
      encode: encodeRevealStep,
      equal: revealStepsEqual,
      belief: cardsBeliefVector,
      price: claimProbability,
    },

    transcript: {
      schema: CARDS_TRANSCRIPT_SCHEMA,
      acceptedSchemas: ACCEPTED_CARDS_TRANSCRIPT_SCHEMAS,
      build: buildCardsTranscript,
      commitmentBody: cardsCommitmentBody,
      seedCommitment: cardsSeedCommitment,
      toWire: cardsTranscriptToWire,
      fromWire: deserializeCardsTranscript,
      choicesOf: cardsChoicesOf,
    },

    book: {
      snapshotSchema: CARDS_BOOK_SCHEMA,
      positions: 'multi',
      settlement: 'paytable',
      maxOpenClaims: CARDS_MAX_OPEN_CLAIMS,
      actions: CARDS_ACTIONS,
      create: (definition) => new CardsBook(definition),
      restore: (definition, snapshot) => CardsBook.restore(definition, snapshot),
      snapshot: (book) => book.snapshot(),
    },

    conformance: {
      defaultSeeds: 4,
      checks: SEQUENTIAL_CARDS_CHECKS,
      references: [
        { id: triadMiddleReference.id, definition: triadMiddleReference },
        { id: duoMiddleReference.id, definition: duoMiddleReference },
        { id: cascadeMiddleReference.id, definition: cascadeMiddleReference },
      ],
    },

    verify: verifyCardsTranscript,
  });

export { SEQUENTIAL_CARDS_REFERENCES };
