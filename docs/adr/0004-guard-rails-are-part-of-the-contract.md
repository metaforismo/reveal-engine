# ADR 0004 — A contract's guard rails are part of the contract

- **Status:** accepted
- **Date:** 2026-07-29
- **Context branch:** `platform/core`
- **Relates to:** 0002 (the cap chain), 0003 (derive, don't read)

## Context

A second independent review of `platform/core` found no fault in the arithmetic
or in the restructure, and three faults in what surrounds them. All three share a
shape: a guarantee the contract states in prose, with nothing in the code or the
documentation that makes it true.

1. **`CommandLedger.applyCredit()` appeared in zero documentation.**
   `docs/lifecycle-modules.md` §5 listed what read as the complete set of ledger
   calls a book must make and stopped at `creditWithinCap()`. But
   `creditWithinCap` is a pure query — it computes `ceiling - liquidBalance` and
   moves nothing — so a book written by following that list credits its full
   ceiling once per claim, with `capped: false` on every receipt. Demonstrated: a
   ledger with a 100 stake and a 10x multiple pays 5,000 against a 1,000 ceiling
   across five claims. The shapes the contract is being judged against are
   exactly the ones that bite: staged-survival banks subsets repeatedly,
   sequential-cards sells positions independently.

2. **`assertClaimBudget` failed open.** It validated `openClaims` strictly and
   did not validate `maxOpenClaims` at all, so `assertClaimBudget(5, undefined)`,
   `(5, NaN)` and `(5, Infinity)` all passed: `openClaims >= maxOpenClaims` is
   `false` for every non-number. Its docstring asserted that the budget "is
   itself bounded by `ENGINE_LIMITS.maxRoundClaims` at module definition time",
   which was false at every call site in the repository — both fixtures pass a
   _definition_ field (`maxOpenBets`, `entities`) that core never sees. This was
   the only core assert in the repository that failed open, and the only
   core-side bound on the multi-position property.

3. **`defineLifecycleModule()` checked a sample of the declarations.** It
   validated `moduleApiVersion` and `steps.beliefSpace` while accepting arbitrary
   strings for `truth.kind`, `book.positions`, `book.settlement`, and a
   conformance check's `scope`; and it checked four hooks while accepting a
   module with no `truth.derive`, no `transcript.fromWire`, and no
   `book.restore`. A `scope` outside its two values matched neither branch of
   `checkModuleConformance`, so the check never ran — while `report.checks` still
   listed its code and `report.ok` was `true`.

Alongside them: `encode()` was documented as the proof-bearing surface and had no
consumer, `maxSteps` had no consumer beyond its own range check, a zero
`seedCount` produced a passing report that ran nothing, and the root barrel
re-exported one lifecycle module's API next to the engine's with no signal.

## Decisions

### 1. The credit is one call, and the two-call form is documented as a pair

`CommandLedger.creditClaim(theoretical, mint)` prices the claim, hands the
payable to the module's receipt factory, and applies the credit once that factory
returns. It cannot be half-performed, and it preserves the mint-before-mutate
ordering that makes a rejection leave the round untouched — the factory builds
the receipt and mutates module state, and the balance moves only after it
returns. `progressive-market`'s sell and settle paths and both `tests/support/`
fixtures go through it.

`creditWithinCap()` and `applyCredit()` stay public and stay documented, as a
query and a mutation that are two halves of one operation. Removing the query
would remove the ability to price a claim without crediting it, which a host
needs for quotes. What changes is that §5 now names both halves, states that both
are mandatory, and carries the 5x demonstration as the reason.

Rejected alternative: making `creditWithinCap` stateful — marking a pending
credit and refusing the next query until it is applied. It would close the hole
in the low-level path too, but it turns a pure query into something a host cannot
call to quote a claim, which is the legitimate use the split form exists for.

`tests/cap-chain-invariant.test.ts` now runs all 7,380 enumerated command
sequences through both paths and requires identical balances, so `creditClaim` is
the same arithmetic rather than a second implementation of it.

### 2. Guards validate their own bounds, and fail closed

`assertClaimBudget` validates `maxOpenClaims` exactly as strictly as
`openClaims`: a safe integer in `1..ENGINE_LIMITS.maxRoundClaims`, or
`CLAIM_REJECTED`. It cannot assume the budget was bounded elsewhere, because a
book is free to pass a per-definition field and core never sees that field. The
docstring now says what is true.

### 3. `defineLifecycleModule()` validates every declaration it can reach

All five declared enums, every mandatory hook, every optional hook that is
present, all three numeric budgets, and every conformance check's `code`,
`description`, `scope`, and `run`. An out-of-range `scope` is a define-time
`INVALID_MODULE`, and `checkModuleConformance` rejects one too, for a module
object that never went through `defineLifecycleModule`. A report can no longer
list a check it did not run.

The report also gained a `ran` map — how many times each declared check actually
executed — and the runner now requires `seedCount >= 1`. `checks` states what was
declared; `ran` states what was proved, and a reader no longer has to trust that
they are the same thing.

### 4. `encode()` is made load-bearing by composition, not by enforcement

Core cannot verify that a module's `encode` matches its commitment body: it seals
whatever bytes `commitmentBody` returns and has no idea where a truth section
begins. Enforcing it generically would mean core dictating body layout, which is
precisely the game-shaped decision the module owns.

So the rule is structural instead. `canonicalTranscriptBytes` spreads
`encodeTruth(truth)` and `encodeEvent(event)`, and those same two functions are
what the module declares as `truth.encode` and `steps.encode`; both fixtures do
the same, and `tests/lifecycle-module-contract.test.ts` rebuilds the sealed body
from the declared encoders alone. The declared encoding _is_ the proof-bearing
one, by construction. This also fixed a live divergence: the staged-survival
fixture's declared `steps.encode` omitted the `failed` list its body binds.

`maxSteps` is enforced at derivation: the wrapper `defineLifecycleModule()`
already puts around `steps.derive` now fails a derivation longer than the
declared budget with `DERIVATION_FAILED`.

### 5. The root barrel says which half is the engine

Every progressive-market symbol re-exported from `src/index.ts` carries
`@deprecated` naming the subpath that owns it, matching the markers the
`./protocol`, `./serialization`, and `./reference` aliases already carry, and the
README quickstart imports from the module subpath. They are deprecated rather
than deleted because hosts written against 0.2 import them from the package root;
`TODO.md` carries the shared retirement item.

## Consequences

- No proof bytes moved. Both frozen transcript fixtures, `receipt-v1`,
  `round-book-v1`, the `commit-v2` known-answer vector, and the stress and
  benchmark correctness digests are unchanged.
- `ModuleConformanceReport` gains a `ran` field. It is additive; the
  progressive-market view (`checkAdapterConformance`) is unchanged.
- `checkModuleConformance(module, definition, 0)` now reports a failure instead
  of a vacuous pass. No caller in the repository passed 0; the CLI passes 16.
- `ENGINE_LIMITS` gains `maxConformanceSeeds` (4,096), which was already the
  runner's hard-coded bound.
- Tamper cases that kept the original `snapshotHash` in
  `tests/frozen-fixtures.test.ts`, `tests/replay-serialization.test.ts`, and the
  ordering fixture's `SNAPSHOT_NOT_REVALIDATED` check now re-seal, so they are
  rejected on their merits. The four that deliberately do not re-seal say so in
  their own name or in a comment on the line above them.
