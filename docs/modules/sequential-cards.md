# `sequential-cards`

A lifecycle module for games whose truth is a **committed deal from a declared
finite deck**, whose steps turn cards face up, and whose round can hold several
independently priced positions at once.

It exists because of one thing the progressive market cannot express. Turning a
card over does not shade a belief — it can make an outcome **impossible**, and
an impossible outcome has to price at exactly `0`, not at an epsilon. Core
already reserved that affordance: `WeightVector` documents that "zero is a legal
weight: a step that eliminates an outcome sets its weight to exactly zero, never
to an epsilon." This is the module that uses it.

- Module id: `sequential-cards`, version `1.0.0`
- Transcript schema: `reveal-engine/cards-transcript-v1`
- Book snapshot schema: `reveal-engine/cards-book-v1`
- Reference definitions: `triad-middle-v1`, `triad-stochastic-v1`, `duo-middle-v1`,
  `cascade-middle-v1`

| Contract slot        | Value                                                                        |
| -------------------- | ---------------------------------------------------------------------------- |
| `truth.kind`         | `vector` — dealt ranks, plus the reveal selectors sealed with them           |
| `steps.choiceTiming` | `before-step` — the backing is an input to reveal derivation                 |
| `steps.beliefSpace`  | `marginal` — `price()` carries the money; the vector is the elimination view |
| `steps.maxSteps`     | `8`                                                                          |
| `book.positions`     | `multi`                                                                      |
| `book.settlement`    | `paytable`                                                                   |
| `book.actions`       | `open`, `reveal`, `switch`, `split`, `cash`, `settle`                        |

---

## 1. The deck, and why the objective is a total function

A definition declares a **ladder** of `size` ranks with one card each, deals
`dealt` of them without replacement, and scores the hand by one order
statistic: `middle`, `highest`, or `lowest`.

Cards drawn without replacement from distinct ranks are pairwise distinct, so
the hand admits a strict total order and the named order statistic exists and is
unique. **There is therefore no tie rule anywhere in this module, because there
can be no ties.** That is a construction guarantee rather than a convention:
`assertCardsDefinition` refuses a `middle` objective on an even hand, so a
missing middle is a definition-time failure and never a runtime branch.

A rank is **reachable** as the objective only when the hand can be completed
around it. With order-statistic index `j`,

```
reachable(r)  ⟺  r - 1 ≥ j   and   size - r ≥ dealt - 1 - j
```

For the three-card middle game that is ranks `2 … 12`: nothing sits below a 1 and
nothing above a 13, so neither can ever be the middle. A side market on an
unreachable rank is refused rather than offered at a price that can never pay.

## 2. The truth: a committed shuffle and a sealed selector

`truth.derive(seed, definition, roundId)` produces

```ts
interface Deal {
  ranks: readonly number[]; // uniformPermutation of the ladder, first `dealt`
  selectors: readonly number[]; // one per reveal, from a RandomTape
}
```

Both halves are pure functions of `(seed, definition, roundId)` and of nothing
else. In particular **no player decision is an input**, and that is what lets the
selector be covered by a commitment published before the player has backed
anything: `selectors[i]` is an index into the eligible set at reveal `i` **in
ascending board order**, and that set's _size_ is a declared constant,

```
|eligible(i)| = dealt - i - maxOpenBeforeReveal      (eligibility: 'unbacked')
|eligible(i)| = dealt - i                            (eligibility: 'any')
```

even though its _membership_ is not known until the backing is logged.
`defineCardsGame` refuses any definition where that size drops below 1 at any
reveal, so an over-wide backing is a definition-time failure rather than an
out-of-range index at settlement.

The two sampler labels are disjoint (`cards:deal`, `cards:selector`), so the
shuffle and the selectors never share a draw.

**What this buys.** An operator who chooses the reveal with knowledge of the
hidden cards is not merely detectable after the fact — the choice was made
before there was a pick to adapt it to. **What it does not buy**: it says nothing
about seed _grinding_ before publication. `composeRoundSeed()` is the module's
answer to that, and its limits are stated in §9.

## 3. Reveals

```ts
interface RevealStep {
  index: number;
  position: number; // the board position that turned face up
  rank: number; // its face value
  sorted: readonly number[]; // hidden positions in ascending rank order, or []
  label: string; // modelVersion + index — never a function of the deal
}
```

Reveal `i` takes `eligible[selectors[i]]`. No sampling happens at this point:
every draw was sealed with the deal, so a reveal is a deterministic replay of
committed randomness against a public decision log. The label is a function of
the definition and the index only, so the schedule's _shape_ is identical
whichever deal was drawn; only the targets differ, which is what a reveal is
allowed to disclose.

Under `eligibility: 'unbacked'` the choice log must be exactly
`maxOpenBeforeReveal` entries wide before the first reveal. A narrower log is not
the round the selector was sealed against, so it is refused
(`CHOICE_REQUIRED`) rather than derived against a set of a different size.

## 4. The posterior, counted exactly

After a step prefix, write `R` for the revealed ranks, `H` for the hidden board
positions in the order the board published, `m = |H|`, and `P` for the ranks
still in the deck (`|P| = size - |R|`).

A **completion** assigns `m` distinct ranks from `P` to the hidden positions.
Every completion consistent with the public record is equally likely, because the
reveal rule does not look at ranks. So the posterior is a **count**:

```
positionWeights[i] = number of consistent completions whose objective card sits at i
rankWeights[r]     = number of consistent completions whose objective card has value r
total              = number of consistent completions          (a shared denominator)
```

`price(definition, steps, claim)` is `countingProbability(favourable, total)` —
exact BigInt over exact BigInt, never a float, never normalised through a
division that could round.

**The record is validated before it is counted.** `cardsBelief` runs the
structural rules of §6.2 on the step list itself, so every money-carrying entry
point the module declares — `steps.price`, `steps.belief`, and every book command
— reaches the counting through one check rather than through a convention each
caller has to remember. The failure this closes is silent rather than loud: under
`sortRemaining: true` a step list whose last `sorted` is empty is not rejected by
the counting, it is _reinterpreted_ — `revealRecordOf` takes the exchangeable
branch of §4.2, discards the published order and the cumulative bounds with it,
and returns a perfectly well-formed posterior belonging to a different game. On
`cascade-middle-v1` the honest posterior over the hidden positions is
`(0, 0, 35)/35` and the reinterpreted one is `(70, 70, 70)/210`, so `price()`
would put `1/3` on two outcomes the reveals eliminated to exactly zero and `1/3`
on the certain winner. Putting a finite price on an impossible outcome is the
defect this module exists to prevent, so the check is inside the counting and not
beside it.

### 4.1 What "consistent" means, and the trap in it

When `sortRemaining` is on, a completion has to respect **every order relation
the board has published, not merely the most recent sort.**

The most recent `sorted` fixes the order of the cards that are still down. But an
_earlier_ sort ordered a set that included cards which have since turned face up,
and each of those, once its value is known, **splits** that order: everything
that sat before it is now known to be lower, everything after it higher.
`revealRecordOf` accumulates those splits into per-position bounds and
`cardsBelief` filters completions against them.

This is not a refinement. A posterior that reads only the latest sort is
**wrong** for any definition with more than one reveal — and wrong in a way that
hides: every state still looks internally consistent and every action inside a
state is still value-neutral, so nothing local notices. What notices is the
aggregate: the return of a legal policy stops equalling the declared entry RTP.
That is exactly how it was caught here, by the definition-time walk in §7, and
`cascade-middle-v1` and the frequency test in
`tests/sequential-cards/property-metamorphic.test.ts` are what keep it caught.

### 4.2 Unsorted boards

With `sortRemaining: false` the hidden cards stay exchangeable, so a completion
is an ordered tuple rather than a set. Each subset then contributes `m!` in
total: `m!` to a revealed position when the objective is already face up, and
`(m-1)!` to each hidden position otherwise. Both branches leave the total at
`W · (consistent subsets)`, which is what keeps the position view and the rank
view commensurable over one denominator.

### 4.3 The three-card middle game, in closed form

For the reference adapter the count has a closed form, and it is the one
`tests/sequential-cards/oracle-three-card.test.ts` checks the module against.
With a cut of value `v`, `b = v - 1` ranks below it and `t = 13 - v` above:

| Configuration                 | Objective card         | Completions |
| ----------------------------- | ---------------------- | ----------- |
| both hidden ranks above `v`   | the lower hidden card  | `C(t,2)`    |
| the hidden ranks straddle `v` | the cut card itself    | `b·t`       |
| both hidden ranks below `v`   | the higher hidden card | `C(b,2)`    |

and `C(t,2) + b·t + C(b,2) = C(12,2) = 66`, so the three are exhaustive and
disjoint. When `v ∈ {1, 2, 12, 13}` one of `C(t,2)` and `C(b,2)` is zero, and the
socket it belongs to prices at **exactly zero** — 8 of the 26 information states.

## 5. Pricing

| Rule              | Formula                                    | Where it applies                                 |
| ----------------- | ------------------------------------------ | ------------------------------------------------ |
| Entry multiplier  | `r / p`                                    | the one and only margin, on fresh external stake |
| Fair value        | `p · K · (1−σ)`                            | every in-round liquidation                       |
| Switch            | `V / q`                                    | move the whole claim onto one other position     |
| Split (`even`)    | `V / Σ q`                                  | hedge the claim evenly across a set              |
| Cash              | `V`                                        | credit the fair value and close the selection    |
| Credit conversion | `⌊V⌋`, or `⌊V⌋ + 1` with probability `r/d` | the one place a rational becomes an integer      |

with `r = entryRtp` and `σ = liquidationSpread`, **which this version requires to
be exactly zero**. The field is declared, fingerprinted and validated so a
definition that wants a second margin says so explicitly and is refused
explicitly — see §12. **A switch and a split are claim
transformations, not money movements**: the rational claim is recomputed exactly
and never converted to credits, so a selection crosses the credit boundary
exactly once — at its cash-out or at settlement. Both still mint a receipt with
`debited: 0n, credited: 0n`, so the ledger records the decision, the step
revision it was taken at, and its idempotency key.

That is what "self-financed" means here, in its strongest available form: the new
claim is financed entirely by the fair value of the old one, and no rounding, cap
arithmetic, or wallet movement happens in between. With `σ = 0` the transform is
an exact isomorphism, `q · K' = p · K`, so a switch out and back is the identity.

### 5.1 Terminal states offer nothing

When the covered set's probability is exactly `0` or exactly `1`, no action is
offered — not even a cash-out. At `0` every action is worth exactly zero; at `1`
holding and cashing pay the identical certain amount. Rendering controls in
either case is several ways of receiving the same thing, and at `p = 0` it would
put a posted price on an impossible outcome. The round settles at `p · K`.

`CARDS_TERMINAL_OFFERS_NOTHING` sweeps every reachable state and checks both
directions: nothing offered where the position is decided, and something offered
wherever it is not.

### 5.2 One action per decision window

A selection may take at most one in-round action per step revision. Without that
bound a definition with `σ > 0` would have no worst policy at all — each
liquidation multiplies expected value by `(1−σ)`, so an unbounded chain of them
converges to zero and "the argmin over every legal policy" would not exist.

### 5.3 The re-back

Before any reveal the prior over board positions is uniform (asserted, not
assumed — see §7), so moving a claim to another position moves no value:
`p = q`, hence `K' = K`. `rebackMode: 'move'` admits that move and updates the
choice log with it, which is legitimate precisely because it happens before the
first reveal, when the sealed selector still indexes an eligible set of exactly
the size it was sealed against. `rebackMode: 'reject'` refuses it.

### 5.4 The credit boundary, and the two rules that cross it

A claim stays an exact rational for the whole round and becomes a whole number of
credits **exactly once per selection** — at its cash-out or at settlement.
`pricing.rounding` decides how, and it is an economic parameter rather than a
formatting one, which is why it is inside the definition fingerprint.

| Rule         | Credits for a claim of `q + r/d`         | Bias per credit event      | Realised return                                           |
| ------------ | ---------------------------------------- | -------------------------- | --------------------------------------------------------- |
| `floor`      | `q`                                      | `−r/d`, against the player | strictly below `entryRtp` at every finite stake           |
| `stochastic` | `q + 1` with probability `r/d`, else `q` | exactly `0`                | exactly `entryRtp`, at every stake and under every policy |
| `ceiling`    | —                                        | —                          | **declarable, refused**                                   |

`ceiling` is refused on its merits and not for want of effort: it publishes an
RTP the game does not pay — `floor`'s defect with the sign flipped — and a player
staking the smallest legal amount collects the rounding gift every round, so it
needs a minimum stake of its own and inverts the error rather than removing it.

**Where the draw comes from.** `CardsBook` holds no round seed, deliberately
(§6.2), so a stochastic round is opened with a **rounding tape**:
`deriveRoundingSeed(seed, fingerprint, roundId)`, a one-way derivative of the
sealed seed under a label disjoint from `cards:deal` and `cards:selector`. The
draw for one credit event is a uniform integer in `[0, d)` taken from that tape
under the selection id and the receipt's own `ledgerRevision`, so two events in
one round cannot collide even when one settlement receipt credits several rows.
A commitment to the tape is bound into the `open` receipt's fingerprint, and
`settle` re-derives the tape from the revealed seed and refuses a round whose
credits came from another one — validated during the round, authenticated at
settlement, which is exactly the shape of §6.2's boundary and is stated the same
way.

**It is a round secret until settlement.** A uniform draw in `[0, d)` is
necessarily a function of `d`, so a party who knows the tape early can compute
the draw for each claim a decision window offers and take the branch that pays
the extra credit. The edge is bounded by **one credit per credit event** and it
is real at the minimum stake, where one credit can be most of a small payout.
The module cannot see whether a host leaked the tape; the obligation is on the
integration checklist rather than implied to be closed.

**And a tape can be _chosen_ before settlement can object.** The book holds no
seed, so `open()` cannot check that the tape it was handed is the one the sealed
seed produces — only `settle` can, and by then every mid-round `cash` has already
been credited. A tape picked so that every draw pays the extra credit is worth
one credit per credit event and no more, `settle` refuses the round afterwards,
and a host that never settles is never contradicted. That is the same boundary as
the fabricated reveal in §6.2, two orders of magnitude smaller — a chosen reveal
is worth 240 credits on a 100-credit `triad-middle-v1` stake and a chosen tape is
worth one — and it is closed the same way: the host derives the tape with
`deriveRoundingSeed()` against the sealed seed rather than accepting one.

**What the wire format does and does not change.** A `'floor'` definition's
fingerprints, receipts and snapshots are **byte-identical** to the ones this
module wrote before the draw existed: the open fingerprint appends the tape
commitment only when there is one, and the snapshot carries a `roundingSeed` key
only under `'stochastic'`. The key set is a function of the definition, not of
the payload, and `snapshot.definition.fingerprint` pins which definition applies
— so `cards-book-v1` still names one format, read against the definition it
belongs to. `tests/fixtures/cards-book-stochastic-v1.json` freezes the drawn
shape beside `cards-book-v1.json`.

## 6. The book

One round, one ticket, one ledger.

| Action          | Effect                                                                                                      | Credit boundary |
| --------------- | ----------------------------------------------------------------------------------------------------------- | --------------- |
| `open`          | debit the ticket total; price every row at `r / p`; log the backing                                         | debit only      |
| `reveal`        | apply one reveal **the host derived**, fenced and idempotent                                                | none            |
| `switch`        | move a claim onto one other position at true odds                                                           | **none**        |
| `split`         | hedge a claim evenly across a set at true odds                                                              | **none**        |
| `cash`          | credit `floor(V)` for one selection and close it                                                            | credit          |
| `settle`        | verify the proof, then credit every selection on its own outcome                                            | credit          |
| `settleDormant` | verify the proof, then liquidate every live position at the board price and settle every market on the deal | credit          |

A ticket may hold up to `backing.maxOpenBeforeReveal` backed positions plus any
declared side markets. **Every row is `external` stake**, so the round's ceiling
is `maxWinMultiple` times the whole ticket rather than times whichever row came
first — the difference between paying a legitimate 38,800 claim and capping it at
10 because a 1-credit loser was staked first. Every credit goes through
`creditClaim`, which prices, mints, and applies as one call, so a repeated-credit
shape like this one cannot half-perform the cap chain.

A reveal is a ledger command even though it moves no money. Without that, a
reconnect snapshot taken between a reveal and the player's decision would carry a
reveal log nothing had signed: every receipt would still look canonical while the
board said something the round never showed.

**Every command prices what it validated.** `CommandLedger.execute` serialises
commands behind an `await`, so a command's body runs on a later microtask than
the validation that guarded it. Anything a book re-read from the caller's request
after that point would be a value nobody checked and nobody fingerprinted — and
`open` re-reads a stake four times if it re-reads it at all: for the fingerprint,
for the debit total, for the price, and for the stored selection. So every field
is **read once into a local before it is validated**, `#assertTicketShape`
returns rows the book itself built rather than the caller's objects, and
`advanceReveal` copies the step before it fingerprints it. That is not
defensiveness against an exotic input: a host that pools or normalises request
objects would move a value under a pending command by accident, and
`tests/sequential-cards/mutable-request.test.ts` does it with plain data and no
accessors.

### 6.1 The round identity

`open` names the round it belongs to, and `settle` refuses a proof from any
other. That is not belt-and-braces: a reveal discloses one rank and an order
relation, not the hidden cards, so **two different rounds routinely publish the
same reveal**. Without the round identity a book would accept a transcript that
verifies perfectly and settle on somebody else's deal.

### 6.2 A reveal is validated as public record, not as provenance

`CardsBook` holds a definition and no seed. It therefore **cannot check that a
reveal handed to `advanceReveal` came from the sealed deal**, and it does not
pretend to. What `assertRevealSteps` establishes is that the step list is
well-formed _public record_: positions and ranks distinct and in range, the
eligibility rule respected, the published sort a permutation of exactly the
positions still hidden, and every earlier sort still consistent with what has
since turned face up. That is internal consistency. Provenance is a different
property and only `settle` has the input for it — the revealed seed — at which
point the whole step list is re-derived and a mismatch is refused.

The gap between those two moments is real money. A fabricated reveal that clears
the structural rules is accepted, the belief moves to it, and a mid-round `cash`
credits against it: on `triad-middle-v1` with a 100-credit stake, substituting a
different eligible position and a rank of our choosing credits **240** where the
sealed board would have credited nothing. `settle` refuses the round afterwards,
but the credit has already been made, and a host that simply never settles is
never contradicted.

So deriving the reveal is a **host obligation**: call `deriveRevealSteps()`
against the sealed deal and pass what it returns. Do not accept a step from a
client, and do not reconstruct one by hand. The module gives a host everything it
needs to discharge this — `deriveRevealSteps` is deterministic from the seed and
the choice log, and `CARDS_SELECTOR_PRECOMMITTED` and `CARDS_REVEAL_CHOICE_BOUND`
check that it is — but it cannot discharge it for the host, because a book that
held the seed for the whole round would be holding it before the reveal it is
supposed to commit to.

### 6.3 Restore re-derives; it does not read

`CardsBook.restore` takes nothing money-bearing from the snapshot. Every claim is
recomputed from the entry price at the pre-reveal belief and replayed through the
transformation log; every credited integer is recomputed against the cap chain as
it stood at that receipt; the choice log is rebuilt from the ticket and the
transforms; every command's fingerprint is recomputed — over a digest of the
reveals it was fenced to — and compared. Once a round has settled its seed is
public, so the deal, the reveals, the objective card, and the sealed commitment
are re-derived from that seed too. The snapshot's own copies of all of it are
only ever compared against the re-derivation.

**It also replays the round's own rules, not only the receipt algebra.**
`docs/lifecycle-modules.md` is normative that `restore()` runs the receipt log
through `install()` _with the module's own state-machine rules_, and the
distinction is load-bearing: a decision the round would have refused is neither
an inconsistency nor the stake, so nothing in the arithmetic notices it. A
restored ticket therefore clears the same composition rules `open()` applies —
the stake lattice, one selection per backed position, the declared backing width,
`ticket.requiresBackedMarket` — and every restored command clears the same guards
its live counterpart applies. For `switch` and `split`: the cover is well-formed
for the action, in range, unique and in the canonical ascending order a command
would have written; the action was one `offeredActions` offered in the state the
receipt was minted in; no target is a card already face up or an outcome of
probability exactly zero; and no selection acts twice inside one decision window.
For `cash`, which is the one in-round command that carries money **out**: the row
is a backed position and not a side market, the state offered a liquidation, and
the selection has not already acted in that window.

**And the frame is replayed, not read.** A command is minted at the round's live
step revision, so a receipt's frame is exactly the number of reveals the log has
already installed. `CommandLedger.install` cannot know that — it only bounds the
frame by the reveal log's length — so `restore()` asserts it directly. This is
the invariant that stops a snapshot pairing a claim with a belief the round never
held it at, and the pairing is worth more than any single rewritten field: on
`triad-middle-v1` with a 100-credit stake, a legal post-reveal switch fenced to
revision 1 followed by a cash fenced back to revision 0 credits **4,320** where
the honest liquidation of that claim in that state is **196**.

**What that establishes, and what it does not.** It defeats every _inconsistent_
rewrite: a claim that does not match its price, a decision that does not match
its receipt, a reveal that does not match the digest it was fenced to, a credit
that does not match the cap chain, a choice log that does not match the ticket,
and — after settlement — any outcome that does not match the revealed seed. It
defeats every _illegal command_ too: a command the round's own rules would have
refused, at the revision the receipt claims for it, does not restore. That
matters for the money because `analyseDefinition`'s reachable maximum — the
figure `CARDS_CAP_NEVER_BINDS` is checked against — quantifies over the
`(state, cover)` pairs a **round** can reach, so a restore path that admitted a
pair the round cannot reach would be bounded by nothing that was ever proved.

**An earlier version of this section claimed more than that, and was wrong.** It
said restore "defeats every _illegal_ rewrite: a state no legal command sequence
could have produced does not restore, whatever its receipts say", and named the
stake as the one residual. Both halves failed together. The `cash` branch
replayed none of the guards its `switch`/`split` sibling replayed, and nothing
constrained a receipt's frame beyond `frameRevision <= stepRevision`, so the
4,320-credit pairing above restored — with an honest stake, an honest ticket, an
honest open receipt and an honest cap basis, which is exactly the shape the
wallet reconciliation named below as the compensating control **cannot see**. The
guards and the frame rule are now in the code, the forgeries are in
`tests/sequential-cards/restore-rules.test.ts` — each asserting the specific
guard that refuses it, so a case cannot keep passing after the guard it is about
is deleted — and both are in the conformance tamper table with a legal cash-out
alongside them as the positive control. The claim above is narrower than the one
it replaces because that is what the code does.

It does **not authenticate the snapshot**, and the difference matters. Receipt
fingerprints and the checksum are unkeyed and deterministic, so an attacker who
can rewrite the store can rewrite a field _and_ its receipt _and_ the hash
together. What survives that is only what the round can **re-derive or replay**,
so the residual is precisely the inputs it can do neither for. Before settlement
there are two:

- the **stake**, which enters from the wallet and has no cryptographic anchor
  inside the round, so a coordinated rewrite of a stake, its claim, its open
  receipt and the cap basis is internally consistent and will restore;
- a **reveal**, for the reason §6.2 gives in full — a book holds no seed, so a
  fabricated step that clears the record rules is a legal input to every rule
  replayed here, and a snapshot built on one restores exactly as the live round
  accepted it;
- under `'stochastic'`, the **rounding tape**, for the same reason and with the
  same shape. The open receipt's fingerprint binds a commitment to it, so a tape
  swapped on its own dies there — but a store that can rewrite the tape can
  rewrite that receipt too, and the credits re-derive from whatever tape the
  snapshot presents. It is worth one credit per credit event, and only until
  settlement: once the seed is revealed the tape is re-derived from it and a
  substituted one is refused, which is why this residual is pre-settlement and
  the stake's is not.

None of the three is closed by arithmetic: the round has no independent record of
what the wallet debited, and no seed to check a reveal or a tape against until
`settle`.

So snapshot integrity is a **deployment obligation**, not something this module
provides: persist snapshots in storage the host trusts, or authenticate them with
a key the host owns, reconcile the ticket debit against the wallet ledger rather
than against the snapshot, and derive every reveal with `deriveRevealSteps()`
against the sealed truth. `progressive-market` has the same boundary with its
evidence log; it is stated here rather than papered over with a re-derivation
that sounds stronger than it is.

### 6.4 The system settlement, and the clock the module still does not own

A definition may declare a `dormancy` policy. Declaring one does **not** give
this module a clock: nothing wakes up, no timer runs, and no decision expires.
What it adds is one command, `settleDormant`, and a set of refusals around it.

```ts
book.settleDormant({
  idempotencyKey, expectedStepRevision, revealedSeed, transcript,
  elapsedSeconds,          // what the host measured
  reason?: 'account-state-changed',
});
```

The host measures the window and says how long it measured; the module refuses
everything it can check around that assertion:

- a round still standing at step revision 0, because the board was never
  decidable and there is no price a system settlement could be "the one already
  showing";
- `elapsedSeconds` below `dormancy.windowSeconds` with no reason asserted —
  `ROUND_NOT_DORMANT`;
- a `reason` the definition does not declare in `earlySettlementReasons` —
  `INVALID_SETTLEMENT_REASON`;
- a definition with no `dormancy` block at all, whose rounds are never dormant;
- a proof for another round, a seed the reveals do not re-derive from, and a
  rounding tape the round's credits did not come from — the same three the
  ordinary `settle` refuses.

**What it pays.** Every live position is liquidated at `p · claim` against the
belief at the frame the round was standing at — the identical number `cash`
would have credited in that state, swept against it round by round in
`tests/sequential-cards/dormancy.test.ts` — and every live market settles from
the objective rank, because a market carries no position to liquidate. So a
dormant settlement can never pay more than the claim it liquidates, and the
reachable maximum §7 proves the cap against still bounds it without a second
walk.

One case in that argument is worth spelling out, because it is the one place
this command can do something no player command can. `settleDormant` does
**not** apply the one-action-per-decision-window rule: `triad/docs/DESIGN.md`
§10.6 rule 8 requires the account-state path to settle a round that is _live_,
not only one that is _decidable_, and a row that has already switched or split
in the current window is live. So the system can liquidate a row in the same
window the player transformed it in, which `cash` would refuse. That is sound
for one reason and it is the reason `liquidationSpread` is pinned to zero: a
transformation preserves fair value exactly, `q · claim' = p · claim`, so the
amount the system pays is the amount the walk already recorded for the cover the
row held **before** the transformation. Nothing new enters the reachable set.
The test sweeps 40 rounds and asserts the two rationals are equal, not close. `onDormant` may only be an action the definition offers, and that is
proved in **every reachable decision state** by the definition-time walk rather
than read off the action list: a system settlement that could land where its own
action is unavailable would have to invent a price.

**What it records.** The receipt's command fingerprint binds the reason, and the
snapshot carries `settlementReason` — a key present exactly when the definition
declares the policy, on the same rule as the rounding tape. So the two system
paths cannot be relabelled into each other after the fact, and a system
settlement cannot be re-presented as the player's own decision: `restore()`
rebuilds the fingerprint from the reason the snapshot carries and refuses a
mismatch. `tests/fixtures/cards-book-dormant-v1.json` freezes both.

**What it cannot check, stated plainly.** The module cannot verify that
`elapsedSeconds` was measured, that the window started when the board became
decidable, or that an account really changed state. A host that asserts a window
it did not measure settles a live round at a fair price it chose the moment of —
the price is still fair, and the choice of moment is not the module's to police.
That is the same trust boundary as the reveal in §6.2 and the snapshot store in
§6.3, and it is on the integration checklist for the same reason.

## 7. What `defineCardsGame()` proves, and how

`assertCardsDefinition` is the cheap half — shapes, ranges, enums, the stake
lattice. Everything after it is an **economic** assertion no field check could
make, and each is settled by walking the definition's whole reachable space in
exact rationals:

1. **The prior is uniform** over board positions, which is what makes every entry
   price equal and a pre-reveal re-back free.
2. **Every liquidating action realises exactly `p · K · (1−σ)`.** Expected value
   is linear in the claim, so verifying this at `K = 1` in a state establishes it
   for every claim in that state; the walk checks it at every reachable state.
3. **`minStakeCredits` is at least the non-zero-credit threshold**, so no live
   claim can settle at zero credits. It is `ceil(1 / smallest reachable payout)`
   rounded up to the stake step under either rounding rule — the settlement draw
   does not remove the floor, because "you cashed a live position and received
   nothing" is not a rounding footnote even when the expectation is exact.
4. **When `capMustNotBind`, the largest reachable _credit_ is strictly below the
   cap**, so the rail can never truncate a legitimate win or silently reduce the
   published return. Under `'stochastic'` that is
   `maxPayoutMultiple + 1/minStakeCredits` rather than `maxPayoutMultiple`: the
   draw pays up to one whole credit above the claim's whole part, and the
   minimum stake is where that credit is proportionally largest, so the
   comparison is made there and not at a larger stake where it would look
   harmless.

### 7.1 The canonical board

The walk enumerates hands as ascending rank sets and identifies board position
`i` with the `i`-th smallest rank of the hand. That is a **relabelling, not an
approximation**: a real board is a uniform permutation of this one, the sealed
selector picks uniformly from the eligible set in board order, and every quantity
depends on a position only through its rank order, which positions are backed,
and which have been revealed — all of which the walk enumerates. It removes a
factor of `dealt!` and changes no number it produces. The oracle test re-derives
the same figures in real board space from an independently coded model.

### 7.2 Three arguments, each checked rather than assumed

- **Action neutrality is an identity in the claim**, so one evaluation per state
  proves it for every claim in that state (checked; reported as
  `pricingIdentityHolds`).
- **A re-back is a scalar.** On a uniform prior it multiplies the claim by
  exactly `(1−σ)` and leaves the reachable state tree unchanged, so it cannot
  raise the maximum and lowers the minimum by exactly that factor. Applied as a
  scalar rather than by doubling the search.
- **The worst policy liquidates whenever it can**, because each liquidation
  multiplies expected value by `(1−σ) ≤ 1`. With `σ = 0` every policy coincides
  and the distinction is empty, which is what the shipped references declare.

### 7.3 A named shortlist is not a bound

Every extremal figure this module reports is an argmin or an argmax over the
whole admissible set — every hand, every backed set, every reveal outcome, every
reachable `(state, covered set)` pair, and every offered action at each of them.
Where the space is too large to walk, the definition is **refused**
(`ANALYSIS_SPACE_TOO_LARGE`) rather than bounded by a sample.

### 7.4 What the reference adapter comes out at

Every figure below is produced by the walk and independently reproduced by
`tests/sequential-cards/oracle-three-card.test.ts` from the closed form:

| Quantity                           | `triad-middle-v1` / `triad-stochastic-v1`              |
| ---------------------------------- | ------------------------------------------------------ |
| Opening claim on the backed card   | `72/25` = 2.88× stake                                  |
| Largest reachable payout           | `648/5` = 129.6× (a switch in `3:LOW`)                 |
| Smallest reachable positive payout | `12/275` (a cash-out in `3:HIGH`)                      |
| Non-zero-credit threshold          | 23 credits (25 on the step lattice)                    |
| Best legal policy, exact           | `24/25`                                                |
| Worst legal policy, exact          | `24/25`                                                |
| Information states                 | 26 (20 decision, 6 terminal)                           |
| States where a control is a no-op  | 2 — `7:LOW` and `7:HIGH`, where `p = q`                |
| Credited ceiling, `'floor'`        | `648/5` = 129.6× — flooring never pays above the claim |
| Credited ceiling, `'stochastic'`   | `3241/25` = 129.64× at the 25-credit minimum           |
| Max-win cap                        | `200×`, strictly above both                            |

The no-op row is the one figure a reader should know the basis of.
`CARDS_IDENTICAL_ACTIONS_ENUMERATED` reports it as **132 cells** for
`triad-middle-v1`, not 2, and the two numbers are the same fact counted
differently: the oracle names 26 information states, each reached by 66 of the
1,716 walked lines, and `2 × 66 = 132`. The conformance figure is the one that
holds every definition, because it comes from a walk rather than from a
triad-specific naming; the `2` is what a player-facing disclosure would say.
`triad-stochastic-v1` comes out at 132 too — the rounding rule changes what is
credited and not which controls coincide — `duo-middle-v1` at 420 cells, and
`cascade-middle-v1` at 920.

## 8. Conformance

Twenty-three checks, all declared on the module and all run by
`reveal-conformance` against every reference:

| Code                                 | Scope      | Property                                                                                                                                                             |
| ------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CARDS_DEFINITION_NOT_FROZEN`        | definition | the definition and every declarative field are deeply frozen, and `define()` round-trips                                                                             |
| `CARDS_ELIGIBLE_SET_NONEMPTY`        | definition | every reveal has an eligible card and the objective is defined on every deal                                                                                         |
| `CARDS_TERMINAL_OFFERS_NOTHING`      | definition | nothing offered where a position is decided, something wherever it is not                                                                                            |
| `CARDS_ACTIONS_VALUE_NEUTRAL`        | definition | every liquidating action realises the value it was priced from                                                                                                       |
| `CARDS_IDENTICAL_ACTIONS_ENUMERATED` | definition | states where two offered controls share one **return distribution** are enumerated and reported                                                                      |
| `CARDS_POLICY_RETURN_EXTREMAL`       | definition | the argmin and argmax policies over the whole space return what is declared                                                                                          |
| `CARDS_MARKET_REACHABLE`             | definition | every side market can pay, and prices at exactly `entryRtp`                                                                                                          |
| `CARDS_MIN_STAKE_SUFFICIENT`         | definition | the minimum stake clears the threshold, and the threshold is tight                                                                                                   |
| `CARDS_ROUNDING_NEVER_UNDERPAYS`     | definition | the credited integer is the whole part of the claim, or one credit above it                                                                                          |
| `CARDS_ROUNDING_UNBIASED`            | definition | the declared rounding rule's expected credit, counted over the whole draw space                                                                                      |
| `CARDS_ROUNDING_BOUNDED`             | definition | the exact extremal return is `entryRtp` and the conversion moves no payout by a whole credit                                                                         |
| `CARDS_CAP_NEVER_BINDS`              | definition | the reachable **credited** maximum, settlement draw included, is strictly below the cap                                                                              |
| `CARDS_DORMANT_ACTION_OFFERED`       | definition | a declared dormant resolution is offered on every cover a decidable board can hold                                                                                   |
| `CARDS_EVERY_ROUND_SETTLES`          | round      | a declared window is one a round can reach, a system settlement restores under its own sealed reason, and the seed it publishes re-seals its commitment              |
| `CARDS_BELIEF_EXHAUSTIVE`            | round      | belief weights equal a completion count from an independently coded enumeration                                                                                      |
| `CARDS_BELIEF_NORMALISED`            | round      | non-negative, positive total, reduced, summing to one, zero exactly where it is zero                                                                                 |
| `CARDS_SELECTOR_PRECOMMITTED`        | round      | selectors derive from the seed alone and drive the reveal through the eligibility rule                                                                               |
| `CARDS_REVEAL_DETERMINISTIC`         | round      | a transcript re-derives, round-trips its wire form, and rejects a tampered deal                                                                                      |
| `CARDS_REVEAL_CHOICE_BOUND`          | round      | a reveal reads the choice log only through the eligibility rule, over every backing                                                                                  |
| `CARDS_SINGLE_BACKED_POSITION`       | round      | a reveal derives only against a backing log of exactly the declared width                                                                                            |
| `CARDS_TICKET_WELL_FORMED`           | round      | a ticket clears the stake lattice, the backing width and the backed-market rule                                                                                      |
| `CARDS_SEED_MIXES_CLIENT_ENTROPY`    | round      | the round seed changes when only the client seed changes, and requires one                                                                                           |
| `CARDS_SNAPSHOT_NOT_REVALIDATED`     | round      | `restore()` round-trips its own snapshots and a legal cash-out, and rejects re-sealed tampered ones — rewritten values, a re-fenced receipt, and forged liquidations |

`CARDS_BELIEF_EXHAUSTIVE` is worth a note. `deck.ts` counts by enumerating
ascending **subsets** of the remaining pool and filtering them against the bounds
the published sorts imply; the check counts by enumerating ordered
**assignments** and filtering them by rebuilding every published sort from the
assignment itself. The two share no code path, so agreeing on every reachable
state is evidence rather than a tautology.

`CARDS_ROUNDING_UNBIASED` is the one worth reading the implementation of,
because the obvious way to write it is a tautology: computing `E[credits]` from
the same comparison the conversion performs proves only that the check and the
code agree with each other. It instead **counts**. For each probe claim `q + r/d`
it sweeps every `u` in `[0, d)` through `creditsFromDraw` and requires that
exactly `r` of them pay `q + 1` — a conversion using `<=`, or comparing against
`d − r`, or drawing against the wrong denominator, changes that count and fails.
A definition's own reachable payouts cluster (`triad-middle-v1`'s extremes reduce
to denominators 1 and 11), so the sweep also walks a synthetic lattice of every
`(whole, remainder, denominator)` up to 64: 2,096 claims per reference, and
65,350 draws on `triad-stochastic-v1`. Under `'floor'` the same check asserts
the other exact statement — the conversion takes **no draw at all** and loses
exactly `r/d`, which is why that rule needs a minimum stake and the draw does
not. Both directions were
mutation-tested before they were published: `<` to `<=` in the draw comparison
fails only `triad-stochastic-v1`, and a `'floor'` branch that drew and discarded
fails only the three deterministic references.

`CARDS_ROUNDING_BOUNDED` is the pair of premises rather than the conclusion, and
it says so. The consuming specification asks for the extremal **realised credit**
return; the walk computes the extremal **exact** return, and the conversion is
what joins them. So the check asserts the join's two halves — the argmin and the
argmax of the exact return coincide at `entryRtp`, and every reachable payout
converts to within one credit of its claim — from which the realised credit
return follows by linearity under `'stochastic'`, where
`CARDS_ROUNDING_UNBIASED` has counted the conversion unbiased at every credit
event. Under `'floor'` no such identity is available and none is claimed: each
credit event loses strictly less than one credit, which is a bound and is what
the minimum stake exists to make small.

`CARDS_ROUNDING_NEVER_UNDERPAYS` has a tautological half and a real one. That
`settlementTotal` of one claim equals `floor` of it is nearly a restatement of
the code; that `settlementTotal` of **two** winning claims equals the sum of
their own floors is not, and it is the defect ADR 0005 Decision 6 records —
flooring the aggregate lets one selection's fractional part finance another's, so
settling two rows together pays a credit that cashing them one at a time does
not. Of the sixteen probes per reference, 3, 8 and 6 respectively are ones where
`⌊2c⌋ ≠ 2⌊c⌋`, so the check discriminates rather than agreeing by construction.

`CARDS_CAP_NEVER_BINDS` compares the **credited** ceiling, not the claim
ceiling, and the distinction is the defect a reviewer found in it. Under
`'floor'` the two coincide; under `'stochastic'` the draw can pay one whole
credit above the claim's whole part, so they diverge — and an earlier revision
of this check compared `maxPayoutMultiple` while the construction gate it shares
a name with compared `creditCeilingMultiple`. `defineCardsGame` refused
definitions this check passed. A check that is weaker than the gate it certifies
is evidence for a claim nobody made, so it now asks the same question the gate
asks.

The two dormancy checks run against every reference and have a subject on one of
them, `triad-dormant-v1`, which is why that reference exists at all: a check
that only ever runs where it cannot fail is not evidence.
`CARDS_DORMANT_ACTION_OFFERED` walks every canonical state after the first
reveal and every cover the still-hidden cards can form — 5,148 of them for the
three-card shape — and asks `offeredActions` in the state itself rather than
reasoning from the declaration, which makes it independent of the
definition-time walk that asserts the same property over reachable covers.
`CARDS_EVERY_ROUND_SETTLES` restores both system settlements the definition
declares as positive controls and then forges the log four ways: a settlement
before the board was decidable, a reason relabelled from one declared value to
another declared value (which nothing but the sealed fingerprint can refuse), the
reason erased, and a settlement paying the **outcome** instead of the board.

`CARDS_IDENTICAL_ACTIONS_ENUMERATED` exists because
`CARDS_ACTIONS_VALUE_NEUTRAL` is the check a game author will assume covers it
and it does not: with `liquidationSpread = 0` **every** action has the same
expected value by construction, so the value-neutrality check passes in exactly
the state where a control is a relabelled hold. Only the distribution separates
them, and it is compared as one — the amount an action pays and the belief weight
it lands on, against the shared denominator, for every pair of offered controls
in every reachable `(state, cover)` cell. The check fails on two things, and both
are defects in the module rather than judgements about a definition: the
definition-time walk in `analysis.ts` and this one must reach the identical cells
and agree cell for cell, and a coincidence must have the module's stated cause —
two controls coincide **because their covers carry exactly equal probability**,
so a pair matching on the distribution while the covers price differently would
mean the claim transformation and the belief had come apart. What it reports
rather than refuses is set out in §12.

## 9. Seed composition

The lifecycle contract hands a module one 32-byte `seedHex`, so composition
happens **before** the module is called and is a host obligation.
`composeRoundSeed()` exists so the composition is written down once, in the
module that depends on it:

```
seedHex = H( 'cards-round-seed' ‖ commitmentVersion ‖ definitionFingerprint
             ‖ roundId ‖ operatorSeed ‖ clientSeed ‖ nonce )
```

Deterministic seed-derived truth stops an operator choosing the outcome _after_
the seed is committed. It does **not** stop an operator generating many seeds
before publishing one. Mixing entropy the operator does not control into every
round seed is what makes grinding pointless — there is no target to grind toward
— and that argument is only as strong as the deployment's client-seed custody,
which this module cannot see. An operator who controls the client build controls
the client seed. See [`../threat-model.md`](../threat-model.md).

## 10. Errors

`src/api/errors.ts` owns the engine-wide code list and this module **does not
extend it**. Every failure is raised with an existing public code and carries a
machine-readable reason in `RevealEngineError.details.reason`, so a host branches
on `(code, details.reason)` and never on message text.

| `details.reason`            | Code                                                       | Meaning                                                                                                         |
| --------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `INVALID_LADDER`            | `INVALID_ADAPTER`                                          | ladder or objective is unsatisfiable                                                                            |
| `INVALID_REVEAL_SPEC`       | `INVALID_ADAPTER`                                          | reveal count, eligibility, or backing width leaves an empty eligible set                                        |
| `INVALID_SIDE_MARKET`       | `INVALID_ADAPTER`                                          | empty, unsorted, duplicated, out-of-range, or unreachable selection                                             |
| `INVALID_STAKE_LATTICE`     | `INVALID_ADAPTER`                                          | the minimum stake is not a multiple of the step, or either is non-positive                                      |
| `INVALID_ROUNDING_POLICY`   | `INVALID_ADAPTER`                                          | a rounding rule this version does not implement, or an out-of-range RTP/spread                                  |
| `CAP_WOULD_BIND`            | `INVALID_ADAPTER`                                          | `capMustNotBind` is set and a reachable payout reaches the cap                                                  |
| `ANALYSIS_SPACE_TOO_LARGE`  | `INVALID_ADAPTER`                                          | the reachable space, or the estimated work to walk it, is too large to prove the economics by exhaustion        |
| `UNDECLARED_FIELD`          | `INVALID_ADAPTER`                                          | a definition field this version does not implement, refused rather than dropped                                 |
| `INVALID_DORMANCY_POLICY`   | `INVALID_ADAPTER`                                          | a dormancy window outside the module bound, or a resolution it does not implement                               |
| `INVALID_SETTLEMENT_REASON` | `INVALID_ADAPTER` / `CLAIM_REJECTED`                       | an early-settlement reason the module does not know, or one the definition does not declare                     |
| `ROUND_NOT_DORMANT`         | `CLAIM_REJECTED`                                           | `settleDormant` before the declared window, before the first reveal, or on a definition that declares no policy |
| `MISSING_CLIENT_ENTROPY`    | `INVALID_ADAPTER` / `INVALID_SEED`                         | a required client seed is absent or too short                                                                   |
| `STAKE_BELOW_MINIMUM`       | `INVALID_ADAPTER` / `CLAIM_REJECTED`                       | a stake below the minimum or off the step lattice                                                               |
| `BACKED_SELECTION_REQUIRED` | `CLAIM_REJECTED`                                           | a ticket of side markets alone, with no round to derive                                                         |
| `CHOICE_REQUIRED`           | `CLAIM_REJECTED` / `INVALID_CHOICE`                        | the backing log is not the width the selector was sealed against                                                |
| `POSITION_ALREADY_BACKED`   | `CLAIM_REJECTED` / `INVALID_CHOICE`                        | a second selection on one position, or more than the definition admits                                          |
| `POSITION_SETTLED`          | `CLAIM_REJECTED`                                           | an action in a state the reveal already decided                                                                 |
| `UNPRICEABLE_OUTCOME`       | `CLAIM_REJECTED`                                           | an action targeting an outcome of probability exactly zero                                                      |
| `DECISION_ALREADY_TAKEN`    | `CLAIM_REJECTED`                                           | a second action in one decision window                                                                          |
| `ACTION_NOT_OFFERED`        | `CLAIM_REJECTED`                                           | an action the definition does not offer here                                                                    |
| `REBACK_REJECTED`           | `CLAIM_REJECTED`                                           | a pre-reveal switch under `rebackMode: 'reject'`                                                                |
| `ROUND_ALREADY_OPEN`        | `CLAIM_REJECTED`                                           | a second ticket, or a ticket after the first reveal                                                             |
| `ROUND_NOT_OPEN`            | `CLAIM_REJECTED`                                           | a reveal before a ticket, or an empty ticket                                                                    |
| `SELECTION_NOT_LIVE`        | `CLAIM_REJECTED`                                           | an action on a cashed or settled selection                                                                      |
| `UNKNOWN_SELECTION`         | `CLAIM_REJECTED`                                           | no such selection in this round                                                                                 |
| `UNKNOWN_MARKET`            | `UNKNOWN_OUTCOME`                                          | no such side market in this definition                                                                          |
| `DUPLICATE_SELECTION`       | `CLAIM_REJECTED`                                           | a repeated selection id on one ticket                                                                           |
| `CHOICE_CONFLICT`           | `CLAIM_REJECTED` / `INVALID_CHOICE` / `INVALID_TRANSCRIPT` | a decision or reveal that contradicts the log                                                                   |

## 11. Limits

| Limit                         | Value      | Why                                                                              |
| ----------------------------- | ---------- | -------------------------------------------------------------------------------- |
| `CARDS_MAX_STEPS`             | 8          | the module's step budget; a definition declares its own count inside it          |
| `CARDS_MAX_DEALT`             | 16         | bounds the subset enumeration every price rests on                               |
| `CARDS_MAX_SIDE_MARKETS`      | 48         | with the backing width, stays inside `ENGINE_LIMITS.maxRoundClaims`              |
| `CARDS_MAX_SUPPORT`           | 200,000    | completions one belief may enumerate; bounds `C(size, dealt)`                    |
| `CARDS_MAX_ANALYSIS_CELLS`    | 500,000    | reachable `(state, cover)` pairs the definition-time walk may visit              |
| `CARDS_MAX_ANALYSIS_OPS`      | 20,000,000 | estimated exact-rational operations that walk may cost                           |
| `CARDS_MAX_ENUMERATED_TRUTHS` | 20,000     | above this, `truth.enumerate()` returns `undefined` rather than a partial sweep  |
| `CARDS_MAX_DORMANCY_SECONDS`  | 31,536,000 | one year; a window nobody sees elapse is no scheduled settlement, spelled as one |

### 11.1 The two analysis ceilings, and how they are calibrated

`defineCardsGame` is synchronous and proves its economics by exhaustion, so an
oversized definition does not fail — it blocks. Both ceilings above are therefore
closed from the declaration in BigInt, by `estimateAnalysisCells` and
`estimateAnalysisWork`, and **both are checked before the walk starts**. There
are two of them because the walk has two cost centres that scale on different
axes, and neither bounds the other:

- **cells** — the `(state, cover)` pairs of the reveal tree, which grows with
  `C(size, dealt)` and the eligible set at each reveal. A wide deck with a narrow
  hand is expensive here and cheap per cell.
- **operations** — the exact-rational arithmetic inside a cell. `splitSetsOf`
  enumerates every subset of the live positions and `identicalPairs` then
  compares every unordered pair of the controls that produces, so one cell costs
  `O(4^dealt)`. A narrow deck with a wide hand is expensive here and cheap in
  cells. `estimateAnalysisWork` also carries the **belief enumeration**:
  `cardsBelief` runs `C(size − i, dealt − i)` per distinct revealed prefix, and
  at `size 100 / dealt 3` that is 1.6M completions against 1.5M cells — the same
  order as the entire rest of the walk.

**What round two got wrong, and it is worth being explicit about it.** The
operations estimate had no term for `cardsBelief` at all, so it did not bound the
work on the wide-deck axis; and the cell budget was counted from inside the walk
rather than closed from the declaration, so a definition at `size 30 / dealt 5`
was still refused only after 33 seconds of blocked event loop — the exact
condition the operations bound had been introduced to remove. On top of that the
published rate of ~100 ns per estimated operation was measured on the single
loosest shape and presented as if it held everywhere. It does not: the
looseness of the bound is shape-dependent by two orders of magnitude, and
ns-per-operation is its reciprocal, so the true worst rate was ~44× the published
one and the stated "roughly ten seconds" understated the ceiling by the same
factor.

**How the ceilings are calibrated now.** `scripts/analysis-calibration.ts` walks
a committed probe table spanning both axes and reports the estimate, the realised
cell count, the wall time and the rate for each. The ceilings are set from the
**worst** rate in that table, on the shape where the bound is tightest, because
that is the shape that converts a whole ceiling into wall time. Measured on a
2026 laptop under Node 25:

| Shape                           | est. ops    | est. cells | cells   | ms      | ns/op  | outcome |
| ------------------------------- | ----------- | ---------- | ------- | ------- | ------ | ------- |
| `size 13 / dealt 3 / split`     | 46,618      | 2,574      | 2,574   | ~55     | ~1,150 | walked  |
| `size 9 / dealt 5 / width 2`    | 270,396     | 10,080     | 10,080  | ~60     | ~230   | walked  |
| `size 9 / dealt 5 / 2× / split` | 9,148,986   | 124,110    | 13,230  | ~120    | ~13    | walked  |
| `size 52 / dealt 3 / split`     | 3,602,300   | 198,900    | 198,900 | ~5,100  | ~1,430 | walked  |
| **`size 70 / dealt 3 / split`** | 8,922,620   | 492,660    | 492,660 | ~13,200 | ~1,480 | walked  |
| `size 90 / dealt 3 / split`     | 19,149,240  | 1,057,320  | —       | 0       | —      | refused |
| `size 100 / dealt 3`            | 17,625,300  | 1,455,300  | —       | 0       | —      | refused |
| `size 13 / dealt 7 / 2 reveals` | 121,827,420 | 2,606,604  | —       | 0       | —      | refused |
| `size 30 / dealt 5`             | 104,171,886 | 3,562,650  | —       | 0       | —      | refused |

Timings are approximate on purpose: repeated runs on the same machine vary by
about ±10%, so a single sample is not a claim. The **reproducible** columns are
the two estimates and the realised cell count, which are exact functions of the
declaration and the walk. Only the derived ceiling is a claim, and it is derived
from the worst rate observed rather than a mean.

So: **the slowest definition these ceilings admit walks in about 13 s** (12.5 s
to 14 s across runs), and that is the wall-time bound — not the nominal product
of the operations ceiling with the worst rate (~31 s), which is unreachable
because a shape tight enough to run at that rate is a wide deck with a narrow
hand and the cell ceiling refuses it first. Every refusal above arrives in
**under a millisecond**, because no ceiling is discovered from inside the walk
any more. A real 52-card deck with a three-card hand sits comfortably inside
both, at about 5 s.

The cell bound is tight — 1.0× to 9.4× of the realised count, and **exact** on
both single-reveal references. The operations bound is much looser, 18× to 691×
of the realised cell count, because it has to assume every hidden position stays
live and a real reveal eliminates most of them. That looseness is why a shape
like `size 13 / dealt 7` is refused although it would in fact have walked in a
few seconds, and it is the deliberate direction: a bound that refuses a cheap
definition costs an operator one message, and a bound that admits an expensive
one costs a blocked process. The three board shapes the references cover leave
429×, 74× and 2.2× of operations headroom and 194×, 50× and 4.0× of cell
headroom. A declared `dormancy` policy adds one `offeredActions` call per
reachable decision cell and nothing else: measured on the slowest shape both
ceilings admit (`size 70 / dealt 3 / split`, 492,660 cells), 11,222 ms without
the policy and 11,287 ms with it — 0.6%, well inside the headroom above, and the
ceilings are unchanged.

### 11.2 Bounded is not interruptible

Thirteen seconds is a bound on the work; it is not a bound on what else the
process can do meanwhile. `defineCardsGame` is synchronous, so a host that
constructs a definition on a request thread blocks that thread for the whole
walk, and the module used to offer no way out of that.

`defineCardsGameAsync` and `analyseDefinitionAsync` are the way out. The walk is
one generator that yields once per **line** — one `(hand, backed set, backed
position)` context and the reveal tree under it, the granularity at which nothing
crosses the boundary — and the two entry points differ only in what drains it:
the synchronous one runs it to completion, the asynchronous one awaits the event
loop every `yieldEvery` lines (64 by default). There is one implementation
because two would be two chances to prove different economics for the same
definition, and `analysis-bound.test.ts` pins every figure of the two paths
against each other for the same shape.

It is **no faster**, and it is not offered as if it were: the ceilings are
unchanged, the refusals still arrive from the declaration in under a
millisecond on both paths, and a definition that takes thirteen seconds still
takes thirteen seconds. Only the blocking changes. Concurrent callers on one
definition share one walk rather than racing two.

`tests/sequential-cards/analysis-bound.test.ts` holds both estimates to being
upper bounds rather than models: for each of eleven shapes it walks the
definition, sums the completions of every distinct belief through
`forEachCanonicalState`, and requires the estimate to dominate the realised
cells and completions together.

## 12. What this module does not do

Stated plainly, because a module that only lists what it handles is not a
specification.

- **It implements `rounding: 'floor'` and `rounding: 'stochastic'`, not
  `'ceiling'`.** `'ceiling'` stays declarable — so a definition written against
  it fails at `defineCardsGame()` with a reason a host can branch on, rather
  than in somebody else's type-checker — and it is refused on its merits: it
  publishes an RTP the game does not pay and is farmable at the minimum stake.
  §5.4 has the conversion, its committed tape, and the one thing the tape costs:
  it is a round secret, and a party who learns it early can steer at most one
  credit per credit event. Earlier versions of this module implemented `'floor'`
  alone and said the settlement draw was a contract limitation; it was not, and
  [`../adr/0006-the-settlement-draw-and-the-closure-round.md`](../adr/0006-the-settlement-draw-and-the-closure-round.md)
  records what closing it actually took.
- **It charges no liquidation spread.** `liquidationSpread` must be exactly
  zero. That is not a simplification for its own sake: at a zero spread every
  offered action has the identical exact value, so **every** legal policy returns
  `entryRtp` and the extremal claims in §7 need no search to be true. Above zero
  the extremes diverge, and the true argmin is a policy over _information
  states_, which the canonical per-hand walk cannot express — it would report an
  arbitrary policy's return as the minimum. Refusing the definition is the honest
  option; implementing the search is a larger piece of work than this module.
- **It owns no clock — and that was never a reason to refuse the window.**
  Nothing here wakes up, no timer runs, and no decision expires. But a
  `dormancy` policy does not ask for a timer: the consuming specification is
  explicit (`triad/docs/ENGINE.md` §9) that `settleDormant` is a command the
  **host** calls and that the module's part is to refuse it early. An earlier
  version of this module read "we own no clock" as "we cannot implement this"
  and refused the field by name, which meant the consuming game's own worked
  definition did not construct. It does now: §6.4 has the command, the window is
  an assertion the host makes and the module holds it to, and
  [`../adr/0007-the-dormant-settlement.md`](../adr/0007-the-dormant-settlement.md)
  records why the refusal was wrong. What the module still cannot do is check
  that the seconds were measured, and it says so rather than implying otherwise.
  The policy is **optional**: a definition that declares none has no dormant
  path, and its snapshots are byte-identical to the ones this module wrote
  before the field existed. A field this version does not implement is still
  refused by name at `defineCardsGame()` with `UNDECLARED_FIELD`, because
  silently dropping one would be worse than the thing `rounding: 'stochastic'`
  is declarable to avoid: `freezeCardsDefinition` rebuilds a definition field by
  field and `cardsFingerprint` seals it field by field, so an unrecognised key
  would neither be honoured nor sealed — the definition would run under a policy
  it had never agreed to, and two definitions differing only in that policy
  would share a fingerprint.
- **It reports no-op controls; it does not refuse them.**
  `CARDS_IDENTICAL_ACTIONS_ENUMERATED` counts the states where a control is a
  relabelled hold and publishes the number, and
  `identicalActionDecoyControls` counts the controls that are a no-op in
  **every** post-reveal state that offers them. `triad/docs/ENGINE.md` §5.6 asks
  for a definition that offers such a control undeclared to _fail_, and this
  version does not do that, for two reasons worth stating rather than eliding: a
  definition has no field to declare it in, and `switch` before the first reveal
  is a **re-back** — it changes which card is backed and therefore which card the
  reveal may take — so a control that is a relabelled hold after every reveal can
  still be a real control before the first one. All five shipped references
  report zero decoys. Disclosing a no-op state to a player is a game obligation
  that the conformance report can only equip, never discharge.
- **It does not authenticate a reveal, only validate it.** `CardsBook` holds no
  seed, so `advanceReveal` cannot establish that a step came from the sealed
  deal; `assertRevealSteps` checks structure, eligibility and cumulative-sort
  consistency, and a fabricated step that clears those is applied. The belief
  then moves to it and a mid-round `cash` credits against it — 240 credits on a
  100-credit `triad-middle-v1` stake, in the worked case in §6.2. `settle`
  refuses the round afterwards, but the credit has already been made, and a host
  that never settles is never contradicted. **Deriving the reveal with
  `deriveRevealSteps()` is a host obligation**, and it is on the integration
  checklist for that reason. This is the same shape of boundary as the snapshot
  one in §6.3 and is stated with the same plainness: the module cannot close it,
  so it says which side owns it.
- **It holds no player identity, wallet, or persistence.** `CardsBook` is an
  in-memory reference for the state machine and the reconnect format. A
  production RGS still owns idempotency lookup, authorisation, the wallet
  transaction, receipt append, and snapshot persistence inside one database
  transaction.
- **It cannot enforce what it cannot see.** Whether the client seed is really
  generated on the player's device, whether unplayed commitments are really
  published, and whether operator seeds are really per-round and really unreused
  are integration properties. The module can check that a transcript is
  consistent with them; it cannot check that the operator did them.
- **It makes no certification claim.** Conformance checks are mechanical evidence
  that a definition satisfies stated properties. They are not a fairness
  certificate, an RNG certificate, or a regulatory approval, and they say nothing
  about seed custody or about a build that has not been checked against them. See
  [`../certification-boundary.md`](../certification-boundary.md).

### 12.1 What `triad/docs/ENGINE.md` declares, and where this version put it

The consuming game has a build-ready specification of the adapter surface it
expects. This module is compatible with it, and it is not identical to it. Every
difference is listed here rather than left for an integrator to discover at the
type-checker, because a specification a consumer wrote and an implementation that
quietly diverges from it is worse than either alone.

| `ENGINE.md` declares                                                                | This version                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4.1 imports `from '@axiom-games/reveal-engine/sequential-cards'`                   | The package publishes `./modules/sequential-cards`, and there is no `./sequential-cards` alias, so the spec's code block does not resolve as written. The module lives under `./modules/` with every other lifecycle module and gains a second name for one export only by breaking that convention.                                                                                                                                                                                                                                                      |
| §5.5: with `rebackMode: 'move'` a host "may instead call `reback`"                  | There is no `reback` method. A re-back **is** `switchClaim` at step revision 0, where `offeredActions` offers `switch` only for a single-position cover and the prior is uniform, so the move is priced at exactly `(1 − σ)` and crosses no credit boundary. §5.3 describes the same behaviour under the other name.                                                                                                                                                                                                                                      |
| §5.6 scopes `CARDS_BELIEF_EXHAUSTIVE` as a **definition** check                     | Declared and run as a **round** check. It cross-checks the belief against an independently coded enumeration at each step prefix of a seeded round, so it needs a seed and a round id; a definition-scoped check has neither. Its coverage is per reference per seed rather than once per definition.                                                                                                                                                                                                                                                     |
| `dormancy: DormancySpec` on the definition, and §5.1 assertions over it             | **Implemented**, with one widening: the field is **optional** here. Declared, it is validated (window inside the module's one-year bound, `onDormant` an action the definition offers, every early reason one the module knows), sealed into the fingerprint, and enforced by §5.1's own economic assertion — `onDormant` is proved available in every reachable decision state. Omitted, the round has no dormant path and its snapshots are byte-identical to pre-dormancy ones. TRIAD declares it, so the widening is not a break for TRIAD. ADR 0007. |
| `pricing.rounding: 'stochastic'` (the unbiased settlement draw of `MATH.md` §13)    | **Implemented.** §5.4 has the conversion and the committed tape it draws from, `triad-stochastic-v1` ships as a reference so the two rounding checks have a subject that can fail, and ADR 0006 records what closing it took. Two differences remain inside it, both rows of their own below: the tape is derived by the host because the book holds no seed, and the draw is re-derived rather than carried in the transcript body.                                                                                                                      |
| `book.actions` including `settleDormant`                                            | **Present.** The command takes the host's measured `elapsedSeconds` and an optional declared reason, and pays §5.5's `cash` price on live positions plus the deal on live markets (§6.4). The module's list also adds `reveal`, which the spec does not have: ADR 0005 Decision 2 makes a reveal a ledger command.                                                                                                                                                                                                                                        |
| §5.4: the commitment body "does not seal the realised steps"                        | It seals the realised steps **and** the choice log. A reveal is a function of the sealed deal and the log, so sealing it adds no freedom and closes a reveal log nothing had signed.                                                                                                                                                                                                                                                                                                                                                                      |
| §5.4: a verifier needs the client seed and the nonce in the transcript              | The wire transcript carries neither. Composition is a host obligation, published as `composeRoundSeed()` (§9); the transcript binds `roundId` instead, which §6.1 explains is load-bearing and the spec does not require. A host that wants the composition inputs in the artefact must carry them alongside.                                                                                                                                                                                                                                             |
| §8 error codes `SEED_REUSED`, `ROUND_NOT_DORMANT`, `INVALID_SETTLEMENT_REASON`      | `ROUND_NOT_DORMANT` and `INVALID_SETTLEMENT_REASON` are now in `CARDS_REJECTION_REASONS`, under `CLAIM_REJECTED` at the command and `INVALID_ADAPTER` at definition time. `SEED_REUSED` still has no counterpart: it is an operator-custody property the module cannot observe (§9). The module adds `INVALID_DORMANCY_POLICY`, which the spec has no code for.                                                                                                                                                                                           |
| §5.6 checks `CARDS_ROUNDING_UNBIASED`, `CARDS_ROUNDING_BOUNDED`                     | Both implemented and declared, and they run against every reference rather than only the stochastic one: under `'floor'` they assert that rule's own exact statements instead of reporting not-applicable. `CARDS_POLICY_RETURN_EXTREMAL` remains the exact-rational half and is stronger than the spec's wording — an argmin and argmax over the whole policy space, not over a shortlist.                                                                                                                                                               |
| §5.6 check `CARDS_EVERY_ROUND_SETTLES`                                              | **Implemented**, as a round check, and narrower than the spec's wording in one respect worth naming: the spec checks it "against the session log", which this module does not have. It checks what a module can — the declared window is one a round can reach, a system settlement restores under its own sealed reason, and the seed that settlement publishes re-seals the commitment it was opened under. The scheduling remains the host's obligation (§7 of the spec, §6.4 here).                                                                   |
| §5.6 check `CARDS_OBJECTIVE_TOTAL`                                                  | Folded into `CARDS_ELIGIBLE_SET_NONEMPTY`, whose description states both halves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| §5.6 check `CARDS_IDENTICAL_ACTIONS_ENUMERATED` failing an undeclared no-op control | Enumerated and reported; **not** a refusal. §12 above gives the two reasons.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| §5.1 asserts `seed.clientEntropy` is `'required'` with `clientSeedBytes >= 16`      | The module also accepts `'optional'` with zero bytes, and enforces the 16-byte floor only when entropy is `'required'`. It is a **widening**, not a break — TRIAD's own definition declares `'required'` and clears the floor unchanged — but §12.1 claims to list every difference, and a reviewer found this one missing from it. Every shipped reference declares `'required'`.                                                                                                                                                                        |
| §5.5 emits the settlement draw **in the transcript** for every credit event         | The wire transcript carries neither the draws nor the credit events: it is built from `(seed, definition, roundId, choices)` before a round has any. A verifier re-derives every credited integer from the revealed seed and the receipt log instead — which is exactly what `restore()` does, so the property is checked rather than merely available. The location differs; the re-derivability does not.                                                                                                                                               |

Everything else the specification asks for is implemented under the name it
asks for, and that claim has been checked rather than assumed: all fourteen
implementable spec error codes are present in `CARDS_REJECTION_REASONS`, and
every check scope matches except the one tabled above. The three rows at the top
of the table were missing from the first two versions of it, and the last two
rows were missing from the third — the seed-policy widening and the location of
the settlement draw — which is why the claim is stated with what backs it rather
than on its own. **Three** checks this module adds are not in the spec at all —
`CARDS_DEFINITION_NOT_FROZEN`, `CARDS_POLICY_RETURN_EXTREMAL` and
`CARDS_SNAPSHOT_NOT_REVALIDATED` — and the last of those is the one that found
ADR 0005 Decision 2. A fourth, `CARDS_DORMANT_ACTION_OFFERED`, is the mechanical
form of an assertion §5.1 does state, so it is counted there rather than here. Earlier versions of this paragraph counted four, including
`CARDS_MIN_STAKE_SUFFICIENT`, which `ENGINE.md` §5.6 does ask for by name.

**What constructs.** §4.1's worked definition now builds **as written** —
`rounding: 'stochastic'`, `dormancy` and all — and
`tests/sequential-cards/settlement-draw.test.ts` transcribes it field for field
and asserts it fingerprints identically to `triad-dormant-v1`, so this paragraph
is a thing the build runs rather than a thing this document says. Two earlier
revisions of it said less and were right to: one refusal was
`INVALID_ROUNDING_POLICY`, the other `UNDECLARED_FIELD` at `$.dormancy`, and
both were closed by implementing the field rather than by narrowing the
consumer's declaration. What remains different is the import path in the first
row of the table above: the package publishes `./modules/sequential-cards` and
not `./sequential-cards`, so the spec's `import` line still has to be adjusted
by one path segment.
