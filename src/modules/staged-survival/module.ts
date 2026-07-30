import { defineLifecycleModule, type LifecycleModule } from '../../core/module.js';
import { MODULE_API_VERSION } from '../../core/versions.js';
import { defineSurvivalGame, survivalFingerprint, survivalIdentity } from './adapter.js';
import { SurvivalBook } from './book.js';
import { STAGED_SURVIVAL_CHECKS } from './checks.js';
import {
  STAGED_SURVIVAL_MODULE_ID,
  STAGED_SURVIVAL_MODULE_VERSION,
  SURVIVAL_ACTIONS,
  SURVIVAL_BOOK_SCHEMA,
  SURVIVAL_LIMITS,
  TRANSCRIPT_SCHEMA,
} from './contracts.js';
import {
  belief,
  commitmentBody,
  deriveSteps,
  deriveTruth,
  makeTranscript,
  price,
  encodeStep,
  encodeTruth,
  seedCommitment,
  stepsEqual,
  verifySurvivalTranscript,
} from './fairness.js';
import { fiveRunnerReference, oracleTrialReference } from './references/index.js';
import type { StagedSurvivalShape } from './shape.js';
import {
  ACCEPTED_TRANSCRIPT_SCHEMAS,
  deserializeTranscript,
  transcriptToWire,
} from './transcript.js';
import { assertSurvivalDefinition } from './validation.js';

export type { StagedSurvivalShape };

export const stagedSurvival: LifecycleModule<StagedSurvivalShape> =
  defineLifecycleModule<StagedSurvivalShape>({
    moduleApiVersion: MODULE_API_VERSION,
    id: STAGED_SURVIVAL_MODULE_ID,
    version: STAGED_SURVIVAL_MODULE_VERSION,
    summary:
      'N entities through S stages: a seed-committed counterfactually complete tape, a contract chosen from an adapter menu before each stage resolves, correlated survivor subsets, and per-entity claims banked in subsets under one round cap.',

    definitions: {
      define: defineSurvivalGame,
      assert: assertSurvivalDefinition,
      fingerprint: survivalFingerprint,
      identity: survivalIdentity,
    },

    truth: {
      // The truth is the whole random tape, not a scalar: a structured record of
      // every draw the round could ever consume, fixed by the seed and the round
      // pair before any decision exists.
      kind: 'composite',
      derive: deriveTruth,
      // The commitment body composes this same function, so the declared
      // encoding and the proof-bearing one are one layout, not two.
      encode: encodeTruth,
      equal: (left, right) => left.digest === right.digest,
    },

    steps: {
      maxSteps: SURVIVAL_LIMITS.maxStages,
      choiceTiming: 'before-step',
      // The truth space is the joint law over survivor subsets, which is
      // combinatorial: `belief()` is a per-entity view for display and for
      // proving elimination reaches exactly zero, and `price()` is the money.
      beliefSpace: 'marginal',
      count: (definition) => definition.stages,
      derive: (_seedHex, definition, _round, truth, choices) =>
        deriveSteps(definition, truth, choices),
      encode: encodeStep,
      equal: stepsEqual,
      belief,
      price,
    },

    transcript: {
      schema: TRANSCRIPT_SCHEMA,
      acceptedSchemas: ACCEPTED_TRANSCRIPT_SCHEMAS,
      build: makeTranscript,
      commitmentBody,
      seedCommitment,
      toWire: transcriptToWire,
      fromWire: deserializeTranscript,
      choicesOf: (transcript) => transcript.choices,
    },

    book: {
      snapshotSchema: SURVIVAL_BOOK_SCHEMA,
      positions: 'multi',
      settlement: 'partial',
      maxOpenClaims: SURVIVAL_LIMITS.maxEntities,
      actions: SURVIVAL_ACTIONS,
      create: (definition) => new SurvivalBook(definition),
      restore: (definition, snapshot, expectedBinding) =>
        SurvivalBook.restore(definition, snapshot, expectedBinding),
      snapshot: (book) => book.snapshot(),
    },

    conformance: {
      defaultSeeds: 8,
      checks: STAGED_SURVIVAL_CHECKS,
      references: [
        { id: fiveRunnerReference.id, definition: fiveRunnerReference },
        { id: oracleTrialReference.id, definition: oracleTrialReference },
      ],
    },

    verify: (seedHex, definition, input) =>
      verifySurvivalTranscript(seedHex, definition, input, deserializeTranscript),
  });
