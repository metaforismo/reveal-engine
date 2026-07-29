# ADR 0003 — A snapshot is a checksum over derived state, not a source of truth

- **Status:** accepted
- **Date:** 2026-07-29
- **Context branch:** `platform/core`
- **Relates to:** 0002, which introduced the multi-position cap chain this rule protects

## Context

An independent review of `platform/core` found a money-path hole in the one
shipped module. `RoundBook.restore()` cross-checked almost every field of the
restored position against the receipt log — the stake against the last open
receipt's debit, the cap basis against the chain basis, the entry count against
the number of opens — but read `position.outcome` and
`position.contingentPayout` straight out of the snapshot. `outcome` was only
range-checked; `contingentPayout` was not checked at all.

Both are exploitable by an attacker who can write reconnect state, and the
snapshot checksum does not help, because anyone who can rewrite a field can
recompute the hash over it. Reproduced against `constellationReference`, each
mutation re-sealed with a freshly computed `snapshotHash`:

1. open on a losing outcome, rewrite `position.outcome` to the truth → the
   restored book settles for 3,233 where the honest book settles for 0;
2. multiply `position.contingentPayout.numerator` by 1,000 → settlement credits
   the full 250,000 cap ceiling instead of 1,940.

The rule that would have caught both was already published in this repository:
`docs/lifecycle-modules.md` says anything a snapshot asserts about what the
player did must be re-derived from the receipt log. Both test-only fixture
modules implemented it. The reference module — the only one a host will actually
run — did not, and `tests/security/snapshot-mutation.test.ts` enumerated 27
re-sealed field mutations while omitting exactly the two fields that were not
cross-checked, so the suite read as complete.

Two smaller versions of the same failure showed up alongside it. The contract
claimed `assertLoggedChoices` was applied everywhere so "a module author cannot
forget it", but `defineLifecycleModule()` wrapped only `steps.derive`,
`transcript.build`, and `transcript.commitmentBody` — never `verify()`, which is
the one entry point that reads a choice log off the wire. And
`CommandLedger.install()` keyed its receipt map by idempotency key without
rejecting duplicates, so a log declaring three commands could install one.

## Decisions

### 1. Every money-bearing snapshot field is derived, not read

`restore()` recomputes the last open receipt's
`commandFingerprint('open', [openedAtFrameRevision, outcome, stake])` and
compares it to the stored digest, which pins the outcome; and recomputes the
contingent payout as `stake x quote()` at the posterior replayed to
`openedAtFrameRevision`, which pins the claim. Both inputs were already
available: `restore()` replays the whole evidence chain before it looks at the
position.

The generalised rule, now normative in `docs/lifecycle-modules.md`: if a field is
derivable from the receipt log and the replayed steps, derive it. The checksum
detects corruption, not tampering.

### 2. The rule is enforced by conformance, not only by a test

`PROGRESSIVE_MARKET_CHECKS` gains `SNAPSHOT_NOT_REVALIDATED`, so the CI
conformance step exercises restore-tampering for the registered module on every
push — 7 tampers × 16 seeds × 3 reference definitions. Its tamper set includes
both money-bearing position fields, so a module author copying the reference
inherits the coverage rather than the omission.

Conformance checks are synchronous and a book's command API is not, so the check
re-derives its staked mid-round snapshot from the module's own primitives
(`stakedSnapshotFor()`). A contract test pins that re-derivation field for field
against a real staked round, so it cannot drift into a snapshot `restore()`
rejects for an uninteresting reason. Verified as a negative control: disabling
the position re-derivation turns all three references red.

Rejected alternative: making `ModuleConformanceCheck.run` async. It would let a
check drive the real book, but it changes the shape of the runner, the CLI, and
every module's check list for one call site, and the re-derived snapshot is
pinned by a test anyway.

### 3. The choice guard reaches the verify path through a declared accessor

`TranscriptModel` gains `choicesOf(transcript)`, mandatory whenever
`choiceTiming` is not `none`. `defineLifecycleModule()` wraps `verify` to decode
the input, apply `assertLoggedChoices` to the accessor's result, and delegate. A
transcript that does not decode at all is passed through untouched, so the
module still reports decode failures with its own message and path.

Rejected alternatives: inferring the log from a conventional `choices` property
(naming-dependent magic on a security boundary), and deleting the "cannot forget
it" claim from the docs (accurate, but it trades a safety property for a
sentence).

### 4. `belief()` is optional exactly where it is not the price

`weightVector` admits 2..64 entries. A `marginal` module whose per-item space is
larger — a multi-deck shoe, a large field — had no way to satisfy a mandatory
`belief()` and no opt-out. It is now optional for `marginal` modules, where
`price()` carries the money, and enforced for `outcomes` modules, where the
vector _is_ the money.

## Consequences

- `RoundBook.restore()` is strictly stricter. No honest snapshot changes: the
  frozen `round-book-v1` fixture still restores, and the stress and benchmark
  correctness digests are byte-identical.
- `CommandLedger.install()` rejects a duplicate idempotency key before the
  module's visitor sees it, and asserts it installed one receipt per entry.
- `stableJson` sorts by UTF-16 code unit instead of `localeCompare`, because it
  anchors `snapshotHash` and two nodes with different ICU data must agree.
- `core/combinatorics.ts` bounds an exact count by `maxBigIntBits` in its own
  `INVALID_WEIGHTS` taxonomy, so `maxPermutationSize` and `maxBigIntBits` no
  longer disagree silently in the primitive the docs name as the pricing path.
- Adding `choicesOf` is a breaking change for any out-of-tree choice-timed
  module. There are none: the contract is an in-repository extension point.
