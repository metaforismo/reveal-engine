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

## Next modules (other agents)

- [ ] `sequential-cards`: committed deck shuffle, reveals that eliminate outcomes to exactly zero, multi-position book with independent fair-value sells and switches.
- [ ] `staged-survival`: N entities through S stages, a contract chosen per stage before it resolves, per-entity partial claims, banking subsets between stages.
- [x] `permutation`: structured permutation truth with multi-bet paytable settlement. Shipped on `platform/permutation` with no core change; see `docs/modules/permutation.md`.
- [x] `permutation`: the six AETHER ORDER families the lifecycle module does not price (`before`, `early`, `late`, `neighbours`, `opening`, `podium`). Resolved in `src/modules/permutation/aether/`, which takes adapter-supplied `resolve` predicates and prices them exactly by enumeration over the full `n!` space — a predicate the module did not write cannot be reduced to the pairwise-exclusive pins the lifecycle module counts with. The lifecycle module still prices five; see `docs/modules/permutation.md` §11 and `docs/adr/0005`.
- [ ] `permutation`: RGS-side pacing. `aether-order/docs/ENGINE.md` §5 requires a commit-to-commit cycle floor and a rolling-hour ceiling, and §9 gives them `CYCLE_FLOOR` and `BETTING_CLOSED`. The codes exist so a host raises the right one; the enforcement needs session state neither repository has.

## Deferred

- [ ] Retire the deprecated `./protocol`, `./serialization`, `./reference` aliases **and the progressive-market re-exports from the package root** (`RoundBook`, `makeTranscript`, `deriveTruth`, `initialPosterior`, `quote`, `defineGame`, `adapterFingerprint`, the transcript codec, the adapter conformance view, `progressiveMarket`, the three references) once no consumer depends on them. All of them carry `@deprecated` markers today; see ADR 0004.
- [ ] Decide whether the module contract should become an out-of-tree plugin API (needs a published canonical encoder, a `MODULE_API_VERSION` compatibility policy, and a third-party-code trust decision).
- [ ] Revive the BLACK SIGNAL compatibility corpus in the title repository or a dedicated artifact repository; see ADR 0001.
- [ ] Hosted Actions execution (externally blocked by the account billing/spending limit; no runner steps execute).

## Non-negotiable boundaries

- `BLACK SIGNAL` is a reference integration only. Its art, UI, narrative, and source content do not belong here.
- Engine math never receives tone, compliance copy, or player-facing presentation decisions.
- No certification, fairness, or production-capacity claim is authorised.
