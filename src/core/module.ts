import { fail } from '../api/errors.js';
import { ENGINE_LIMITS } from '../api/limits.js';
import type { CanonicalField } from '../internal/canonical.js';
import type { Rational } from './rational.js';
import type { SamplerScope } from './random.js';
import { assertIdentifier, isRecord } from './validation.js';
import { classifyVerificationError, type VerificationResult } from './verification.js';
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
  /** One priced claim: an outcome index, a paytable bet, a per-entity contract. */
  readonly claim: unknown;
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

/**
 * What `belief()` describes, and therefore what a host may price from.
 *
 * `outcomes` — the weight vector **is** the space claims are priced from. A
 * claim is an index into it and `weightProbability()` is its exact price. Bound
 * by `ENGINE_LIMITS.maxOutcomes`.
 *
 * `marginal` — the truth space is combinatorial and does not fit a bounded flat
 * vector (`5!` orderings already exceed the outcome limit, a trifecta over eight
 * runners is 336 events). `belief()` is then only a per-item marginal, useful
 * for display and for proving elimination reaches exactly zero, and is **not**
 * the pricing space; it is optional, because the per-item view is bound by the
 * same 2..`maxOutcomes` window and a module with more items than that has no
 * honest vector to return. Such a module must implement `price()`, which
 * returns the exact probability of one module-defined claim event over the full
 * space, counted with `core/combinatorics.ts`.
 */
export type BeliefSpace = 'outcomes' | 'marginal';

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
  if (!isRecord(round)) fail('INVALID_CONTEXT', 'Expected a round identity', '$.round');
  return Object.freeze({
    domain: round.definitionId,
    roundId: round.roundId,
    proofVersion: round.proofVersion,
  });
}

/**
 * Normalizes and bounds a logged choice list at the contract boundary.
 *
 * `ENGINE_LIMITS.maxLoggedChoices` is the DoS bound for the unbounded array a
 * choice-timed module accepts, and a module with `choiceTiming: 'none'` must
 * never silently receive decisions it does not model. `defineLifecycleModule()`
 * applies this to every `steps.derive`, `transcript.build`, and
 * `transcript.commitmentBody` call, and — through `transcript.choicesOf` — to
 * the decoded choice log on the `verify()` path, which is the one place the
 * list arrives from the wire. A module author cannot forget it: a choice-timed
 * module that does not expose `choicesOf` fails to define.
 */
export function assertLoggedChoices(
  choices: readonly unknown[] | undefined,
  timing: ChoiceTiming,
  path = '$.choices',
): readonly unknown[] {
  const list = choices ?? [];
  if (!Array.isArray(list)) fail('INVALID_CHOICE', 'Logged choices must be an array', path);
  if (list.length > ENGINE_LIMITS.maxLoggedChoices)
    fail('INVALID_CHOICE', 'Logged choice count exceeds the engine limit', path);
  if (timing === 'none' && list.length > 0)
    fail('INVALID_CHOICE', 'Module declares no logged choices', path);
  return list;
}

/**
 * Bounds simultaneous open claims against the book's declared budget.
 *
 * Call before admitting a new claim. The declared budget is itself bounded by
 * `ENGINE_LIMITS.maxRoundClaims` at module definition time.
 */
export function assertClaimBudget(
  openClaims: number,
  maxOpenClaims: number,
  path = '$.claims',
): void {
  if (!Number.isSafeInteger(openClaims) || openClaims < 0)
    fail('CLAIM_REJECTED', 'Open claim count is invalid', path);
  if (openClaims >= maxOpenClaims)
    fail('CLAIM_REJECTED', 'Round book is at its declared claim budget', path);
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
 * outcome sets its weight to exactly zero, never to an epsilon. It is mandatory
 * when `beliefSpace` is `outcomes` — that vector *is* the pricing space — and
 * optional when it is `marginal`, where pricing lives in `price()` and the
 * vector is only a display view. The escape hatch is not cosmetic:
 * `weightVector` admits between 2 and `ENGINE_LIMITS.maxOutcomes` entries, so a
 * module whose per-item space is larger than that (a multi-deck shoe, a large
 * field) has no honest vector to return and must omit it.
 */
export interface StepModel<S extends LifecycleShape> {
  readonly maxSteps: number;
  readonly choiceTiming: ChoiceTiming;
  readonly beliefSpace: BeliefSpace;
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
  belief?(definition: S['definition'], steps: readonly S['step'][]): WeightVector;
  /**
   * Exact price of one claim event after a step prefix.
   *
   * Required when `beliefSpace` is `marginal`: it is the only honest way to
   * price a combinatorial paytable, because the flat weight vector is not that
   * space. Optional for `outcomes` modules, where `weightProbability(belief())`
   * already is the price.
   */
  price?(definition: S['definition'], steps: readonly S['step'][], claim: S['claim']): Rational;
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
  /**
   * Canonical bytes core seals under the seed.
   *
   * Must bind the module id, the definition identity and fingerprint, the round
   * id, the truth, every step, **and every logged choice**. A body that omits
   * the choice log lets an operator re-settle one published commitment under a
   * different set of player decisions.
   */
  commitmentBody(
    definition: S['definition'],
    round: RoundIdentity,
    truth: S['truth'],
    steps: readonly S['step'][],
    choices: readonly S['choice'][],
  ): Uint8Array;
  /**
   * Pre-commitment published before the round accepts its first decision.
   *
   * Required for any module whose `choiceTiming` is not `none`: its commitment
   * body does not exist until the round ends, so the seed must be sealed on its
   * own beforehand with `sealSeedCommitment()`. A verifier checks both — the
   * seed commitment proves the seed predates every choice, the body commitment
   * proves the transcript is that seed's.
   */
  seedCommitment?(seedHex: string, definition: S['definition'], round: RoundIdentity): string;
  toWire(transcript: S['transcript']): unknown;
  fromWire(input: unknown): S['transcript'];
  /**
   * The logged decision list a decoded transcript carries.
   *
   * Mandatory when `choiceTiming` is not `none`, and the reason is `verify()`:
   * that is the one path where the choice log arrives from the wire, and the
   * contract's phase order has the verifier re-derive steps from the
   * transcript's own log rather than through `steps.derive`. Core cannot find
   * the log without being told where it lives, so this accessor is how
   * `defineLifecycleModule()` applies `assertLoggedChoices` to it before the
   * module's verifier runs. Modules with `choiceTiming: 'none'` omit it.
   */
  choicesOf?(transcript: S['transcript']): readonly S['choice'][];
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
  /** Simultaneous open claims this book admits. `1` for a single-position book. */
  readonly maxOpenClaims: number;
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

/**
 * A definition the module ships as its own conformance subject.
 *
 * The registry-driven CLI runs every module's declared references, so a new
 * module appears in `reveal-conformance` — and therefore in CI — by declaring
 * them, with no CLI edit.
 */
export interface ConformanceReference<S extends LifecycleShape> {
  readonly id: string;
  readonly definition: S['definition'];
}

export interface ConformanceModel<S extends LifecycleShape> {
  readonly defaultSeeds: number;
  readonly checks: readonly ModuleConformanceCheck<S>[];
  readonly references: readonly ConformanceReference<S>[];
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
   * truth, compare, re-derive steps from the transcript's own logged choices,
   * compare, re-seal the commitment body, and compare in constant time. Every
   * failure must be one of the public verification codes; incidental exceptions
   * must be classified, never leaked.
   */
  verify(seedHex: string, definition: S['definition'], input: unknown): VerificationResult;
}

const REQUIRED_SECTIONS = ['definitions', 'truth', 'steps', 'transcript', 'book', 'conformance'];

/**
 * Validates and freezes a lifecycle module at load time.
 *
 * What this cannot check is stated plainly so nobody mistakes a passing call for
 * a conforming module: it verifies declarations, not behaviour. That `restore()`
 * re-validates instead of trusting its snapshot, that `verify()` compares in
 * constant time, and that `commitmentBody()` binds everything it should are
 * properties only the module's own conformance checks and tests can establish.
 */
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
  if (module.steps.beliefSpace !== 'outcomes' && module.steps.beliefSpace !== 'marginal')
    fail('INVALID_MODULE', 'Module must declare its belief space', '$.steps.beliefSpace');
  if (module.steps.beliefSpace === 'marginal' && typeof module.steps.price !== 'function')
    fail(
      'INVALID_MODULE',
      'A marginal belief space must price claims exactly through price()',
      '$.steps.price',
    );
  if (module.steps.beliefSpace === 'outcomes' && typeof module.steps.belief !== 'function')
    fail(
      'INVALID_MODULE',
      'An outcome belief space is the pricing space and must expose belief()',
      '$.steps.belief',
    );
  if (
    module.steps.choiceTiming !== 'none' &&
    typeof module.transcript.seedCommitment !== 'function'
  )
    fail(
      'INVALID_MODULE',
      'A choice-timed module must publish a seed pre-commitment',
      '$.transcript.seedCommitment',
    );
  if (module.steps.choiceTiming !== 'none' && typeof module.transcript.choicesOf !== 'function')
    fail(
      'INVALID_MODULE',
      'A choice-timed module must expose its decoded choice log',
      '$.transcript.choicesOf',
    );
  assertIdentifier(module.transcript.schema, '$.transcript.schema', 'INVALID_MODULE');
  assertIdentifier(module.book.snapshotSchema, '$.book.snapshotSchema', 'INVALID_MODULE');
  if (
    !Number.isSafeInteger(module.book.maxOpenClaims) ||
    module.book.maxOpenClaims < 1 ||
    module.book.maxOpenClaims > ENGINE_LIMITS.maxRoundClaims
  )
    fail('INVALID_MODULE', 'Book claim budget is outside limits', '$.book.maxOpenClaims');
  if (module.book.positions === 'single' && module.book.maxOpenClaims !== 1)
    fail(
      'INVALID_MODULE',
      'A single-position book must declare exactly one open claim',
      '$.book.maxOpenClaims',
    );
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
  if (!Array.isArray(module.conformance.references) || module.conformance.references.length === 0)
    fail(
      'INVALID_MODULE',
      'Module must declare at least one conformance reference definition',
      '$.conformance.references',
    );
  module.conformance.references.forEach((reference, index) =>
    assertIdentifier(reference?.id, `$.conformance.references[${index}].id`, 'INVALID_MODULE'),
  );

  const timing = module.steps.choiceTiming;
  const guard = (choices: readonly S['choice'][] | undefined): readonly S['choice'][] =>
    assertLoggedChoices(choices, timing) as readonly S['choice'][];
  const choicesOf = module.transcript.choicesOf;

  /**
   * Applies the choice guard on the one path that consumes wire input.
   *
   * A verifier re-derives steps from the transcript's own log, so it never
   * passes through the guarded `steps.derive`. Decoding here costs one extra
   * pure `fromWire` and is dwarfed by the derivation that follows. A decode
   * failure is handed back untouched: the module's own verifier reports it with
   * its own message and path.
   */
  const verify: LifecycleModule<S>['verify'] = (seedHex, definition, input) => {
    if (choicesOf) {
      let decoded: S['transcript'] | undefined;
      try {
        decoded = module.transcript.fromWire(input);
      } catch {
        decoded = undefined;
      }
      if (decoded !== undefined)
        try {
          assertLoggedChoices(choicesOf.call(module.transcript, decoded), timing, '$.choices');
        } catch (error) {
          return classifyVerificationError(error);
        }
    }
    return module.verify(seedHex, definition, input);
  };

  return Object.freeze({
    ...module,
    verify,
    definitions: Object.freeze({ ...module.definitions }),
    truth: Object.freeze({ ...module.truth }),
    steps: Object.freeze({
      ...module.steps,
      derive: (seedHex, definition, round, truth, choices) =>
        module.steps.derive(seedHex, definition, round, truth, guard(choices)),
    } satisfies StepModel<S>),
    transcript: Object.freeze({
      ...module.transcript,
      acceptedSchemas: Object.freeze([...module.transcript.acceptedSchemas]),
      build: (seedHex, definition, roundId, choices) =>
        module.transcript.build(seedHex, definition, roundId, guard(choices)),
      commitmentBody: (definition, round, truth, steps, choices) =>
        module.transcript.commitmentBody(definition, round, truth, steps, guard(choices)),
    } satisfies TranscriptModel<S>),
    book: Object.freeze({ ...module.book, actions: Object.freeze([...module.book.actions]) }),
    conformance: Object.freeze({
      ...module.conformance,
      checks: Object.freeze([...module.conformance.checks]),
      references: Object.freeze(module.conformance.references.map((r) => Object.freeze({ ...r }))),
    }),
  });
}
