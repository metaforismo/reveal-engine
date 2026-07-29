# ADR 0006 — the settlement draw, and what the closure round found

Status: accepted. Supersedes ADR 0005 Decision 4 on `rounding: 'stochastic'`, and
amends ADR 0005 Decision 9 where it overstated what `restore()` established.

A fourth independent read of `sequential-cards` produced one blocker, three
majors and two minors. All six are closed. The blocker was a real value-creation
path; the rest were, once again, **claims that outran what the code did** — which
this repository treats as the same class of defect, because a control nobody can
rely on and a control that does not exist are worth the same amount.

---

## Decision 1 — a restored liquidation replays the round's rules, and the frame is one of them

`CardsBook.restore` replayed the round's own state machine on the
`switch`/`split` branch and **none of it** on `cash`, which is the one in-round
command that carries money out. It also let a receipt claim any frame at or below
the reveal log's length, because `CommandLedger.install` — which is core, and
knows nothing about beliefs — has no stronger rule to apply.

Those two gaps compose into value creation. On `triad-middle-v1` with a
100-credit stake, a snapshot whose receipt log is `open(0) / reveal(0) /
switch(1) / cash(0)` restores with a `liquidBalance` of **4,320**. The switch is
priced at the post-reveal belief and grows the claim to 12,960; the cash is then
priced at the **pre-reveal** belief `p = 1/3`, paying `12960/3`. The honest
liquidation of that claim in that state is `2160/11` = 196 credits, and the fair
value of the position is `12960 × 1/66 ≈ 196`. Every receipt re-derives, every
fingerprint matches, the checksum is correct, and the stake, the ticket, the open
receipt and the cap basis are all **honest** — which is precisely why the wallet
reconciliation §6.3 named as the compensating control for its one admitted
residual cannot see it. The identical command through the live path is refused
with `CLAIM_REJECTED` / `ACTION_NOT_OFFERED`.

**The fix is two rules, not a patch on one symptom.** A receipt's
`frameRevision` must equal the number of reveals the log has already installed —
the revision the round was actually standing at when the command was minted —
and a restored `cash` must clear the guards `cash()` clears: the row is a backed
position and not a side market, the state offered a liquidation, and the
selection has not already acted in that window.

The frame rule is the more important of the two, because the defect it closes is
not "a missing guard" but a **pairing**. Every other tamper in the repository's
table rewrites a _value_ and dies in the receipt algebra. This one rewrites which
belief a command was priced at, and the arithmetic is exact at both revisions. It
is also invisible to the definition-time walk: `window()` in `analysis.ts`
`continue`s at revision 0 before recording any payout, so `CARDS_CAP_NEVER_BINDS`
bounds nothing about it. A restore path that admits `(state, cover)` pairs the
round cannot reach is bounded by nothing that was ever proved, which is the
failure mode §6.3 warned about in its own words while the code allowed it.

**What the evidence had to gain.** The conformance tamper table rewrote eleven
scalars and no pairings, and `restore-rules.test.ts` forged only `switch`/`split`
chains — `grep -n frameRevision tests/sequential-cards/*.ts` returned a single
line, always the value 1. Nothing anywhere forged a `cash` receipt. The table now
carries a re-fenced receipt and two forged liquidations, and — the part that
matters more — a **legal** cash-out as the positive control, built by the same
function, so a `restore()` that refused every liquidation ever written would fail
rather than pass by being uniformly suspicious. Each forgery in the test asserts
the specific guard that refuses it, so a case cannot survive the deletion of the
guard it is about.

## Decision 2 — nothing prices from an unvalidated record

`claimProbability` is the module's declared `steps.price` hook and it ran no
validation of the step list it priced from. Neither did `cardsBeliefVector`, the
declared `steps.belief`.

The failure is silent rather than loud, which is what makes it worth an entry.
Under `sortRemaining: true`, a step list whose last `sorted` is empty is not
rejected by the counting — it is **reinterpreted**. `revealRecordOf` takes the
exchangeable branch, discards the published order _and_ the cumulative bounds it
had already computed, and returns a perfectly well-formed posterior belonging to
a different game. On `cascade-middle-v1` the honest posterior over the hidden
positions is `(0, 0, 35)/35` and the reinterpreted one is `(70, 70, 70)/210`, so
`price()` returns `1/3` for two outcomes the reveals eliminated to exactly zero.
Putting a finite price on an impossible outcome is the defect this module exists
to prevent.

`CardsBook` always validated first, so the book was never exposed. That is not a
defence: the lifecycle contract invites a host to call `steps.price` directly,
and §6.2 names `assertRevealSteps` as the control that establishes
well-formedness while the money-carrying entry point did not apply it.

The record rules move to `record.ts` — a leaf module, so `deck.ts` can depend on
it without the cycle `validation.ts` would have created — and `cardsBelief` runs
them. That puts the check **inside the counting** rather than beside it, so every
entry point reaches it through one call instead of through a convention each one
has to remember. The choice-free half is what the posterior needs; the backing
log is only read for the eligibility rule, which is not a property of the
posterior.

## Decision 3 — `rounding: 'stochastic'` is implemented, and ADR 0005 Decision 4 was wrong about why it was not

ADR 0005 recorded the settlement draw as a **contract limitation**: a book holds
no seed, a draw needs committed randomness, therefore the draw could not live
here. The first two clauses are true and the conclusion does not follow.

What a book cannot hold is the **round seed**, because holding it would mean
holding the deal before the reveal it is supposed to commit to. A one-way
derivative of that seed is a different object. `deriveRoundingSeed(seed,
fingerprint, roundId)` is `H('cards-rounding-seed' ‖ version ‖ fingerprint ‖
roundId ‖ seed)` under a label disjoint from `cards:deal` and `cards:selector`:
it reveals nothing about the deal — inverting it is inverting SHA-256 — and it
re-derives at settlement from the revealed seed, so `settle` refuses a round
whose credits came from another tape. The book draws from it and never sees the
seed.

That closes the divergence `triad/docs/ENGINE.md` §4.1 and `triad/docs/MATH.md`
§13.3 care most about. Under `'floor'` the realised return in credits is strictly
below `entryRtp` at every finite stake and the bias is `−r/d` per credit event;
under the draw it is exactly `entryRtp` at every stake and under every policy,
because `E[credits] = q·(d−r)/d + (q+1)·r/d = q + r/d` is the claim itself.

**Four consequences worth recording, because none was free.**

1. **The cap is measured against credits, not claims.** The draw pays up to one
   whole credit above the claim's whole part, so `capMustNotBind` compares
   `maxPayoutMultiple + 1/minStakeCredits` — at the minimum stake, where that
   credit is proportionally largest. `triad-stochastic-v1` comes out at
   `3241/25` = 129.64× against a 200× rail. `triad/docs/ENGINE.md` §5.1 asks for
   exactly this and names the same reason.
2. **The tape is a round secret.** A uniform draw in `[0, d)` is necessarily a
   function of `d`, so a party who knows the tape early can compute the draw for
   each claim a decision window offers and take the branch that pays the extra
   credit. The edge is bounded by one credit per credit event and it is largest
   at the minimum stake. This is disclosed in §5.4 and on the integration
   checklist rather than argued away; it is the same class of obligation as
   seed custody, and the module cannot see whether a host discharged it.
3. **The deterministic wire format did not move.** The open fingerprint appends
   the tape commitment only when there is one, and the snapshot carries a
   `roundingSeed` key only under `'stochastic'` — so the key set is a function of
   the definition, which `snapshot.definition.fingerprint` pins. Every committed
   `'floor'` fixture is byte-identical after the change, which is the check that
   this was true rather than the intention that it be.
4. **A rule with no subject is not checked.** `CARDS_ROUNDING_UNBIASED` and
   `CARDS_ROUNDING_BOUNDED` would have been vacuous against three deterministic
   references, so `triad-stochastic-v1` ships as a fourth. Both checks count over
   the whole draw space rather than recomputing the conversion's own comparison,
   and both were mutation-tested before publication: `<` to `<=` fails only the
   stochastic reference, and a `'floor'` branch that drew and discarded fails
   only the three deterministic ones.

`'ceiling'` stays declarable and refused. It is not a gap: it publishes an RTP
the game does not pay — `floor`'s defect with the sign flipped — and it is
farmable at the minimum stake, so it would need a stake floor of its own and
inverts the error rather than removing it.

## Decision 4 — bounded is not interruptible

`defineCardsGame` is synchronous and proves its economics by exhaustion, so the
slowest shape the §11 ceilings admit blocks its thread for about thirteen
seconds. Definitions are operator-authored and not player-reachable, so this was
a robustness note rather than an exploit — but the module offered no way to
yield, and "bounded" and "interruptible" are different properties.

The walk is now one generator that yields once per line, and
`defineCardsGameAsync` / `analyseDefinitionAsync` drain it with the event loop in
between. There is **one** implementation, because two would be two chances to
prove different economics for the same definition, and the test pins every
published figure of the two paths against each other. It is no faster and is not
presented as if it were: the ceilings are unchanged, the refusals still arrive
from the declaration in under a millisecond on both paths, and thirteen seconds
of work is still thirteen seconds of work. Only the blocking changes.

## Decision 5 — two divergences the compatibility table did not list

§12.1 claims to list **every** difference from the consumer's specification, and
a fourth reader found two it did not:

- `ENGINE.md` §5.1 asserts `seed.clientEntropy` is `'required'` with
  `clientSeedBytes >= 16`; the module also accepts `'optional'` with zero bytes.
  It is a widening rather than a break, and every shipped reference declares
  `'required'` — but a table that claims completeness is judged on completeness.
- `ENGINE.md` §5.5 emits the settlement draw in the transcript for every credit
  event. The wire transcript carries neither draws nor credit events, because it
  is built from `(seed, definition, roundId, choices)` before a round has any. A
  verifier re-derives every credited integer from the revealed seed and the
  receipt log instead, which is exactly what `restore()` does — so the property
  is checked rather than merely available, and the location differs while the
  re-derivability does not.

With `dormancy` removed, §4.1's worked definition now constructs, fingerprints
and passes every check in §8. A test transcribes that declaration and builds it,
so the compatibility claim is a checked one rather than a reading of somebody
else's document.

## Consequences

- Core is unchanged. The frame invariant lives in the module rather than in
  `CommandLedger.install`, because `install` is shared with `progressive-market`
  and the rule it would have to state — "a receipt's frame is the number of steps
  installed before it" — is a property of this module's state machine, not of the
  ledger. A module that wants it asserts it, in its own `visit`.
- The module now implements two rounding rules and refuses one, and the refused
  one is refused with a reason rather than for want of a mechanism. ADR 0005
  Decision 4 is superseded to that extent.
- `SEQUENTIAL_CARDS_REFERENCES` is four definitions, and conformance runs 21
  checks against each. The new checks are non-vacuous on every reference,
  including the deterministic ones.
- §6.3's residual-risk statement is narrower than the one it replaces and names
  two residuals rather than one — the stake and the reveal — because those are
  exactly the inputs `restore()` can neither re-derive nor replay. The earlier
  text said "a state no legal command sequence could have produced does not
  restore, whatever its receipts say", and a 4,320-credit counterexample existed
  the whole time it said so.
