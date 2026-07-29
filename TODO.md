# Reveal Engine platform checklist

## 0.3 — core and lifecycle modules (done)

- [x] Split core from the progressive-market lifecycle; relocate the lifecycle into `src/modules/progressive-market/`.
- [x] Extract reusable core primitives: weights, permutations, random tape, commitment sealing, command ledger, snapshot wire safety, verification taxonomy.
- [x] Define, type, and document the lifecycle-module contract (`docs/lifecycle-modules.md`).
- [x] Prove the contract with a module-agnostic conformance runner plus a test-only non-market module.
- [x] Keep every frozen wire fixture verifying and the stress correctness digest identical.
- [x] Record the branch-adoption decision in `docs/adr/0001-branch-adoption.md`.
- [x] Rewrite the README for a public audience with an honest certification boundary.
- [x] Close the contract's guard rails: an atomic `creditClaim`, a fail-closed `assertClaimBudget`, complete declaration validation in `defineLifecycleModule`, and a conformance report that cannot claim a check it did not run (`docs/adr/0004`).

## 0.4 — the second lifecycle module (done)

- [x] `staged-survival`: N entities through S stages, a contract chosen per stage before it resolves, per-entity partial claims, banking subsets between stages. Ships with `fiveRunnerReference` and `oracleTrialReference`, twelve conformance checks, an exhaustive oracle test, frozen `transcript-v1` / `book-v1` fixtures, and `docs/modules/staged-survival.md`. No core file was modified; `docs/adr/0005` records why.
- [x] Give every lifecycle module its own replay anchor in the stress and benchmark artifacts (`moduleDigests`, schemas `stress-v3` / `benchmark-v3`), so a second module can join the workload without disturbing the first module's digest.

## Next modules (other agents)

- [ ] `sequential-cards`: committed deck shuffle, reveals that eliminate outcomes to exactly zero, multi-position book with independent fair-value sells and switches.
- [ ] `permutation`: structured permutation truth with multi-bet paytable settlement.
- [ ] `branching-population`: SWARM's cohort model — a population that _splits_, so draw consumption per stage is the population rather than a shrinking subset of a fixed entity set. Named as not-provided in `docs/modules/staged-survival.md` §10.

## Deferred

- [ ] Adapter-defined lane **geometry**, not only an adapter-defined menu. `laneWidth` cuts the field into consecutive lanes with the remainder last, so the lane count is a function of the field and a later lane is never larger than an earlier one. BRANCHFALL's per-field balance menu (`laneSplits(n)` / `laneSizes(n, k)`, a fixed `laneCount`) is only partly expressible; there is also no `maxEntities` to restrict a contract to the field sizes its balance was designed for. Closing it means a widened `StageContract` with its own fingerprint enumeration and conformance obligation. See `docs/modules/staged-survival.md` §10.
- [ ] Retire the deprecated `./protocol`, `./serialization`, `./reference` aliases **and the progressive-market re-exports from the package root** (`RoundBook`, `makeTranscript`, `deriveTruth`, `initialPosterior`, `quote`, `defineGame`, `adapterFingerprint`, the transcript codec, the adapter conformance view, `progressiveMarket`, the three references) once no consumer depends on them. All of them carry `@deprecated` markers today; see ADR 0004.
- [ ] Decide whether the module contract should become an out-of-tree plugin API (needs a published canonical encoder, a `MODULE_API_VERSION` compatibility policy, and a third-party-code trust decision).
- [ ] Revive the BLACK SIGNAL compatibility corpus in the title repository or a dedicated artifact repository; see ADR 0001.
- [ ] Hosted Actions execution (externally blocked by the account billing/spending limit; no runner steps execute).

## Non-negotiable boundaries

- `BLACK SIGNAL` is a reference integration only. Its art, UI, narrative, and source content do not belong here.
- Engine math never receives tone, compliance copy, or player-facing presentation decisions.
- No certification, fairness, or production-capacity claim is authorised.
