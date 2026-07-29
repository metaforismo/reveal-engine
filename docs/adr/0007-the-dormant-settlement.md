# 0007 — The dormant settlement, and the clock nobody asked us to own

Status: accepted
Date: 2026-07-29
Supersedes: ADR 0005 Decision 7 (in the one part quoted below), amended by ADR
0006's "dormancy is still refused by name"

## Context

`triad/docs/ENGINE.md` §4.1 publishes a worked definition of the adapter this
module implements. Until this round, that definition did not construct. ADR 0006
closed one of the two reasons — `pricing.rounding: 'stochastic'` — and left the
other standing:

> `dormancy` is still refused by name.

The refusal's stated ground was that "this module owns no clock and settles no
round on a schedule; the host owns the dormancy window and calls `cash()`
itself".

That ground does not survive reading the specification it was refusing. The same
document says, in §9, under **what this module does not do**:

> It does not own the clock. `dormancy.windowSeconds` is a declared parameter and
> `settleDormant` is a command the host calls; the module refuses it early with
> `ROUND_NOT_DORMANT` but has no timer of its own and never wakes up.

The consumer was not asking for a scheduler. It was asking for a **declared
parameter** and a **command that can be refused against it** — both of which are
pure functions of a declaration and an argument, and both of which this module
was already in the business of providing. The refusal answered a requirement
nobody had made.

The compatibility rule for this repository makes the game's `docs/ENGINE.md`
normative by default: extend the module, and record an ADR here. The alternative
route — patching the game's specification and re-running its gates — is only
available when the game document is _wrong or unimplementable at the exactness
bar_. It is neither. `settleDormant` is exactly derivable, exactly priced, and
exactly verifiable from the committed seed. So the module was extended.

## Decision

**1. `dormancy` is implemented, and it is optional.**

`DormancySpec` is `{ windowSeconds, onDormant: 'cash', earlySettlementReasons }`.
A definition that declares it gets a dormant settlement path; a definition that
does not is unchanged in every observable way — same fingerprint, same snapshot
key set, same byte-identical frozen fixtures. That optionality is a **widening**
against the consumer's interface, which declares the field as required, and it is
listed as one in `docs/modules/sequential-cards.md` §12.1 rather than left for an
integrator to notice. It is not a break for TRIAD: TRIAD declares the field.

The alternative — making it required — would have changed the fingerprint of
every shipped reference and rewritten every frozen wire fixture, to express
"this definition has no scheduled settlement" as a policy rather than as its
absence. That is a worse trade: it converts a real evidence trail into churn to
buy a uniformity nothing needs.

**2. The window is an assertion the host makes, and the module holds it to it.**

`settleDormant` takes `elapsedSeconds`. The module cannot verify it, and says so
in §6.4 rather than implying otherwise. What it does verify is everything
around it: the round is past its first reveal (before that the board was never
decidable and there is no price to be "the one already showing"), the seconds
clear `windowSeconds` unless a declared early reason is asserted, the reason is
one the definition declares, the proof is this round's, and the rounding tape is
the one the revealed seed produces.

This is the same shape of boundary as the reveal in §6.2 and the snapshot store
in §6.3 — the module validates what it can re-derive and names the rest as a
host obligation — and it is on `docs/integration-checklist.md` for the same
reason.

**3. The price is the board, never the outcome.**

A live position is liquidated at `p · claim` against the belief at the frame the
round was standing at; a live market settles from the objective rank, because a
market has no position to liquidate. Three consequences, each checked:

- it is **exactly** what `cash` would have credited in that state, including the
  settlement draw, because both take the draw under the same credit event
  (`tests/sequential-cards/dormancy.test.ts` runs both paths from the same seed
  and compares the credited integers);
- `p · claim ≤ claim` everywhere, so a dormant settlement can never pay more
  than the settlement it replaces and the reachable maximum `defineCardsGame`
  proves the cap against still bounds it — no second walk, no second ceiling;
- it stays inside that bound even where the command can do what no player
  command can. `settleDormant` deliberately does not apply the
  one-action-per-window rule, because `triad/docs/DESIGN.md` §10.6 rule 8
  requires the account-state path to settle a round that is _live_ rather than
  one that is _decidable_, and a row that just switched or split is live. The
  amount is still an already-enumerated payout: a transformation preserves fair
  value exactly at the zero spread this module requires, `q · claim' = p ·
claim`, so liquidating after the transformation pays what liquidating before
  it would have, and the walk recorded that at the same revision. The test
  sweeps it over 40 rounds and compares rationals, not credits;
- it is EV-neutral at the zero spread this module requires, which is the whole
  reason `'cash'` is the only implemented resolution. A resolution that guessed
  at the player's intent, or that voided the round, would be the system taking a
  decision on somebody's behalf and pricing it.

**4. `onDormant` must be offered wherever a dormant settlement can land, and
that is proved rather than argued.**

The definition-time walk asks `offeredActions` in every reachable decision cell
at or after the first reveal and counts the misses; `defineCardsGame` refuses a
definition with any. The conformance check `CARDS_DORMANT_ACTION_OFFERED`
re-derives the same property over every cover a decidable board can hold, from
its own enumeration, so the two walks agreeing is evidence rather than one
reading the other's answer. A terminal cover is not a miss: it offers nothing at
all and settles at `p · claim`, which is the same number — there is no price to
invent.

**5. The reason is sealed, not merely recorded.**

The receipt's command fingerprint binds the settlement reason, and the snapshot
carries `settlementReason` under a key present exactly when the definition
declares the policy. `restore()` rebuilds the fingerprint from the reason the
snapshot carries, so an end-of-window settlement cannot be re-presented as an
account-state one, or either as the player's own decision, however consistent the
rest of the log is left. `triad/docs/DESIGN.md` §10.6 rule 3 requires exactly
this and the module can enforce it, so it does.

Recording the reason without sealing it would have passed every test that only
asks whether the field is present. The conformance tamper table was written to
fail without the seal, and it was mutation-tested: removing the reason from the
fingerprint makes `CARDS_EVERY_ROUND_SETTLES` fail on all sixteen seeds.

**6. `CARDS_CAP_NEVER_BINDS` now asks what its construction gate asks.**

Unrelated to dormancy and found in the same review. The check compared
`analysis.maxPayoutMultiple` while `assertCardsEconomics` compared
`analysis.creditCeilingMultiple`. Under `'floor'` they coincide; under
`'stochastic'` they diverge by `1 / minStakeCredits`, so `defineCardsGame`
refused definitions the check named for the property passed. A check that is
weaker than the gate it certifies is evidence for a claim nobody made. One line.

## Consequences

- The consuming game's §4.1 definition constructs as written. That is asserted
  by a test that transcribes it field for field, not by this document.
- `CARDS_ACTIONS` gains `settleDormant`, and the module ships a fifth reference,
  `triad-dormant-v1`, so both new checks have a subject that can fail.
- One new frozen fixture, `tests/fixtures/cards-book-dormant-v1.json`, pins the
  wire format of a system settlement. The four pre-existing fixtures are
  byte-identical.
- The module still cannot see a clock, an account, or a session, and none of the
  documents claim it can. What changed is that the parts it _can_ check are now
  checked instead of refused wholesale.
