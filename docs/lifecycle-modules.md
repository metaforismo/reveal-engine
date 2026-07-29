# Lifecycle modules

Reveal Engine is a shared core plus a set of **lifecycle modules**. Core owns
everything that must behave identically in every game. A module owns the
game-shaped decisions: what the hidden truth is, what a step reveals, what a
player can claim, and how a round settles.

This document is the normative description of that boundary. The executable
version is `src/core/module.ts`; the reference implementation is
`src/modules/progressive-market/`.

## What core owns

| Core concern                | Where                  | Why it is not a module's business                                          |
| --------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| Exact rational BigInt math  | `core/rational.ts`     | One rounding bug is a real-money bug; there is one implementation          |
| Non-negative belief weights | `core/weights.ts`      | Elimination must be exactly zero, never an epsilon                         |
| Seeded rejection sampling   | `core/random.ts`       | Modulo bias and domain reuse are the classic RNG failures                  |
| Commit-reveal sealing       | `core/commitment.ts`   | A module supplies bytes; core decides how a seed binds them                |
| Payable floor and caps      | `core/payments.ts`     | Every credit boundary applies the same cap arithmetic                      |
| Command ledger              | `core/ledger.ts`       | Idempotency, fencing, receipts, and the cap chain are identical everywhere |
| Snapshot wire safety        | `core/snapshot.ts`     | Reconnect state is attacker-controlled in every game                       |
| Verification taxonomy       | `core/verification.ts` | A verifier must never leak an incidental exception                         |
| Module contract             | `core/module.ts`       | This document                                                              |

Core has **zero runtime dependencies** and no concept of an adapter, a
posterior, a transcript, or a book.

## What a module declares

A module is a frozen object passed through `defineLifecycleModule()`. It
declares identity plus six contracts.

```ts
export interface LifecycleShape {
  definition: unknown; // frozen game configuration
  truth: unknown; // the hidden truth
  step: unknown; // one observable progression step
  choice: unknown; // a logged player decision, or never
  transcript: unknown; // the module's transcript domain object
  book: unknown; // the module's round book
}
```

### 1. Definition model

`define`, `assert`, `fingerprint`, `identity`.

`define()` is the only supported construction path: validate, clone,
deep-freeze. `fingerprint()` is a 32-byte hex digest over **every
replay-visible declarative field** — outcome order, priors, pricing, rounding,
caps, evidence model version. Two configurations that could pay differently must
never share a fingerprint. `identity()` returns
`{moduleId, moduleVersion, definitionId, definitionVersion, fingerprint}`; a
host persists all five per round.

### 2. Truth model

`kind`, `derive`, `encode`, `equal`, optional `enumerate`.

The truth is **not** required to be a scalar index. `kind` is one of
`scalar-index`, `permutation`, `vector`, `composite`. `derive(seed, definition,
roundId)` must be a pure function of the seed and the definition, so an operator
who has published a commitment cannot change what it means. `encode()` returns
the canonical fields that bind the truth into the commitment body.
`enumerate()` is optional and exists so tests can be exhaustive rather than
statistical when the truth space is small.

Randomness comes from `core/random.ts` only:

- `uniformBigInt` — rejection sampling for any modulus below `2^256`, domain
  separated by `(definitionId, roundId, proofVersion, label, counter)`;
- `uniformPermutation` — seeded Fisher-Yates, for committed deck shuffles and
  ordering truths;
- `RandomTape` — a recorded, replayable expansion of one seed, for modules whose
  randomness must interleave with player decisions.

### 3. Step model

`maxSteps`, `choiceTiming`, `count`, `derive`, `encode`, `equal`, `belief`.

`derive(seed, definition, round, truth, choices)` receives the logged player
choices. A module whose steps depend on decisions — pick a contract, _then_
resolve the stage — stays a pure function of (seed-committed randomness, logged
choices), which is exactly what makes its transcript verifiable. Modules with
`choiceTiming: 'none'` receive an empty array and must ignore it.

`belief(definition, steps)` returns exact non-negative weights over the outcome
space after a step prefix. **Zero is a legal weight.** A step that eliminates an
outcome sets its weight to exactly `0n`; `weightVector` then rejects the
impossible case where every outcome is eliminated.

A step schedule must not leak the truth through its _structure_. Likelihood
strengths, labels, and ordering have to look identical whichever truth was
drawn; only the targets may differ. Conformance checks this by sweeping every
truth for a fixed seed.

### 4. Transcript schema and versioning

`schema`, `acceptedSchemas`, `build`, `commitmentBody`, `toWire`, `fromWire`.

Each module owns its own schema string and its own migration set. Core never
parses a module transcript.

- `schema` is the current wire version, e.g. `reveal-engine/transcript-v2`.
- `acceptedSchemas` lists every schema `fromWire` accepts, newest first.
  Anything else fails closed with `UNSUPPORTED_VERSION`.
- `commitmentBody` returns the canonical bytes that core seals. It **must**
  bind the module id, the definition identity and fingerprint, the round id, the
  truth, and every step. Fields are length-prefixed by `encodeFields`, so no two
  distinct rounds can encode to the same bytes.
- `fromWire` is the untrusted-input boundary: exact key sets, canonical decimal
  BigInt strings, bounded lengths, no coercion.

Versioning rules:

| Change                                      | Required                                       |
| ------------------------------------------- | ---------------------------------------------- |
| Any replay-visible behavior of a definition | new `definitionVersion`                        |
| Any change to step derivation               | new evidence/step `modelVersion`               |
| Any change to transcript fields             | new transcript schema + a frozen fixture       |
| Any change to `commitmentBody` layout       | new commitment version, old one verify-only    |
| Any change to snapshot fields               | new snapshot schema; unknown versions rejected |

A migration is pure and deterministic, never invents a missing proof or
economic field, and must keep a frozen fixture verifying.

### 5. Book and claim semantics

`snapshotSchema`, `positions`, `settlement`, `actions`, `create`, `restore`,
`snapshot`.

`positions` is `single` or `multi`. `settlement` is `winner-takes-claim`,
`paytable`, or `partial`. These are declarations a host branches on before it
calls anything: a single-position market and a multi-position card game need
different reserve maths and different receipt volumes.

A book must build its money behaviour on `CommandLedger`:

- `serial()` — one command at a time, so a duplicate can never interleave with
  its original;
- `execute(key, fingerprint, operation)` — an exact retry replays the stored
  receipt; the same key with a different payload or action is an
  `IDEMPOTENCY_CONFLICT`, never a silently wrong receipt;
- `mint()` — compute the receipt **before** mutating module state, so a
  rejection leaves the round untouched;
- `adoptCapBasis()` / `creditWithinCap()` — the first stake of a round fixes the
  cap basis, and no later credit can exceed it, however many claims exist and
  however often value is liquidated and re-staked.

`restore()` must re-validate rather than trust: replay the steps, check the
definition identity, run the receipt log through `install()` with the module's
own state-machine rules, and reconcile the reconstructed balance against the
snapshot before installing it.

### 6. Verifier

`verify(seed, definition, input) -> VerificationResult`.

Required phase order:

1. decode the wire form (`transcript.fromWire`);
2. check definition identity;
3. re-derive the truth and compare;
4. re-derive the steps (with the transcript's logged choices) and compare;
5. re-seal `commitmentBody` and compare in constant time.

Every failure must be one of the six public codes — `INVALID_TRANSCRIPT`,
`UNSUPPORTED_VERSION`, `ADAPTER_MISMATCH`, `DERIVATION_FAILED`,
`TRANSCRIPT_MISMATCH`, `COMMITMENT_MISMATCH` — produced with
`verificationFailure()`, and any unexpected throw must go through
`classifyVerificationError()`. A verifier never returns a parser stack trace.

### 7. Conformance hooks

`defaultSeeds` plus a list of `ModuleConformanceCheck`s, each with a `code`, a
`description`, a `scope` (`definition` runs once, `round` runs once per seed),
and a `run(context)` returning failures. The context supplies the module, the
definition, a deterministic seed, a round identity, and a `count()` sink for
module-specific evidence.

`checkModuleConformance(module, definition, seeds)` runs them and returns a
`reveal-engine/module-conformance-v1` report. A new module gets a conformance
runner, a machine-readable report, and CLI output by declaring its checks.

Every module should at minimum check: definitions are deeply frozen, derivation
is deterministic and frozen, step structure does not vary with the truth, a
built transcript verifies against its own seed, and beliefs normalise exactly.

## Worked shapes

The contract was designed against four shapes, not one.

| Module               | Truth                        | Steps                          | Choices     | Book                                           |
| -------------------- | ---------------------------- | ------------------------------ | ----------- | ---------------------------------------------- |
| `progressive-market` | `scalar-index`               | Bayesian evidence stream       | none        | single position, winner-takes-claim            |
| `sequential-cards`   | `permutation` (deck order)   | reveals that zero out outcomes | none        | multi position, independent sells and switches |
| `staged-survival`    | `composite` (per-stage tape) | stage resolutions              | before-step | multi claim, partial banking                   |
| `permutation`        | `permutation` of n items     | ordering reveals               | none        | multi bet, paytable settlement                 |

Only `progressive-market` ships today. The other three are the immediate next
modules and are named here so the contract is judged against them.

`tests/support/ordering-fixture-module.ts` is a **test-only** module — not
registered, not a game — that exercises the parts of the contract the
progressive market does not use: a permutation truth, steps that drive a
posterior to exactly zero, and a multi-claim book settled from a paytable. It
exists so the contract is proved by something other than its first client.

## Adding a module

1. Create `src/modules/<id>/` with `contracts.ts`, `shape.ts`, `validation.ts`,
   the truth/step derivation, `transcript.ts`, the book, `checks.ts`, and
   `module.ts`.
2. Implement the six contracts and the verifier. Reuse core; do not
   reimplement sampling, sealing, rounding, or the ledger.
3. Freeze at least one wire fixture per schema under `tests/fixtures/` and add a
   test that verifies it by re-derivation.
4. Declare conformance checks and add the module to `src/modules/index.ts`.
5. Add a `./modules/<id>` entry to the package `exports` map and to
   `scripts/package-smoke.mjs`.
6. Extend the public-API snapshot test; the surface is a contract, not an
   accident.

## Deliberate boundary: in-tree only

The contract is an **in-repository extension point**, not a stable out-of-tree
plugin API. Modules live in `src/modules/*` and are registered in a static list.

Making it out-of-tree would additionally require: publishing the canonical
encoder (`internal/canonical.ts`) as a supported export, a compatibility policy
for `MODULE_API_VERSION`, a trust decision about running third-party derivation
code inside the settlement path, and a signed-module story. None of that exists,
and this document does not claim it does.
