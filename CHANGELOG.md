# Changelog

## 0.4.0 — 2026-07-29

The second lifecycle module: `staged-survival`.

### Added

- `staged-survival` (`src/modules/staged-survival/`, documented in
  `docs/modules/staged-survival.md`): N entities through S stages, a stage
  contract chosen from an adapter-defined menu **before** the stage resolves, and
  per-entity contingent claims banked in subsets between stages. Registered in
  `src/modules/index.ts` and exported at `./modules/staged-survival`, so it runs
  in `reveal-conformance` and in the package smoke test without either being
  edited for it.
- **Correlation is a declared property.** A `LaneProfile` is a shared per-lane
  shock `q` plus an independent per-entity clear `c`: the marginal
  `p = (1 - q)c` is the same for every geometry while the joint law is a
  convolution of per-lane binomials mixed with a point mass at zero.
  `q = 0` is exactly zero, so a contract can declare exact independence.
- **A counterfactually complete tape.** The seed expands into a draw for every
  stage, every contract on the menu, every lane slot and every entity —
  `stages x contracts x entities x 2` — before the round opens. A decision
  selects which committed draws are read, never which draws exist, and the
  unchosen routes stay verifiable after the reveal.
- **Player entropy in every draw.** A round is identified by the pair
  `(roundId, clientEntropy)`; the seed pre-commitment binds only the operator
  half, because the entropy does not exist when it is published. See
  `docs/adr/0005-round-entropy-without-a-core-change.md` for why this rides in
  the contract's `roundId: string` rather than through a widened core signature,
  and what that costs.
- **Two mechanical refusals at define time.**
  `marginalSurvival * multiplier === pricing.continuationReturn === 1` for every
  contract, so every route through a round returns the same and the entry margin
  is the whole edge; and, when `risk.capMustBeUnreachable` is declared, the exact
  maximum round return `entryReturn * max(mu)^stages` must sit strictly below
  `risk.maxWinMultiple`.
- Wire formats `staged-survival/transcript-v1` and `staged-survival/book-v1`,
  with frozen fixtures in `tests/fixtures/` compared field for field.
- A mandatory oracle test (`tests/staged-survival-oracle.test.ts`): a
  three-entity, two-stage instance enumerated **exhaustively** against an
  independently coded model — every elementary draw pattern of every reachable
  field, the survivor distribution term for term, the expected value of every
  contract path under every banking policy, and the round cap held across the
  whole chain and shown to bind exactly where the arithmetic says it must.
- Two reference definitions: `fiveRunnerReference` (five runners, three stages,
  `wide`/`split`/`narrow`) and `oracleTrialReference`.

### Changed

- `docs/lifecycle-modules.md`, `README.md` and `docs/api-reference.md` record
  that two modules ship. **No core file was modified.**

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
