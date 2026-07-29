# Changelog

## Unreleased

### Added

- **The AETHER ORDER engine contract** (`src/modules/permutation/aether/`,
  package subpath `./modules/permutation/aether`): a full implementation of
  `aether-order/docs/ENGINE.md`, which declares itself normative and demands
  byte-identical commitments, ticket digests, receipt digests and signatures.
  Covers §2 identity and schemas, §4 adapter-supplied `BetFamily` catalogues
  with a behavioural catalogue digest and adapter fingerprint, §5–§7 seed
  commitment, client-seed and nonce-bearing sampler, chained transcripts,
  tickets with derived idempotency keys, exact settlement, Ed25519 receipts and
  round snapshots, §8 all twelve conformance checks, and §9's error vocabulary.
  The eleven AETHER ORDER families ship as a **reference adapter**, so an
  integrator can supply their own catalogue and it will be priced, digested and
  fingerprinted. `docs/adr/0005` argues the decision.

  Proved, not asserted: `tests/aether-frozen-fixtures.test.ts` re-derives all
  **eight** rounds frozen in the game repository and requires every digest and
  every deterministic Ed25519 signature to match byte for byte. ENGINE.md §10
  says "if a single commitment digest differs, the port is wrong"; none differs.

  This closes a review finding that the module **could not drive AETHER ORDER
  although it shipped AETHER ORDER references** — six of eleven families, the
  client seed, the nonce, the seed commitment, round chaining and three wire
  schemas were all absent, and the module owned its catalogue so an adapter
  could not add them.

- `PERMUTATION_ERROR_CODES` in `src/api/errors.ts`, the eight wire codes
  ENGINE.md §9 requires, as a separate group so a reader can still see which
  public contract introduced each code. `CORE_ERROR_CODES` and
  `MODULE_ERROR_CODES` are unchanged.
- `DERIVATION_OFF_SCHEDULE` conformance check plus
  `tests/shuffle-uniformity.test.ts`: the shipped derivation is now pinned to
  the draw schedule it documents. `SHUFFLE_NOT_BIJECTIVE` proves a property of
  the algorithm and never calls the sampler, so a naive-shuffle edit to
  `core/random.ts` previously passed conformance green and survived
  `npm run fixtures:update` at 565/566. It now fails all three references and
  nine tests, and neither is a fixture.
- `tests/sampler-unbiased.test.ts`: the evidence `docs/modules/permutation.md`
  §2 Lemma B used to cite and that did not exist. Checks the acceptance boundary
  over every modulus in `1..512`, **executes** the rejection branch at
  `M = 2^255 + 1` where half of all draws reject — for the moduli in real use it
  fires with probability `~2^-254` and no test had ever taken it — and
  chi-squares the residues, each with a decoy the same bound must reject.
- `representativeInstance`, so `definePermutationGame` no longer materialises
  all `n!` `full` orders to read element zero: 17.3 ms per call at `n = 8`
  becomes 0.042 ms.

### Fixed

- **`PermutationBook.restore()` claimed "a rewritten ticket cannot survive its
  own log". It can.** `commandFingerprint` is an unkeyed SHA-256 over public
  fields and is an export, so a forger rewrites the log alongside the ticket: a
  5,000-chip line nobody placed restores a balance of 576,120 against an honest
  120, while the caller passes the correct published round. The claim is gone,
  the residual is widened from "which round" to the entire ticket and its
  accounting across `docs/modules/permutation.md` §9.2, `docs/threat-model.md`
  and `docs/integration-checklist.md`, and both forgeries are executed in
  `tests/security/snapshot-mutation.test.ts`.
- `docs/lifecycle-modules.md` now carries the caveat the module doc does: "no
  core change" was bought by narrowing two of the contract's five book slots, so
  a host driving the registry polymorphically must downcast to open or reconnect
  a real permutation round.
- `docs/modules/permutation.md` §11 no longer opens "this module is compatible
  with the part of it that concerns the draw", which was true of the semantics
  and false of the bytes.

- **The `permutation` lifecycle module** (`src/modules/permutation/`,
  documented in `docs/modules/permutation.md`): a committed permutation of
  `n` labeled items (`3 <= n <= 8`) drawn by core's seeded Fisher-Yates, settled
  as a multi-bet ticket against a published paytable. Five bet families —
  `full`, `slot`, `first`, `last`, `stack` — priced by **exact factorial
  enumeration** over the orders still consistent with the revealed prefix. No
  float, no simulation, and no core file changed: the second module landed
  inside the `reveal-engine/module-v1` contract exactly as it stands, and §10 of
  the module doc records the two places it came closest not to.
- Reference adapters: `aether-order-classic` (`n = 5`) and `aether-order-seven`
  (`n = 7`), reproducing the AETHER ORDER paytable from
  `aether-order/docs/MATH.md` at `rho = 24/25` exactly, plus `triad` (`n = 3`)
  at the supported floor. All three are declared as
  `conformance.references`, so they run in `reveal-conformance` and in CI.
- Eleven conformance checks for the module, six of them exhaustive rather than
  sampled: `SHUFFLE_NOT_BIJECTIVE` walks every one of the `n!` Fisher-Yates draw
  vectors, `STEP_STRUCTURE_LEAKS_TRUTH` sweeps every `n!` truth, and
  `CLAIM_IDENTITY_NOT_BEHAVIOURAL` proves the `O(n)` claim signature groups
  instances exactly as the `O(n!)` win set does.
- An independent oracle suite (`tests/permutation-oracle.test.ts`): closed-form
  factorial probabilities for every instance at `n = 5` and `n = 7`, exhaustive
  win-counting over the whole order space, an exhaustive conditional sweep over
  all 206 reachable prefixes at `n = 5`, and realised RTP measured by brute force
  over every outcome. It shares no code with the module — different permutation
  generator, its own factorials, resolve predicates written from the rules in
  prose.
- Frozen wire fixtures for the two new formats,
  `permutation-transcript-v1` and `permutation-book-v2`
  (`tests/fixtures/`, regenerated with `npm run fixtures:update`), covering a
  settled three-line ticket with a deliberate loser on a bound round.
  `permutation-book-v1.json` is kept as the frozen **negative** fixture: it is
  the retired, unbindable format, and the suite asserts it is refused.
- Package export `./modules/permutation`, wired into `scripts/package-smoke.mjs`
  and the public-API snapshot. The module is deliberately **not** re-exported
  from the package root: the root's progressive-market symbols exist only as
  deprecated 0.2 compatibility, and a module landing today has no such debt.
- **A `PermutationBook` is bound to a published round before it may take a bet.**
  The constructor takes `(definition, binding)` — or `bind()` supplies one while
  the book still holds no claim — and `place()` refuses an unbound book while
  `settle()` refuses any transcript naming a different `roundId` or opening a
  different `commitment`, compared in constant time and checked before the proof
  is verified. Without it, "the transcript verifies" was the only question asked
  at settlement, and it is the wrong one: every transcript this module builds
  verifies, so an operator holding a placed ticket could derive rounds until one
  settled it at zero and settle against that, with every artefact still checking
  out. `docs/modules/permutation.md` §9.1 carries the argument and §11.1 states
  plainly what the module still cannot enforce — it cannot see whether or when
  the commitment it was handed was actually published, which stays a host
  ordering control.
- A `place` command's fingerprint now covers the round binding as well as the bet
  and the stake, so a **partial** rewrite of a snapshot — the binding moved and
  the receipts left alone — contradicts its own log and is refused. That is the
  full extent of what the fingerprint buys, and it is not enough on its own:
  `commandFingerprint` is an unkeyed SHA-256 over public fields and the
  transcript builders are public exports, so anyone who can rewrite the snapshot
  can recompute every fingerprint and the checksum and produce a **consistent**
  snapshot of a different round. That artefact is indistinguishable from an
  honest one by any in-process check, at any stake, staked or settled.
- **`PermutationBook.restore()` therefore requires the round the caller published
  whenever the snapshot carries a binding.** A restored book's round comes from
  the caller and never from the snapshot; the snapshot's own binding is
  reconciled against it. Omitting it on a bound snapshot fails with
  `CLAIM_REJECTED` at `$.expected`, and naming a different round fails with
  `COMMITMENT_MISMATCH` at `$.binding`. That value must be read from the
  published-round record rather than from the snapshot store, which is now a line
  in `docs/integration-checklist.md`.
- The lifecycle contract's two-argument `book.restore(definition, snapshot)`
  consequently restores **only unbound snapshots** and refuses every bound one.
  This is the same deliberate narrowness as the contract's `create`, which
  returns an unbound book: the signature has no round to hand over, so the states
  it can reach are the states in which no money is at risk. A host reconnecting a
  real ticket calls `PermutationBook.restore(definition, snapshot, round)` — the
  class is this shape's `book` type, so resolving the module by id already
  reaches it. The unsafe path is gone rather than documented.
- A terminal `permutation-book-v2` snapshot carries the round id and the
  **revealed seed**, so `restore()` re-derives the settled order and commitment
  from the proof rather than reconciling them against the credit. Reconciling
  the credit alone is not sufficient — two different orders can pay a ticket the
  same amount, trivially any two under which every line loses — so a snapshot
  naming the wrong order would have restored cleanly under a recomputed
  checksum. Publishing the seed in a _settled_ snapshot discloses nothing: the
  reveal is what closes the round.

### Changed

- The module registry now lists two lifecycle modules. `listModules()` returns
  `['progressive-market', 'permutation']`, and the snapshot tests that pin that
  surface were extended rather than relaxed.
- **Book snapshot schema `reveal-engine/permutation-book-v1` is retired with no
  migration**, replaced by `-v2` which carries the round binding and the settle
  command's idempotency key. There is no honest migration: the field `v1` lacks
  is the published commitment, and nothing in a `v1` snapshot says what it was —
  reconstructing one from the settlement the snapshot already carries would
  manufacture the evidence the binding exists to supply. `v1` is refused with
  `UNSUPPORTED_VERSION` and a message that says why. The format never shipped
  outside this branch.
- `restore()` now pins the two receipt fields that move no balance and were
  therefore free: a `place` receipt's `capped` flag (always `false` — a debit
  cannot meet a credit ceiling) and the `settle` receipt's idempotency key,
  which the settlement record now carries so that every receipt's key is named
  by the state that receipt produced. Both are audit-integrity rather than money
  bugs, which is exactly why nothing else would have caught them: a restored
  receipt log that disagrees with the operator's command log reconciles
  perfectly.

### Fixed

- **A false security claim about snapshot restore, in four places.** The module
  doc (§9.1, §12), `PermutationBook.restore`'s own comment and this changelog all
  said that binding the round into the `place` command fingerprint stopped a
  staked or settled snapshot being re-pointed at another round. It does not: the
  fingerprint is an unkeyed hash over public fields, so the rewrite is consistent,
  cheap and undetectable — and the module's own test file said so in a comment,
  so the repository contradicted itself on a fairness surface. All four now state
  what is true, `restore()` requires the published round for any bound snapshot,
  and the two facts are pinned by tests that build the working rewrite rather than
  by prose. See Added above.
- `stakedSnapshotFor` is no longer exported from `./modules/permutation`. It is
  conformance scaffolding — a staked snapshot synthesised without the book's
  async command API — and had no business on a surface the package promises to
  keep stable. It stays exported from `checks.ts` for the tests and checks that
  need it, exactly as `progressive-market` keeps its own.
- `npm run fixtures:update` leaves a clean tree. It wrote `JSON.stringify(…, 2)`
  output, which disagrees with prettier about arrays, so the documented
  regeneration command produced whitespace-only diffs in all three regenerated
  fixtures and `npm run verify` then failed at its first step. The script now
  formats what it writes with the repository's own prettier config, and
  regenerating an unchanged tree is byte-identical.
- `docs/modules/permutation.md` §2 and `permutationRound()` no longer restate
  core's "two games and two rounds never share a draw" without its caveat.
  `samplerScopeOf` maps `domain = definitionId` and drops `moduleId`, so
  cross-module separation holds by definition-id uniqueness across the registry
  rather than by construction. Nothing is exploitable — the commitment body binds
  the module id — but the caveat belongs with the claim.
- `enumerateOrders(n)` is bounded to the module's supported draw sizes, like
  every other counting entry point. It was checked only for `n >= 0`, so a host
  forwarding a caller-supplied size had an unbounded allocation: `n = 13` is
  6.2e9 orders and `n = 20` never returns.
- `enumerateInstances()` and `betParameters()` raise `CLAIM_REJECTED` on an
  unknown bet code instead of falling past every `switch` case and returning
  `undefined` three frames from where it breaks.
- `assertBet()` enforces an exact key set per bet code. `{code: 'first', item: 0,
position: 9}` was silently accepted as `first{0}`, so a host typo became a
  different, cheaper claim — inert on the money path, because `betParameters()`
  normalises what reaches the fingerprint and the wire, but a claim the player
  did not ask for is not something to accept quietly.
- The module's shadowed `INVALID_CHOICE` guard in `transcript.commitmentBody` is
  gone. `defineLifecycleModule()` raises it first for `choiceTiming: 'none'`, so
  the module's copy was unreachable and the test that read as proving it was
  exercising core. What makes the omission safe is stated and tested instead:
  `permutationCommitmentBody` has no choice parameter at all.

## 0.3.0 — 2026-07-29

Platform restructuring: a game-agnostic core plus lifecycle modules as siblings.

### Added

- `reveal-engine/module-v1`, the lifecycle-module contract (`src/core/module.ts`,
  documented in `docs/lifecycle-modules.md`): definition model, truth model, step
  and choice semantics, transcript schema and versioning, book and claim
  semantics, verifier phase order, and conformance hooks.
- Core primitives every module builds on: `weights.ts` (exact non-negative
  belief weights where zero is a legal, exactly-zero elimination),
  `combinatorics.ts` (`factorial`, `fallingFactorial`, `countingProbability` —
  exact pricing for a truth space too large to flatten into a weight vector),
  `random.ts` (`uniformPermutation`, `RandomTape`), `commitment.ts`
  (`sealCommitment`, `sealSeedCommitment`), `ledger.ts` (`CommandLedger` —
  serialization, idempotency, receipts, cap chain), `snapshot.ts`,
  `verification.ts`, `versions.ts`.
- Two-phase commitment for rounds whose steps consume player decisions:
  `sealSeedCommitment()` publishes the seed before the first choice exists, and
  `TranscriptModel.commitmentBody` binds the logged choice log so one published
  commitment cannot be re-settled under different decisions. Required by
  `defineLifecycleModule()` for any module whose `choiceTiming` is not `none`.
  See `docs/adr/0002-cap-basis-and-choice-timed-commitment.md`.
- `StepModel.beliefSpace` and `StepModel.price()`: a module whose truth space is
  combinatorial declares that its weight vector is a marginal view rather than
  its pricing space, and prices claims by exact counting instead.
- `TranscriptModel.choicesOf`, required whenever `choiceTiming` is not `none`.
  It is how `defineLifecycleModule()` reaches the decoded choice log on the
  `verify()` path — the one entry point that reads a choice list off the wire
  and the one the guard previously missed. See
  `docs/adr/0003-snapshot-derivation-and-the-choice-guard.md`.
- `SNAPSHOT_NOT_REVALIDATED` conformance check for `progressive-market`, so the
  CI conformance step exercises restore-tampering for the registered module: a
  staked mid-round snapshot restored and then re-sealed with each of seven
  tampered fields, including both money-bearing position fields.
- Frozen wire fixtures for `receipt-v1` and `round-book-v1`
  (`tests/fixtures/`, regenerated with `npm run fixtures:update`), and a
  comparison of the seeded stress workload's `correctnessDigest` against its
  committed baseline.
- Two test-only contract fixtures under `tests/support/`: a permutation truth
  with a combinatorial paytable and a multi-position book, and a choice-timed
  survival round with a seed pre-commitment and per-entity partial claims.
- Game-agnostic error codes `DEFINITION_MISMATCH`, `CLAIM_REJECTED`, and
  `INVALID_CHOICE`. The progressive market's `ADAPTER_MISMATCH`,
  `OPEN_REJECTED`, `SELL_REJECTED`, and `SETTLE_REJECTED` remain for wire
  compatibility.
- `src/modules/index.ts` module registry with `listModules`, `findModule`,
  `requireModule`, and the `UNKNOWN_MODULE` error code.
- Module-agnostic conformance runner and `reveal-engine/module-conformance-v1`
  report.
- `deriveMaxContinuations`, adopted from the adoption-bridge branch
  (`docs/adr/0001-branch-adoption.md`).
- Package subpaths `./modules` and `./modules/progressive-market`.
- `CommandLedger.creditClaim(theoretical, mint)`: prices a claim against the
  remaining ceiling, mints its receipt, and applies the credit as one step, so
  the cap chain cannot be half-performed. `creditWithinCap()` is a pure query
  and `applyCredit()` is the only call that moves the balance — a book that made
  the first without the second credited its full ceiling once per claim, with
  `capped: false` on every receipt. Both halves are now documented as mandatory
  in `docs/lifecycle-modules.md` §5, and `progressive-market` plus both fixtures
  go through the atomic call. See `docs/adr/0004`.
- `ModuleConformanceReport.ran`: how many times each declared check actually
  executed. `checks` states what was declared; `ran` states what was proved.
- `ENGINE_LIMITS.maxConformanceSeeds` (4,096), which was already the conformance
  runner's hard-coded bound.

### Changed

- The progressive-market lifecycle (single hidden truth, Bayesian evidence
  stream, single-position book) moved from the engine spine to
  `src/modules/progressive-market/`. It is now one module among several rather
  than the engine itself.
- `RoundBook` keeps its exact behavior and wire formats but now composes
  `CommandLedger` instead of owning idempotency, receipts, and cap accounting.
- **Breaking (core):** `CommandLedger.fundStake(amount, funding)` replaces
  `adoptCapBasis()` and `applyDebit()`. The cap basis accumulates externally
  funded stakes and ignores recycled winnings, instead of being pinned to the
  round's first stake — a single-basis chain crushed legitimate multi-position
  claims. The round invariant `liquidBalance <= capBasisStake * maxWinMultiple`
  is unchanged. `creditWithinCap()` on a round that has taken no stake now
  fails with `CLAIM_REJECTED` instead of silently crediting zero.
- **Breaking (core):** `TranscriptModel.commitmentBody` takes a fifth `choices`
  argument; `BookModel` requires `maxOpenClaims`; `StepModel` requires
  `beliefSpace`; `ConformanceModel` requires `references`.
- **Breaking (core):** `StepModel.belief` is optional when `beliefSpace` is
  `marginal` and required when it is `outcomes`. `weightVector` admits 2..64
  entries, so a marginal module whose per-item space is larger — a multi-deck
  shoe, a large field — previously could not satisfy the contract at all.
- `core/combinatorics.ts` bounds an exact count by `ENGINE_LIMITS.maxBigIntBits`
  and reports it as `INVALID_WEIGHTS`. `maxPermutationSize` (1,024) bounds
  shuffling and `maxBigIntBits` bounds what a `Rational` can carry — `536!` is
  4,092 bits — and the two used to disagree silently, surfacing as an
  `INVALID_RATIONAL` from another module.
- `stableJson` orders keys by UTF-16 code unit instead of `localeCompare`. It
  anchors `snapshotHash`, so its order must be a property of the bytes and not
  of the host's ICU data or default locale. No in-repo digest changes.
- `ENGINE_LIMITS.maxLoggedChoices` and `maxRoundClaims` are enforced —
  `defineLifecycleModule()` guards every choice-consuming entry point and
  validates the declared claim budget. Both were previously published and
  referenced by no code path.
- `risk.continuation.maxRides` is enforced by `RoundBook.open` instead of only
  being validated and fingerprinted.
- `reveal-conformance` iterates the module registry and each module's declared
  reference definitions instead of hard-coding the progressive market.
- Removed three duplicate core validators left by the extraction
  (`assertRecord`, `assertExactKeys`, `assertRevision`); the snapshot family
  they duplicated is unchanged.
- `./core` is game-agnostic. `./protocol`, `./serialization`, and `./reference`
  remain as deprecated aliases into the module, and every progressive-market
  symbol re-exported from the package root now carries the same `@deprecated`
  marker naming the subpath that owns it. The root barrel mixes engine surface
  with one module's API for 0.2 compatibility; nothing there said which was
  which. The README quickstart imports from the module subpath.
- `defineLifecycleModule()` validates every declaration it can reach: all five
  declared enums (`truth.kind`, `steps.choiceTiming`, `steps.beliefSpace`,
  `book.positions`, `book.settlement`), every mandatory hook, every optional
  hook that is present, `conformance.defaultSeeds`, and each conformance check's
  `code`, `description`, `scope`, and `run`. It previously accepted arbitrary
  strings for four of the enums — a `positions` or `settlement` typo routed a
  host down the wrong reserve-maths branch silently — and accepted a module with
  no `transcript.fromWire`, which is the untrusted-input boundary.
- `StepModel.maxSteps` is enforced: a derivation that returns more steps than the
  module declared fails with `DERIVATION_FAILED`. It previously had no consumer
  beyond its own range check.
- `TruthModel.encode` and `StepModel.encode` are load-bearing rather than
  decorative. `canonicalTranscriptBytes` composes the commitment body out of the
  same two functions the module declares, so the declared encoding _is_ the
  proof-bearing one; both test fixtures do the same, and a contract test rebuilds
  the sealed body from the declared encoders alone. No proof bytes moved.
- `checkModuleConformance` requires `seedCount >= 1`. Zero skipped every
  round-scoped check and still returned `ok: true` with all check codes listed.
- `blackSignalReference` derives its continuation policy instead of declaring
  it: `maxRides` 1 → 2, `adapterVersion` 1.0.0 → 1.1.0, and therefore a new
  fingerprint. This is the only intended replay-visible behavior change.
- `scripts/package-smoke.mjs` now packs, installs, and imports through the
  published `exports` map instead of reading `dist/` paths directly.
- README rewritten for a public audience with an explicit certification
  boundary and module map.

### Fixed

- **Money path.** `RoundBook.restore()` read `position.outcome` and
  `position.contingentPayout` out of the snapshot instead of deriving them, so a
  re-sealed reconnect payload could move a losing position onto the winning
  outcome or inflate its claim and settle for the difference (3,233 against an
  honest 0; the full 250,000 cap ceiling against an honest 1,940). Both are now
  re-derived: the outcome from the open receipt's `commandFingerprint`, the
  payout from the price replayed at `openedAtFrameRevision`. Present on `main`
  as well, and covered by conformance from now on.
- `CommandLedger.install()` rejects a receipt log that reuses an idempotency
  key. It keyed the receipt map by that key, so three receipts sharing one
  passed the dense-revision check, visited the module three times, and installed
  one — leaving the key live for replay.
- Hostile-input regression introduced by the relocation: `scopeOf()` in the
  progressive market's sampler wrappers read `context.gameId` before validating
  it, so `uniform`, `uniformBigInt`, `scopeOf`, and `roundIdentityOf` leaked a
  raw `TypeError` on a null context and reported the wrong code otherwise.
  Verified against `main` side by side: identical code and path on every
  malformed context.
- `assertSamplerScope` reports `INVALID_CONTEXT` for a malformed domain or round
  id instead of inheriting `INVALID_ADAPTER`.
- `fromWireReceipt`, the `CommandLedger` constructor, `checkModuleConformance`,
  `weightGcd`, and `reduceWeights` validate before dereferencing, so
  attacker-shaped wire data produces a typed failure rather than a `TypeError`.
- `deriveMaxContinuations` rejects a base round already below its floor instead
  of returning zero, which was indistinguishable from "no rides permitted".
- `assertClaimBudget` validated `openClaims` strictly and `maxOpenClaims` not at
  all, so `(5, undefined)`, `(5, NaN)`, and `(5, Infinity)` all passed:
  `openClaims >= maxOpenClaims` is `false` for every non-number. It was the only
  core assert in the repository that failed open, and the only core-side bound on
  simultaneous open claims. The budget is now validated as strictly as the count.
- A conformance check whose `scope` was neither `definition` nor `round` never
  ran, while `report.checks` still listed its code and `report.ok` was `true`. It
  is rejected at definition time and by the runner.
- Snapshot tamper cases in `tests/frozen-fixtures.test.ts`,
  `tests/replay-serialization.test.ts`, and the ordering fixture's
  `SNAPSHOT_NOT_REVALIDATED` check kept the original `snapshotHash`, so they were
  rejected by the checksum rather than on their merits — the weaker claim, and
  not the one the contract makes. They re-seal now.

### Unchanged (verified)

- `commit-v2`, `transcript-v1`, and `transcript-v2` verify by re-derivation, and
  `receipt-v1` and `round-book-v1` now have frozen fixtures of their own rather
  than runtime round trips.
- The stress correctness digest is byte-identical to 0.2 (`fdb9e9b8…baef1`), and
  the run now fails if it ever stops being.

## 0.2.0 — 2026-07-27

- Added the stable `api-v1` adapter/public contract, deep runtime validation, typed errors, adapter fingerprints, and mechanical conformance.
- Replaced ambiguous proof encoding with `commit-v2`, deterministic prior-weighted truth, bounded canonical transcript codecs, detailed failure taxonomy, and frozen v1/v2 fixtures.
- Rebuilt protocol frames, exact claims, command-bound idempotency, proof-bound settlement, cap-chain accounting, receipts, snapshots, and deterministic reconnect replay.
- Expanded independent oracle, exhaustive, deterministic property, malformed-input, adversarial race, serialization, package, stress, benchmark, and security evidence.
- Legacy `commit-v1` remains verification-only.

## 0.1.0 — 2026-07-27

- Initial private Axiom Games Reveal Engine foundation with two reference adapters and basic verification tooling.
