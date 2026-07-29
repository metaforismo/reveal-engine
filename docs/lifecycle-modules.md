# Lifecycle modules

Reveal Engine is a shared core plus a set of **lifecycle modules**. Core owns
everything that must behave identically in every game. A module owns the
game-shaped decisions: what the hidden truth is, what a step reveals, what a
player can claim, and how a round settles.

This document is the normative description of that boundary. The executable
version is `src/core/module.ts`; the reference implementation is
`src/modules/progressive-market/`.

## What core owns

| Core concern                 | Where                   | Why it is not a module's business                                        |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------ |
| Exact rational BigInt math   | `core/rational.ts`      | One rounding bug is a real-money bug; there is one implementation        |
| Non-negative belief weights  | `core/weights.ts`       | Elimination must be exactly zero, never an epsilon                       |
| Exact combinatorial counts   | `core/combinatorics.ts` | A paytable over orderings prices events, not indices                     |
| Seeded rejection sampling    | `core/random.ts`        | Modulo bias and domain reuse are the classic RNG failures                |
| Commit-reveal sealing        | `core/commitment.ts`    | A module supplies bytes; core decides how a seed binds them              |
| Payable floor and caps       | `core/payments.ts`      | Every credit boundary applies the same cap arithmetic                    |
| Command ledger and cap chain | `core/ledger.ts`        | Idempotency, fencing, receipts, and the ceiling are identical everywhere |
| Snapshot wire safety         | `core/snapshot.ts`      | Reconnect state is attacker-controlled in every game                     |
| Verification taxonomy        | `core/verification.ts`  | A verifier must never leak an incidental exception                       |
| Module contract              | `core/module.ts`        | This document                                                            |

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
  claim: unknown; // one priced claim: an index, a bet, a per-entity contract
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
who has published a commitment cannot change what it means — and so that no
player decision can change it either. `encode()` returns the canonical fields
that bind the truth into the commitment body. `enumerate()` is optional and
exists so tests can be exhaustive rather than statistical when the truth space
is small.

Randomness comes from `core/random.ts` only:

- `uniformBigInt` — rejection sampling for any modulus below `2^256`, domain
  separated by `(definitionId, roundId, proofVersion, label, counter)`;
- `uniformPermutation` — seeded Fisher-Yates, for committed deck shuffles and
  ordering truths;
- `RandomTape` — a recorded, replayable expansion of one seed, addressed by
  `(label, counter)` and digestible into a commitment body. It is the truth
  model for a lifecycle whose randomness is consumed stage by stage: derive the
  whole tape from the seed up front, and let the choices decide how each draw is
  _read_, never what it is.

### 3. Step model

`maxSteps`, `choiceTiming`, `beliefSpace`, `count`, `derive`, `encode`, `equal`,
`belief`, and `price` when the belief space is marginal.

`derive(seed, definition, round, truth, choices)` receives the logged player
choices. A module whose steps depend on decisions — pick a contract, _then_
resolve the stage — stays a pure function of (seed-committed randomness, logged
choices), which is exactly what makes its transcript verifiable. Modules with
`choiceTiming: 'none'` receive an empty array and must ignore it; passing them a
non-empty one is `INVALID_CHOICE`. `defineLifecycleModule()` wraps `derive`,
`build`, and `commitmentBody` so `ENGINE_LIMITS.maxLoggedChoices` is enforced on
every path without the module doing anything.

`belief(definition, steps)` returns exact non-negative weights after a step
prefix. **Zero is a legal weight.** A step that eliminates an outcome sets its
weight to exactly `0n`; `weightVector` then rejects the impossible case where
every outcome is eliminated. (A module where "everything is eliminated" is a
legal state — a survival round where no entity is left — must model that state
as an outcome of its own rather than as an empty vector.)

`beliefSpace` says what that vector actually is:

| `beliefSpace` | Meaning                                                                         | Pricing                                        |
| ------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- |
| `outcomes`    | the vector **is** the space claims are priced from; a claim indexes it          | `weightProbability(belief(...), index)`        |
| `marginal`    | the truth space is combinatorial; the vector is a per-item view, not the prices | `price(definition, steps, claim)` is mandatory |

This distinction exists because a flat vector is bounded by
`ENGINE_LIMITS.maxOutcomes = 64`, and a paytable over orderings is not: `5!` is
already 120 and a trifecta over eight runners is one of 336 events. A `marginal`
module prices its claims by exact counting —
`countingProbability(favourable, support)` over `factorial` /
`fallingFactorial` — and `defineLifecycleModule()` refuses to build it without
a `price()` implementation.

A step schedule must not leak the truth through its _structure_. Likelihood
strengths, labels, and ordering have to look identical whichever truth was
drawn; only the targets may differ. Conformance checks this by sweeping every
truth for a fixed seed.

### 4. Transcript schema and versioning

`schema`, `acceptedSchemas`, `build`, `commitmentBody`, `seedCommitment`,
`toWire`, `fromWire`.

Each module owns its own schema string and its own migration set. Core never
parses a module transcript.

- `schema` is the current wire version, e.g. `reveal-engine/transcript-v2`.
- `acceptedSchemas` lists every schema `fromWire` accepts, newest first.
  Anything else fails closed with `UNSUPPORTED_VERSION`.
- `commitmentBody` returns the canonical bytes that core seals. It **must**
  bind the module id, the definition identity and fingerprint, the round id, the
  truth, every step, **and every logged choice**. Fields are length-prefixed by
  `encodeFields`, so no two distinct rounds can encode to the same bytes. Omit
  the choice log and an operator holding one published commitment can settle the
  same round twice under different decisions, and both settlements verify.
- `fromWire` is the untrusted-input boundary: exact key sets, canonical decimal
  BigInt strings, bounded lengths, no coercion.

#### Pre-commitment for choice-timed rounds

`sealCommitment(seed, body)` needs the finished round. A module with
`choiceTiming: 'before-step'` does not have one until the round is over — but
the player's first decision must already be covered by something published.
Two-phase commitment is the answer, and it is mandatory: a module whose
`choiceTiming` is not `none` must implement `seedCommitment`, and
`defineLifecycleModule()` rejects it otherwise.

1. **Before the round opens**, publish
   `sealSeedCommitment(seed, {moduleId, definitionId, definitionFingerprint,
roundId, proofVersion})`. It binds the seed and the frozen economics and
   reveals nothing — it is a hash of an unrevealed 32-byte seed.
2. **At settlement**, publish the transcript and the revealed seed. A verifier
   re-derives the seed commitment and compares it in constant time against what
   was published in phase 1, then re-derives truth, steps, and the body
   commitment.

The two mechanisms answer different questions and a choice-timed module needs
both. `RandomTape` proves the draws are the expansion of _some_ seed, in order —
it says nothing about _when_ that seed was chosen. The seed commitment is what
proves the seed predates every decision. Neither addresses seed _grinding_
before publication, which is a custody and publication-ordering problem outside
this library; see [`threat-model.md`](threat-model.md).

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

`snapshotSchema`, `positions`, `settlement`, `maxOpenClaims`, `actions`,
`create`, `restore`, `snapshot`.

`positions` is `single` or `multi`; `maxOpenClaims` is the number that backs it
(a `single` book must declare exactly `1`, and every book is bounded by
`ENGINE_LIMITS.maxRoundClaims`). `settlement` is `winner-takes-claim`,
`paytable`, or `partial`. These are declarations a host branches on before it
calls anything: a single-position market and a multi-position card game need
different reserve maths and different receipt volumes.

A book must build its money behaviour on `CommandLedger`, and there is exactly
**one ledger per round** however many positions it holds — per-position ledgers
would fork both the command serialization order and the dense ledger-revision
chain that the snapshot format depends on.

- `serial()` — one command at a time, so a duplicate can never interleave with
  its original;
- `execute(key, fingerprint, operation)` — an exact retry replays the stored
  receipt; the same key with a different payload or action is an
  `IDEMPOTENCY_CONFLICT`, never a silently wrong receipt;
- `mint()` — compute the receipt **before** mutating module state, so a
  rejection leaves the round untouched;
- `fundStake(amount, funding)` / `creditWithinCap()` — the cap chain.

#### The cap chain, and why funding source is the only thing that matters

The round's ceiling is `capBasisStake * maxWinMultiple`, and the invariant every
book preserves is:

> `liquidBalance` never exceeds `capBasisStake * maxWinMultiple`.

`fundStake` is the only way the basis moves, and it moves on exactly one
distinction:

- **`external`** — new money from the player's wallet. It _accumulates_ into the
  basis. A book holding three independently funded positions has a ceiling
  proportional to all three, because that is what the player risked. Pinning the
  ceiling to whichever position happened to be staked first would crush the
  others: with a 10x cap, staking 1 on a loser and 10,000 on a winner would pay
  10 on a legitimate claim of 38,800.
- **`recycled`** — value the player already won inside this round, put back at
  risk. It is debited from the liquid balance and must **never** grow the basis.
  If a win could finance a larger ceiling, the cap would compound and the round's
  maximum exposure would be unbounded. `fundStake` enforces self-financing here
  rather than trusting the module.

`creditWithinCap()` floors the exact rational claim and bounds it by
`ceiling - liquidBalance`, so value already withdrawn reduces what remains.
Crediting a round that has taken no stake at all is a module state-machine bug
and fails loudly with `CLAIM_REJECTED`; it does not silently pay zero.

`restore()` must re-validate rather than trust: replay the steps, check the
definition identity, run the receipt log through `install()` with the module's
own state-machine rules, and reconcile the reconstructed balance against the
snapshot before installing it with `restoreBalances()`.

Anything a snapshot asserts about _what the player did_ must be re-derived from
the receipt log, not read out of the snapshot. Recompute each receipt's
`commandFingerprint` from the restored state and compare: that is what stops a
rewritten claim list or a rewritten decision log from surviving a reconnect
under a recomputed checksum. A choice-timed module has to do this — its
settlement proof is a function of the decision log, so the log is money-bearing
state.

### 6. Verifier

`verify(seed, definition, input) -> VerificationResult`.

Required phase order:

1. decode the wire form (`transcript.fromWire`);
2. check definition identity;
3. for a choice-timed module, re-derive the **seed pre-commitment** and compare;
4. re-derive the truth and compare;
5. re-derive the steps, using the transcript's own logged choices, and compare;
6. re-seal `commitmentBody` (truth, steps, choices) and compare in constant time.

Every failure must be one of the public codes — `INVALID_TRANSCRIPT`,
`UNSUPPORTED_VERSION`, `DEFINITION_MISMATCH`, `DERIVATION_FAILED`,
`TRANSCRIPT_MISMATCH`, `COMMITMENT_MISMATCH` — produced with
`verificationFailure()`, and any unexpected throw must go through
`classifyVerificationError()`. A verifier never returns a parser stack trace.
Compare commitments with `constantTimeHexEqual`, never `!==`.

(`ADAPTER_MISMATCH` is the progressive market's older spelling of
`DEFINITION_MISMATCH`, retained because hosts branch on it. A module with no
adapter uses `DEFINITION_MISMATCH`. The same applies to `OPEN_REJECTED` /
`SELL_REJECTED` / `SETTLE_REJECTED`, whose game-agnostic replacement is
`CLAIM_REJECTED`.)

### 7. Conformance hooks

`defaultSeeds`, a list of `ModuleConformanceCheck`s, and `references`.

Each check has a `code`, a `description`, a `scope` (`definition` runs once,
`round` runs once per seed), and a `run(context)` returning failures. The
context supplies the module, the definition, a deterministic seed, a round
identity, and a `count()` sink for module-specific evidence. Checks are
synchronous.

`references` is the list of `{id, definition}` pairs the module ships as its own
conformance subjects. `src/cli/conformance.ts` iterates the registry and runs
every module's references, so a new module appears in `reveal-conformance` — and
therefore in the CI conformance step — by registering itself and declaring them.
Nothing in the CLI is module-specific and adding a module must never require
editing it.

Every module should at minimum check: definitions are deeply frozen, derivation
is deterministic and frozen, step structure does not vary with the truth, a
built transcript verifies against its own seed, beliefs normalise exactly, and
`restore()` round-trips its own snapshot while rejecting tampered ones.

### What `defineLifecycleModule()` cannot check

It validates declarations, not behaviour. A module that passes it may still be
wrong in ways only conformance checks and tests can catch:

- that `restore()` re-validates instead of returning a fresh empty book — both
  satisfy the type, and only a tampered-snapshot check tells them apart;
- that `verify()` compares in constant time rather than with `!==`;
- that `commitmentBody()` binds everything it claims to bind;
- that step structure does not leak the truth.

That is why `references` and a real check list are part of the contract rather
than a nicety.

## Worked shapes

The contract was designed against four shapes, not one.

| Module               | Truth                       | Steps                          | Choices     | Book                                           |
| -------------------- | --------------------------- | ------------------------------ | ----------- | ---------------------------------------------- |
| `progressive-market` | `scalar-index`              | Bayesian evidence stream       | none        | single position, winner-takes-claim            |
| `sequential-cards`   | `permutation` (deck order)  | reveals that zero out outcomes | none        | multi position, independent sells and switches |
| `staged-survival`    | `composite` (a random tape) | stage resolutions              | before-step | multi claim, partial banking                   |
| `permutation`        | `permutation` of n items    | ordering reveals               | none        | multi bet, paytable settlement                 |

Only `progressive-market` ships today. The other three are the immediate next
modules and are named here so the contract is judged against them.

Two **test-only** modules under `tests/support/` — not registered, not games —
exercise the parts of the contract the progressive market does not use, so the
contract is proved by something other than its first client:

| Fixture                             | Proves                                                                                                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ordering-fixture-module.ts`        | permutation truth, steps that reach posterior exactly zero, a `marginal` belief space priced by exact counting, a multi-claim paytable book whose positions each raise the cap basis, and a re-validating `restore()` |
| `staged-survival-fixture-module.ts` | `choiceTiming: 'before-step'`, a `RandomTape` truth, a commitment body that binds the choice log, a seed pre-commitment published before the first decision, and per-entity partial claims banked in subsets          |

## Adding a module

1. Create `src/modules/<id>/` with `contracts.ts`, `shape.ts`, `validation.ts`,
   the truth/step derivation, `transcript.ts`, the book, `checks.ts`, and
   `module.ts`.
2. Implement the six contracts and the verifier. Reuse core; do not
   reimplement sampling, sealing, rounding, or the ledger.
3. Freeze at least one wire fixture per schema under `tests/fixtures/` and add a
   test that verifies it by re-derivation. Fixtures are committed files compared
   field for field, never round trips generated at run time.
4. Declare conformance checks **and `conformance.references`**, then add the
   module to `src/modules/index.ts`. That is what wires it into
   `reveal-conformance` and CI.
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
