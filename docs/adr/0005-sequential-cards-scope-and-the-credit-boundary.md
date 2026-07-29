# ADR 0005 — `sequential-cards` fits the contract, and where it stops

- **Status:** accepted
- **Date:** 2026-07-29
- **Context branch:** `platform/sequential-cards`
- **Relates to:** 0002 (the cap chain), 0003 (derive, don't read), 0004 (guard rails)

## Context

`sequential-cards` is the second shipped lifecycle module and the first written
against `docs/lifecycle-modules.md` after that document's audit-and-closure
cycle. The brief for it was explicit: build it against the platform contract
**without modifying core**, and if the contract genuinely cannot express
something, make the smallest possible core extension and write it up.

**No core file was changed.** This ADR records the three places the module
pressed on the contract, what it did instead of extending core, and the one
capability that a consumer's own specification asks for and this version
therefore does not ship.

## Decision 1 — module error codes travel in `details.reason`, not in `ERROR_CODES`

The consuming game's specification (`triad/docs/ENGINE.md` §8) declares sixteen
module-specific error codes: `INVALID_LADDER`, `STAKE_BELOW_MINIMUM`,
`POSITION_SETTLED`, `UNPRICEABLE_OUTCOME`, and so on. `src/api/errors.ts` owns
the engine-wide list and every consumer branches on it, so adding sixteen entries
would widen a shared public surface for one module's vocabulary — and the next
module would want its own.

**Decision:** raise every failure with an existing public code and carry the
module-specific reason in `RevealEngineError.details`, which is already
`Readonly<Record<string, string | number | boolean>>` and already part of the
error's public shape. `CARDS_REJECTION_REASONS` exports the closed set, and
`docs/modules/sequential-cards.md` §10 publishes the full
`reason → code` mapping so a host branches on the pair and never on message text.

**Cost, stated:** a host that branches only on `code` sees `INVALID_ADAPTER` for
nine distinct definition faults. That is why the mapping is published rather than
left to be discovered, and why the reason list is a frozen exported constant
rather than free text.

## Decision 2 — a reveal is a ledger command, though it moves no money

The contract says a book "must build its money behaviour on `CommandLedger`". A
reveal moves no money, so the obvious reading is that it is not a command: apply
it to the module's own state and move on. That is what the first implementation
did, and it left a hole.

A reconnect snapshot taken **between a reveal and the player's decision** carries
a reveal log that nothing has signed. Every receipt still looks canonical — the
open receipt was fenced to step revision 0 and the reveal happened after it — so
a rewritten reveal survives `restore()` under a recomputed checksum, and every
price the restored book quotes is a price for a board the round never showed.
The conformance check found it: one of eleven tamper cases restored cleanly.

**Decision:** `advanceReveal` is a `CommandLedger` command with action `reveal`,
`debited: 0n`, `credited: 0n`, fenced to the step revision and fingerprinted over
`(digest of the reveals published so far, this reveal)`. `restore()` then
requires one reveal receipt per applied reveal, in order, each matching its
recomputed fingerprint.

This follows the precedent the contract already sets for a choice-timed module:
`tests/support/staged-survival-fixture-module.ts` logs its `choose` decisions as
zero-money receipts for the same reason — the log is money-bearing state even
though logging it is not a money movement.

## Decision 3 — the round identity is bound into the ticket

`BookModel.create(definition)` takes no round id, and the book has no other way
to learn one. It would be easy to conclude that comparing the settlement proof's
reveals and choice log against the book's own is enough.

It is not. **A reveal discloses one rank and an order relation, not the hidden
cards**, so two different rounds routinely publish the identical reveal. A
settlement proof from another round with the same public reveal verifies on its
own merits and would settle this round on somebody else's deal — with a different
objective card and a different winner.

**Decision:** `OpenRequest` carries `roundId`. It is bound into the `open`
command fingerprint, stored in the snapshot, re-derived on restore, and compared
against `transcript.roundId` at settlement. No core change: the round identity
arrives with the ticket rather than with the constructor.

## Decision 4 — `rounding: 'stochastic'` is declarable and not implemented

`triad/docs/MATH.md` §13 specifies an unbiased **settlement draw**: a claim of
`q + r/d` credits pays `q + 1` with probability `r/d`, drawn from the sealed
round seed, so the realised return in credits equals the exact return at every
stake. It is a good rule, and it is the one the consuming game declares.

It cannot be implemented inside this contract as it stands, for two independent
reasons:

1. **The book cannot reach a seed.** `BookModel.create(definition)` takes only
   the definition, and a cash-out happens _before_ the seed is revealed, so the
   draw would have to come from a seed the book has no way to hold. A book that
   accepted one out of band would be a book whose `create()` hook returns an
   object that throws at the first credit — which is worse than refusing the
   definition.
2. **The draw is not derivable from the transcript's inputs.**
   `transcript.build(seed, definition, roundId, choices)` is the whole input set,
   and a credit event's draw is addressed by `(selection id, ledger sequence)` —
   money-shaped state that is not a choice and not a step. So the draw could not
   live in the transcript either, and a verifier could not re-derive the credited
   integer.

**Decision:** `CardsRounding` declares all three candidates so a definition
written against `'stochastic'` or `'ceiling'` fails at `defineCardsGame()` with
`INVALID_ROUNDING_POLICY` and a message that says what happened — rather than
failing in a consumer's type-checker, or silently flooring while the definition
claims otherwise. Only `'floor'` is implemented.

**What that costs, exactly:** under `'floor'` the exact-rational return of every
legal policy is still exactly `entryRtp` — `CARDS_POLICY_RETURN_EXTREMAL` proves
it by exhaustion — but the realised return _in credits_ is strictly below it at
every finite stake, by the fractional part the floor discards at each credit
event. `CARDS_MIN_STAKE_SUFFICIENT` bounds the worst consequence (no live claim
can ever settle at zero credits) and the module documents the rest rather than
implying the credited figure equals the published one.

**What it would take to close it**, if a future revision wants to: `BookModel`
would need a round-scoped construction path that can carry a seed, and
`TranscriptModel` would need a way to bind per-credit-event draws — most likely
by promoting credit events to logged choices, since those are already an input to
`build` and already bound into the commitment body. Both are core changes, both
are larger than this module, and neither is made here.

## Decision 5 — the state space is bounded, and an unbounded definition is refused

Every economic assertion `defineCardsGame()` makes is settled by walking the
whole reachable space in exact rationals. That is only possible while the space
is small, and a deck of 52 with a five-card hand is not small.

**Decision:** bound it and say so. `CARDS_MAX_SUPPORT` bounds the completions one
belief may enumerate, `CARDS_MAX_ANALYSIS_CELLS` bounds the definition-time walk,
and a definition that exceeds either is **refused** with
`ANALYSIS_SPACE_TOO_LARGE`. The alternative — bounding the extremes with a
sample and calling the result a bound — is the defect
`docs/math.md` and the threat model both exist to forbid, and it would be worse
than declining the definition.

**Amended in round two: a cell is not a unit of work.** The cell budget bounded
the space and not the time. `splitSetsOf` enumerates every subset of the live
positions, so one cell costs `O(2^dealt)` rational operations, and a legal-shaped
definition at `size 18 / dealt 9` reached the cell budget only after 27 seconds —
one at `size 20 / dealt 11 / 4 reveals` after 281 seconds, on a synchronous
`defineCardsGame`. Operator-authored definitions are not player-reachable, so
this was robustness rather than an exploit, but "bound it and say so" has to mean
the time. `CARDS_MAX_ANALYSIS_OPS` and `estimateAnalysisWork` close an upper
bound in BigInt from the declaration alone, before a single hand is enumerated;
both cases above are now refused in under a millisecond, and
`docs/modules/sequential-cards.md` §11 publishes the calibration.

## Decision 6 — three findings from an independent review, and what each cost

An independent read of the finished module (GPT-5.6 at read-only, prompted for
correctness and security only) produced five findings. Three were real and are
fixed; two are recorded here because the honest response to them was
documentation rather than code.

**Fixed — settlement floored the aggregate, not the selections.** `settle` summed
every winning selection's exact claim and floored once. With
`ticket.stakeScope: 'per-selection'` that is wrong in the money: two winning
markets paying `3432/53` and `572/3` credit `64 + 190 = 254` separately and
`floor(40612/159) = 255` together, so one selection's fractional part financed
another's and the round paid a credit that came from nowhere. Settlement now
floors each selection on its own and sums the integers, which also makes settling
two rows together agree with cashing them one at a time.

**Fixed — a settled snapshot trusted its own outcome.** `restore` recomputed the
settled credit from the snapshot's `objectiveRank` / `objectivePosition`. Those
are attacker-controlled, and the settle receipt's fingerprint over them is
unkeyed, so a coordinated rewrite of the outcome, the fingerprint, the credited
amount and the checksum restored cleanly. But a settled round has already
revealed its seed — so `restore` now re-derives the deal from that seed, the
reveals from the deal and the choice log, the objective from the deal, and
re-seals the commitment. A forged outcome now dies against the seed it claims to
have come from.

**Fixed — the ticket bound came after an unbounded pass.** `assertClaimBudget`
was called inside the pricing loop, so a million-row ticket was fully validated
and allocated from before the sixteenth row was refused. The length is now
checked before a single row is read.

**Not fixed, documented — an unkeyed snapshot cannot be authenticated.** The
review demonstrated that a coordinated rewrite of a stake, its claim, its open
receipt and the cap basis restores. That is true, it is inherent to a
deterministic unkeyed snapshot format, and `progressive-market` has the same
property. Re-derivation defeats _inconsistent_ rewrites and nothing else; the
stake in particular has no anchor inside the round, because it came from a wallet
the module cannot see. `restore`'s docstring and
`docs/modules/sequential-cards.md` §6.2 previously implied more than that and now
say exactly this, and name snapshot integrity as a deployment obligation.

**Fixed by narrowing — the worst-policy figure was not an argmin.** With a
non-zero `liquidationSpread` the analysis's worst-policy walk picked an arbitrary
switch target, and the review found an accepted definition where a legal
information-state policy returned less than the reported "worst". A true argmin
needs a search over information states, which the canonical per-hand walk cannot
express. Rather than publish a number that is not the extreme it claims to be,
`assertCardsDefinition` now requires `liquidationSpread` to be **exactly zero**,
where the value-neutrality identity makes every legal policy's return identical
and the two computed policies are the whole range rather than two samples of it.
The `(1 − σ)` arithmetic is kept general so a future revision that implements a
spread has to confront the argmin search rather than inherit this claim.

## Decision 7 — a declared field this version does not implement is refused, not dropped

`triad/docs/ENGINE.md` §4 declares `dormancy: DormancySpec` as a member of the
definition. `assertCardsDefinition` ignored unknown keys and
`freezeCardsDefinition` rebuilds a definition field by field, so the policy
vanished without a word and never entered `cardsFingerprint`.

That is strictly worse than the thing Decision 4 exists to avoid.
`rounding: 'stochastic'` is declarable **so that it can be refused explicitly**
rather than "failing in a consumer's type-checker, or silently flooring while the
definition claims otherwise" — and dormancy was doing the silent thing. Two
definitions differing only in a dropped field would also share a fingerprint,
which is the one property `cardsFingerprint` exists to deny.

**Decision:** `assertCardsDefinition` rejects **any** key it does not implement,
at every level of the declaration, with `INVALID_ADAPTER` and a new
`UNDECLARED_FIELD` reason. `dormancy` gets a message naming what is missing and
why — the module owns no clock — rather than an anonymous typo report.
`docs/modules/sequential-cards.md` §12.1 is the table of everything the consumer
declares that this version does not implement, and where each one moved.

## Decision 8 — round-two findings, and what each cost

A second independent read produced four major findings and four minor ones. All
eight are fixed; three of them changed how a boundary is written rather than what
it computes.

**Fixed — a command re-read the caller's request across the ledger's `await`.**
`CommandLedger.execute` serialises commands, so `open()`'s pricing loop ran on a
later microtask than the validation that guarded it, and it re-read `row.stake`
for the fingerprint, the debit total, the price and the stored selection. A row
whose accessor was honest for seven reads and inflated on the eighth produced a
claim 40,000,000× the validated stake; plain data mutated synchronously produced
an open receipt whose fingerprint did not cover the amount it debited, leaving a
live round that could never reconnect. `advanceReveal` had the same shape and it
reopened the exact hole Decision 2 introduced the reveal-as-command to close.
Every command now reads each field once into a local before validating it,
`#assertTicketShape` returns rows the book built, and the reveal is copied before
it is fingerprinted.

**Fixed — `restore()` replayed the receipt algebra but not the round's rules.**
`docs/lifecycle-modules.md` is normative that it must do both, and the difference
is not academic: a decision the state machine would have refused is neither an
inconsistency nor the stake, so nothing in the arithmetic notices it. Fully
self-consistent snapshots — receipts recomputed, claims re-priced, checksum
re-sealed — restored a claim onto a face-up card, two decisions inside one
decision window, and an unsorted cover no command could write. The ticket rules
and the decision guards now live in one place each and both boundaries run them.

**Fixed — a raw `TypeError` escaped `restore()`.** `decisions[].positions` was
the one untrusted array `parseCardsSnapshot` did not type, and it reached
`positionProbability`, where an out-of-range index made `0n + undefined`. The
parser now types the elements and `restore` applies the definition's rules to
them, so the failure is the typed `RevealEngineError` the contract exists to
guarantee.

**Fixed — the identical-action enumeration had no reader.**
`analysis.identicalActionCells` was computed and asserted nowhere, and
`CARDS_IDENTICAL_ACTIONS_ENUMERATED` — which `triad/docs/ENGINE.md` §5.6 devotes
a paragraph to — did not exist. The analysis now compares whole return
distributions across every pair of offered controls, and the new check re-derives
the same reachable set from its own code path and refuses a definition whose two
walks disagree cell for cell. Three further spec checks that had no
implementation (`CARDS_REVEAL_CHOICE_BOUND`, `CARDS_SINGLE_BACKED_POSITION`,
`CARDS_TICKET_WELL_FORMED`, `CARDS_ROUNDING_NEVER_UNDERPAYS`) were added at the
same time, which leaves §12.1's table shorter than the finding anticipated.

## Consequences

- Core is unchanged. `git diff platform/core -- src/api src/core src/conformance`
  is empty.
- Two consumer-declared capabilities (`rounding: 'stochastic'` and `dormancy`)
  are refused at definition time with documented reasons rather than
  approximated or dropped, and `docs/modules/sequential-cards.md` §12.1 lists
  every remaining divergence from the consumer's specification.
- Two holes that the contract's prose did not prevent — an unsigned reveal log
  and an unbound round identity — are closed inside the module, and both are
  worth reading back into `docs/lifecycle-modules.md` as guidance for the next
  module rather than as core code.
- `liquidationSpread` is narrowed to zero (Decision 6), so the module's published
  extremal figures are exact rather than approximate. Widening it again is a
  scoped piece of work with a named prerequisite: an argmin over information
  states.
