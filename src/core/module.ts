import { fail } from '../api/errors.js';
import { ENGINE_LIMITS } from '../api/limits.js';
import type { CanonicalField } from '../internal/canonical.js';
import type { SamplerScope } from './random.js';
import { assertIdentifier, isRecord } from './validation.js';
import type { VerificationResult } from './verification.js';
import { MODULE_API_VERSION, type CommitmentVersion } from './versions.js';
import type { WeightVector } from './weights.js';

/**
 * The lifecycle-module contract.
 *
 * Core owns everything that must behave identically in every game: seeded
 * rejection sampling, commit-reveal sealing, exact rational money, the command
 * ledger, and the wire-safety rules. A lifecycle module owns the game-shaped
 * decisions: what the hidden truth is, what a step reveals, what a player can
 * claim, and how a round settles.
 *
 * `docs/lifecycle-modules.md` is the normative prose version of this file.
 */

/** Type bag for one module. Every hook below is expressed against these slots. */
export interface LifecycleShape {
  /** Immutable, frozen game configuration (the progressive market's `GameDefinition`). */
  readonly definition: unknown;
  /** The hidden truth. A scalar index, a permutation, or a structured record. */
  readonly truth: unknown;
  /** One observable progression step (an evidence event, a card reveal, a stage). */
  readonly step: unknown;
  /** A logged player decision that is an input to step derivation, or `never`. */
  readonly choice: unknown;
  /** The module's transcript domain object. */
  readonly transcript: unknown;
  /** The module's round book instance. */
  readonly book: unknown;
}

/** How the truth is shaped. Drives which conformance strategies apply. */
export type TruthKind = 'scalar-index' | 'permutation' | 'vector' | 'composite';

/** Whether logged player choices feed step derivation, and when. */
export type ChoiceTiming = 'none' | 'before-step' | 'after-step';

/** How many claims may be open at once. */
export type BookPositions = 'single' | 'multi';

/** How a settled round turns claims into credits. */
export type ClaimSettlement = 'winner-takes-claim' | 'paytable' | 'partial';

export interface DefinitionIdentity {
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly definitionId: string;
  readonly definitionVersion: string;
  /** 32-byte hex binding every replay-visible declarative field. */
  readonly fingerprint: string;
}

/** Round-scoped identity. `definitionId` is the sampler domain. */
export interface RoundIdentity {
  readonly moduleId: string;
  readonly definitionId: string;
  readonly roundId: string;
  readonly proofVersion: CommitmentVersion;
}

export function samplerScopeOf(round: RoundIdentity): SamplerScope {
  return Object.freeze({
    domain: round.definitionId,
    roundId: round.roundId,
    proofVersion: round.proofVersion,
  });
}

export interface ConformanceFailure {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** Declarative game configuration: construction, validation, and identity. */
export interface DefinitionModel<S extends LifecycleShape> {
  /** The only supported construction path: validate, clone, deep-freeze. */
  define(input: S['definition']): S['definition'];
  assert(value: unknown, path?: string): asserts value is S['definition'];
  fingerprint(definition: S['definition']): string;
  identity(definition: S['definition']): DefinitionIdentity;
}

/**
 * Truth model.
 *
 * `derive` must be a pure function of the seed and the definition: an operator
 * that already published the commitment cannot change what it means. `encode`
 * produces the canonical fields that bind the truth into the commitment body.
 */
export interface TruthModel<S extends LifecycleShape> {
  readonly kind: TruthKind;
  derive(seedHex: string, definition: S['definition'], roundId: string): S['truth'];
  encode(truth: S['truth']): readonly CanonicalField[];
  equal(left: S['truth'], right: S['truth']): boolean;
  /** Full truth space when small enough for exhaustive tests; otherwise `undefined`. */
  enumerate?(definition: S['definition']): readonly S['truth'][] | undefined;
}

/**
 * Step semantics: the observable progression of a round.
 *
 * `derive` takes the logged player choices so a module whose steps depend on
 * decisions (pick a contract, then resolve the stage) stays a pure function of
 * (seed-committed randomness, logged choices). Modules with `choiceTiming:
 * 'none'` receive an empty array and must ignore it.
 *
 * `belief` returns exact non-negative weights over the definition's outcome
 * space after a step prefix. Zero is a legal weight: a step that eliminates an
 * outcome sets its weight to exactly zero, never to an epsilon.
 */
export interface StepModel<S extends LifecycleShape> {
  readonly maxSteps: number;
  readonly choiceTiming: ChoiceTiming;
  count(definition: S['definition']): number;
  derive(
    seedHex: string,
    definition: S['definition'],
    round: RoundIdentity,
    truth: S['truth'],
    choices: readonly S['choice'][],
  ): readonly S['step'][];
  encode(step: S['step']): readonly CanonicalField[];
  equal(left: readonly S['step'][], right: readonly S['step'][]): boolean;
  belief(definition: S['definition'], steps: readonly S['step'][]): WeightVector;
}

/**
 * Transcript schema, versioning, and codec.
 *
 * Each module owns its own `schema` string and its own migration set. Core never
 * parses a module transcript; it only seals `commitmentBody` bytes. A module
 * must bind its definition identity into that body, or two adapters could share
 * a commitment.
 */
export interface TranscriptModel<S extends LifecycleShape> {
  readonly schema: string;
  /** Schemas `fromWire` accepts, newest first. Anything else must fail closed. */
  readonly acceptedSchemas: readonly string[];
  build(
    seedHex: string,
    definition: S['definition'],
    roundId: string,
    choices?: readonly S['choice'][],
  ): S['transcript'];
  commitmentBody(
    definition: S['definition'],
    round: RoundIdentity,
    truth: S['truth'],
    steps: readonly S['step'][],
  ): Uint8Array;
  toWire(transcript: S['transcript']): unknown;
  fromWire(input: unknown): S['transcript'];
}

/**
 * Book and claim semantics.
 *
 * `positions` and `settlement` are declarations a host can branch on before it
 * ever calls the module: a single-position market and a multi-position card game
 * need different UI, different reserve maths, and different receipt volumes.
 */
export interface BookModel<S extends LifecycleShape> {
  readonly snapshotSchema: string;
  readonly positions: BookPositions;
  readonly settlement: ClaimSettlement;
  /** Receipt action names this module mints, e.g. `['open', 'sell', 'settle']`. */
  readonly actions: readonly string[];
  create(definition: S['definition']): S['book'];
  restore(definition: S['definition'], snapshot: string | object): S['book'];
  snapshot(book: S['book']): object;
}

export interface ModuleConformanceContext<S extends LifecycleShape> {
  readonly module: LifecycleModule<S>;
  readonly definition: S['definition'];
  readonly seedHex: string;
  readonly seedIndex: number;
  readonly roundId: string;
  readonly round: RoundIdentity;
  /** Records module-specific evidence (transcripts verified, truths swept, ...). */
  count(key: string, delta?: number): void;
}

/** One mechanical property a conforming definition must satisfy. */
export interface ModuleConformanceCheck<S extends LifecycleShape> {
  readonly code: string;
  readonly description: string;
  /** `definition` checks run once per report; `round` checks run once per seed. */
  readonly scope: 'definition' | 'round';
  run(context: ModuleConformanceContext<S>): readonly ConformanceFailure[];
}

export interface ConformanceModel<S extends LifecycleShape> {
  readonly defaultSeeds: number;
  readonly checks: readonly ModuleConformanceCheck<S>[];
}

export interface LifecycleModule<S extends LifecycleShape = LifecycleShape> {
  readonly moduleApiVersion: typeof MODULE_API_VERSION;
  readonly id: string;
  readonly version: string;
  readonly summary: string;
  readonly definitions: DefinitionModel<S>;
  readonly truth: TruthModel<S>;
  readonly steps: StepModel<S>;
  readonly transcript: TranscriptModel<S>;
  readonly book: BookModel<S>;
  readonly conformance: ConformanceModel<S>;
  /**
   * Pure re-derivation verifier.
   *
   * Required phase order: decode wire, check definition identity, re-derive
   * truth, compare, re-derive steps, compare, re-seal the commitment body, and
   * compare in constant time. Every failure must be one of the six public
   * verification codes; incidental exceptions must be classified, never leaked.
   */
  verify(seedHex: string, definition: S['definition'], input: unknown): VerificationResult;
}

const REQUIRED_SECTIONS = ['definitions', 'truth', 'steps', 'transcript', 'book', 'conformance'];

/** Validates and freezes a lifecycle module at load time. */
export function defineLifecycleModule<S extends LifecycleShape>(
  module: LifecycleModule<S>,
): LifecycleModule<S> {
  if (!isRecord(module)) fail('INVALID_MODULE', 'Expected a lifecycle module object');
  if (module.moduleApiVersion !== MODULE_API_VERSION)
    fail('UNSUPPORTED_VERSION', 'Unsupported module API version', '$.moduleApiVersion');
  assertIdentifier(module.id, '$.id', 'INVALID_MODULE');
  assertIdentifier(module.version, '$.version', 'INVALID_MODULE');
  assertIdentifier(module.summary, '$.summary', 'INVALID_MODULE', 512);
  if (typeof module.verify !== 'function')
    fail('INVALID_MODULE', 'Module must expose a verifier', '$.verify');
  for (const section of REQUIRED_SECTIONS)
    if (!isRecord((module as unknown as Record<string, unknown>)[section]))
      fail('INVALID_MODULE', `Module is missing the ${section} contract`, `$.${section}`);
  if (
    !Number.isSafeInteger(module.steps.maxSteps) ||
    module.steps.maxSteps < 0 ||
    module.steps.maxSteps > ENGINE_LIMITS.maxSteps
  )
    fail('INVALID_MODULE', 'Module step budget is outside limits', '$.steps.maxSteps');
  assertIdentifier(module.transcript.schema, '$.transcript.schema', 'INVALID_MODULE');
  assertIdentifier(module.book.snapshotSchema, '$.book.snapshotSchema', 'INVALID_MODULE');
  if (!Array.isArray(module.book.actions) || module.book.actions.length === 0)
    fail('INVALID_MODULE', 'Module must declare its receipt actions', '$.book.actions');
  if (!Array.isArray(module.transcript.acceptedSchemas))
    fail('INVALID_MODULE', 'Module must declare accepted schemas', '$.transcript.acceptedSchemas');
  if (!module.transcript.acceptedSchemas.includes(module.transcript.schema))
    fail(
      'INVALID_MODULE',
      'Accepted schemas must include the current schema',
      '$.transcript.acceptedSchemas',
    );
  if (!Array.isArray(module.conformance.checks) || module.conformance.checks.length === 0)
    fail('INVALID_MODULE', 'Module must declare conformance checks', '$.conformance.checks');
  return Object.freeze({
    ...module,
    definitions: Object.freeze({ ...module.definitions }),
    truth: Object.freeze({ ...module.truth }),
    steps: Object.freeze({ ...module.steps }),
    transcript: Object.freeze({
      ...module.transcript,
      acceptedSchemas: Object.freeze([...module.transcript.acceptedSchemas]),
    }),
    book: Object.freeze({ ...module.book, actions: Object.freeze([...module.book.actions]) }),
    conformance: Object.freeze({
      ...module.conformance,
      checks: Object.freeze([...module.conformance.checks]),
    }),
  });
}
