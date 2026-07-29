import { defineLifecycleModule, type LifecycleModule } from '../../core/module.js';
import { MODULE_API_VERSION } from '../../core/versions.js';
import { enumerateOrders } from './bets.js';
import { PERMUTATION_CHECKS } from './checks.js';
import {
  ACCEPTED_TRANSCRIPT_SCHEMAS,
  MAX_ITEMS,
  MAX_OPEN_BETS,
  PERMUTATION_ACTIONS,
  PERMUTATION_BOOK_SCHEMA,
  PERMUTATION_MODULE_ID,
  PERMUTATION_MODULE_VERSION,
  PERMUTATION_TRANSCRIPT_SCHEMA,
} from './contracts.js';
import {
  definePermutationGame,
  permutationFingerprint,
  permutationIdentity,
} from './definition.js';
import {
  derivePermutationOrder,
  derivePermutationSteps,
  encodeOrder,
  encodeStep,
  makePermutationTranscript,
  ordersEqual,
  permutationCommitmentBody,
  stepsEqual,
  verifyPermutationTranscript,
} from './derivation.js';
import { itemBelief, price } from './pricing.js';
import {
  aetherOrderClassicReference,
  aetherOrderSevenReference,
  triadReference,
} from './references/index.js';
import { PermutationBook } from './round-book.js';
import type { PermutationShape } from './shape.js';
import { deserializePermutationTranscript, permutationTranscriptToWire } from './transcript.js';
import { assertPermutationDefinition } from './validation.js';

/**
 * The permutation lifecycle module.
 *
 * Truth: one permutation of `n` labeled items, drawn by core's seeded
 * Fisher-Yates over core's rejection sampler. Steps: the settle sequence, one
 * reveal per position bar the last, which is forced. Belief space: `marginal`,
 * because the pricing space is `S_n` and `5!` alone is nearly twice
 * `ENGINE_LIMITS.maxOutcomes` — claims are priced by `price()`, exactly, by
 * factorial counting. Book: several independent bets on one draw, settled
 * together against a published paytable.
 *
 * No core file was modified to build this. The two places where the contract
 * came closest to not expressing something are recorded in
 * `docs/modules/permutation.md` along with how each was resolved inside the
 * module, because "we changed core to make our module fit" is a claim that
 * should never pass silently.
 */
export const permutation: LifecycleModule<PermutationShape> =
  defineLifecycleModule<PermutationShape>({
    moduleApiVersion: MODULE_API_VERSION,
    id: PERMUTATION_MODULE_ID,
    version: PERMUTATION_MODULE_VERSION,
    summary:
      'A committed permutation of n labeled items, priced by exact factorial enumeration and settled as a multi-bet paytable ticket.',

    definitions: {
      define: definePermutationGame,
      assert: assertPermutationDefinition,
      fingerprint: permutationFingerprint,
      identity: permutationIdentity,
    },

    truth: {
      kind: 'permutation',
      derive: derivePermutationOrder,
      // The commitment body composes this same function, so the declared
      // encoding *is* the proof-bearing one rather than a description of it.
      encode: encodeOrder,
      equal: ordersEqual,
      // `n <= 8`, so the whole truth space is enumerable and every proof in this
      // module is exhaustive rather than statistical.
      enumerate: (definition) => enumerateOrders(definition.items.length),
    },

    steps: {
      // A round reveals one position short of the draw, and the draw is capped
      // at `MAX_ITEMS`. The budget is stated as tightly as the module knows it.
      maxSteps: MAX_ITEMS - 1,
      choiceTiming: 'none',
      beliefSpace: 'marginal',
      count: (definition) => definition.items.length - 1,
      // `choiceTiming` is 'none', so the contract guarantees `_choices` is empty
      // and the schedule is a pure function of the truth.
      derive: (_seedHex, definition, _round, truth, _choices) =>
        derivePermutationSteps(definition, truth),
      encode: encodeStep,
      equal: stepsEqual,
      belief: itemBelief,
      price,
    },

    transcript: {
      schema: PERMUTATION_TRANSCRIPT_SCHEMA,
      acceptedSchemas: ACCEPTED_TRANSCRIPT_SCHEMAS,
      build: (seedHex, definition, roundId) =>
        makePermutationTranscript(seedHex, definition, roundId),
      // The choice log is dropped rather than checked, and that is the contract:
      // `defineLifecycleModule()` wraps this call as `commitmentBody(..., guard(
      // choices))`, and for `choiceTiming: 'none'` that guard raises
      // `INVALID_CHOICE` on a non-empty log *before* this closure runs. A guard
      // here would be unreachable — dead code that reads like a control.
      //
      // What makes the omission safe is not the wrapper but the arity:
      // `permutationCommitmentBody` has no choice parameter at all, so there is
      // no log for these bytes to bind and no way for one to reach them. See
      // `docs/modules/permutation.md` §8.
      commitmentBody: (definition, round, truth, steps, _choices) =>
        permutationCommitmentBody(definition, round, truth, steps),
      toWire: permutationTranscriptToWire,
      fromWire: deserializePermutationTranscript,
    },

    book: {
      snapshotSchema: PERMUTATION_BOOK_SCHEMA,
      positions: 'multi',
      settlement: 'paytable',
      maxOpenClaims: MAX_OPEN_BETS,
      actions: PERMUTATION_ACTIONS,
      // The contract's factory takes a definition and nothing else, so the book
      // it returns is **unbound**: it has no round, and `place()` refuses it
      // until `bind()` names the published commitment. That is deliberate rather
      // than a gap — an unbound book cannot take money, so the one thing the
      // narrow factory signature can produce is the one state in which no money
      // is at risk. A host that already holds the round constructs
      // `new PermutationBook(definition, binding)` directly and never sees the
      // unbound state at all.
      //
      // `restore` likewise takes the contract's two arguments. `PermutationBook
      // .restore` accepts an optional third — the round the caller published —
      // and a host that holds it should call the class directly to get the
      // stronger check. See `PermutationBook.restore`.
      create: (definition) => new PermutationBook(definition),
      restore: (definition, snapshot) => PermutationBook.restore(definition, snapshot),
      snapshot: (book) => book.snapshot(),
    },

    conformance: {
      defaultSeeds: 8,
      checks: PERMUTATION_CHECKS,
      references: [
        { id: aetherOrderClassicReference.id, definition: aetherOrderClassicReference },
        { id: aetherOrderSevenReference.id, definition: aetherOrderSevenReference },
        { id: triadReference.id, definition: triadReference },
      ],
    },

    verify: verifyPermutationTranscript,
  });
