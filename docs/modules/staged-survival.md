# `staged-survival`

`N` entities advance through `S` stages. Before each stage the player picks one
**stage contract** from an adapter-defined menu, and may bank any subset of the
entities still running. The stage then resolves to a subset of survivors drawn
from a committed distribution. A contract changes the distribution the stage is
read under; it can never change a draw.

This is the second lifecycle module on the shared core, alongside
`progressive-market`. The normative description of the boundary it implements is
[`../lifecycle-modules.md`](../lifecycle-modules.md); the executable version is
`src/modules/staged-survival/`.

| Declaration           | Value                                                          |
| --------------------- | -------------------------------------------------------------- |
| `truth.kind`          | `composite` — the truth is a random tape                       |
| `steps.choiceTiming`  | `before-step`                                                  |
| `steps.beliefSpace`   | `marginal` — claims are priced by `price()`, not by the vector |
| `book.positions`      | `multi`                                                        |
| `book.settlement`     | `partial`                                                      |
| `book.actions`        | `enter`, `choose`, `bank`, `settle`                            |
| `transcript.schema`   | `staged-survival/transcript-v1`                                |
| `book.snapshotSchema` | `staged-survival/book-v2`                                      |

---

## 1. The adapter surface

```ts
interface LaneProfile {
  readonly laneFailure: Rational; // q, in [0, 1)
  readonly entitySurvival: Rational; // c, in (0, 1]
}

interface StageContract {
  readonly id: string;
  readonly label: string; // cosmetic; not fingerprinted
  readonly laneWidth: number; // entities per lane
  readonly minEntities: number; // smallest field it is offered to
  readonly profile: LaneProfile;
  readonly multiplier: Rational; // mu
}

interface SurvivalDefinition {
  readonly apiVersion: 'reveal-engine/api-v1';
  readonly id: string;
  readonly version: string;
  readonly entities: number; // N
  readonly stages: number; // S
  readonly contracts: readonly StageContract[];
  readonly drawModulus: bigint; // M
  readonly pricing: {
    readonly entryReturn: Rational; // charged once, in (0, 1]
    readonly continuationReturn: Rational; // pinned to exactly 1
    readonly rounding: 'floor';
  };
  readonly risk: {
    readonly maxWinMultiple: bigint;
    readonly capBasis: 'round-external-stake';
    readonly capMustBeUnreachable: boolean;
  };
}
```

`defineSurvivalGame()` is the only supported construction path: it validates,
clones, deep-freezes, and runs both mechanical obligations eagerly, so a
configuration that could pay wrongly cannot reach a round.

The **menu** at a stage is every contract whose `minEntities` is at most the live
field size, in declaration order. It shrinks as entities are lost or banked, and
`contractMenu(definition, liveCount)` is what a host renders from.

---

## 2. The lane model, and where correlation lives

A stage resolves in two exact steps per lane:

1. one **shared** draw fires with probability `q` and takes the whole lane;
2. otherwise each entity of the lane clears **independently** with probability `c`.

So for any lane geometry, one entity's marginal survival is

```
p = (1 - q) * c
```

and it does not depend on the geometry at all. The geometry moves the **joint**
law. `laneFailure = 0` is legal and load-bearing: it is how a contract declares
that its entities are exactly independent — zero, not an epsilon.

**Lane sizes.** The live field, ascending by entity index, is cut into
consecutive lanes of `laneWidth`; the last lane carries the remainder. Five
entities at width 3 give `[3, 2]`; at width 2, `[2, 2, 1]`.

**The law of one lane** of size `s`, for `j` survivors:

```
P_lane(0) = q + (1 - q) * (1 - c)^s
P_lane(j) = (1 - q) * C(s, j) * c^j * (1 - c)^(s - j)     for 1 <= j <= s
```

Lanes are independent of each other, so the field law over `k` survivors is the
convolution of the per-lane laws. `survivorDistribution()` computes it in exact
rationals; `distributionTotal()` is the assertion that it sums to exactly `1`,
and conformance runs it over every contract and every reachable field size rather
than trusting the algebra.

Two contracts can share a marginal and have completely different survivor
distributions. That difference is the product: a wide lane concentrates the
outcome (all or nothing together), a narrow one spreads it.

---

## 3. The tape, and counterfactual completeness

The truth is the whole random tape, derived from the seed and the round pair
before the round opens:

```
draws = stages x contracts x entities x 2
```

For every stage, **every contract on the menu**, there is one lane draw per lane
slot and one entity draw per entity — including the routes the player will not
take. Two consequences, both deliberate:

1. No operator can adapt an outcome to a decision. The decision only selects
   which pre-committed draws are consumed, and because a draw exists for every
   slot of every geometry, changing the contract re-selects draws that were
   already committed rather than requiring new ones.
2. The unchosen branches stay verifiable after the reveal.

**Addressing.** The tape is emitted in one fixed order — lane slots, then entity
slots, per `(stage, contract)` block — so the sampler counter of a draw is its
position in the tape:

```
block(stage, c)      = (stage * |contracts| + c) * N * 2
lane draw (slot j)   = label 'staged-survival/lane',   counter block + j
entity draw (e)      = label 'staged-survival/entity', counter block + N + e
```

`deriveSteps` recomputes that address and compares it against the draw's own
recorded `(label, counter, modulus)`, so a truncated, reordered or hand-assembled
truth object fails closed with `DERIVATION_FAILED` rather than resolving a stage
against the wrong randomness.

**The entity draw is addressed by the entity's own index**, not by its position
in the live field. That is what keeps the tape independent of history: whether an
entity runs in lane 0 or lane 2, and whichever entities died before it, it reads
the same committed draw.

**The sampler domain is the definition fingerprint**, not the definition id.
`roundIdentityOf()` puts `survivalFingerprint(definition)` in `definitionId`, and
core's `samplerScopeOf()` maps that field onto the scope's `domain`, so the whole
tape moves whenever any replay-visible declarative field moves. Carrying
`definition.id` there separated games by _label_ only: two definitions sharing an
id and a version but declaring different `laneFailure`/`entitySurvival` produced
byte-identical tapes under one seed. That was never exploitable by a player — the
seed pre-commitment binds the fingerprint independently, so a substituted
definition fails `COMMITMENT_MISMATCH` at verification — but the grid was blind
to the very fields that decide what a draw means, which is what SWARM's §6.4
requires it not to be.

The fingerprint is used whole rather than appended to the id, for two reasons.
`definition.id` is itself one of the fields inside the fingerprint's preimage, so
the fingerprint separates strictly more than the id did and nothing is lost; and
it is exactly 64 bytes, where an `id#fingerprint` composite would reach 129 for a
maximal 64-byte id and break the 128-byte identifier bound `assertSamplerScope`
enforces. The human-readable id and version travel in the transcript and in
`survivalIdentity()`, which is where a reader wants them.

The `TAPE_NOT_DETERMINISTIC` conformance check asserts the binding structurally
on every adapter — the sampler domain **is** the fingerprint — because it has no
generic way to synthesise a second valid definition (a twin must still satisfy
`p * mu == 1`). The behavioural half, two twins producing two digests, is written
out in `tests/staged-survival-module.test.ts`.

---

## 4. Exactness argument

Every number in a money or probability path is a `Rational` over `BigInt`,
reduced by `gcd` on construction. There is no `number` in any of them and no
rounding anywhere except one place, named below.

**4.1 The draws are exactly uniform.** `core/random.ts:uniformBigInt` is
rejection sampling over 256 bits: it retries until the HMAC output falls below
`2^256 - (2^256 mod M)` and then reduces mod `M`. Every residue is therefore
equally likely; there is no modulo bias to bound because there is none.

**4.2 The survival test is an exact comparison, not a rounded one.** For a
reduced probability `n/k`, the threshold is `t = n * (M / k)` and the event is
`draw < t`. Its probability is exactly `t / M = n / k` **provided `k` divides
`M`** — which is why `drawModulus % denominator === 0` is a definition-level
obligation checked in `assertSurvivalDefinition`, for every `laneFailure` and
every `entitySurvival` on the menu, and not a convenience. A definition that
fails it cannot be constructed, so no round can ever compare a draw against a
truncated threshold.

**4.3 The joint law is computed, not approximated.** `C(s, j)` comes from core's
exact `fallingFactorial / factorial`; `c^j` and `(1-c)^(s-j)` are repeated exact
rational multiplication; the convolution is exact rational addition. Nothing is
normalised after the fact, so `sum_k P(k) = 1` is a fact to be checked rather
than an artifact of dividing by a total.

**4.4 Claim value is exact for the whole round.** An entity's claim opens at
`stake * entryReturn` and is multiplied by `mu` for each stage it survives. It is
floored **only** at a credit boundary — a `bank` or a `settle` — never between
stages. So a five-stage ride loses nothing to repeated rounding; the round's
entire rounding loss is at most one minor unit per credit event, and the number
of credit events is bounded by the ledger's receipt budget.

**4.5 The continuation identity is exact.** `assertSurvivalDefinition` requires,
for every contract, using `equal()` on reduced rationals:

```
(1 - q) * c * mu  ==  pricing.continuationReturn  ==  1
```

Both halves are refusals, not warnings: a contract that does not cancel its own
hazard, or a `continuationReturn` other than `1`, fails to define.

**4.6 The cap bound is exact, and attained for both references.** A claim opens
at `stake * entryReturn` and is multiplied once per survived stage by at most
`max(mu)`, and flooring only ever reduces it, so
`entryReturn * max(mu)^stages` is a sound upper bound on the credit one unit of
external stake can produce. It is **attained** — and so the check is not merely
conservative — whenever the highest-multiplier contract is available at the full
field, because every entity surviving every stage under it is a
positive-probability outcome and the field never shrinks along that path. Both
shipped references satisfy that, so for them the bound is the exact supremum; for
a definition whose highest multiplier is gated behind a small field it remains
sound and may be loose, and the check errs on the side of refusing.

When `risk.capMustBeUnreachable` is declared, `defineSurvivalGame()` requires
that value to sit **strictly below** `risk.maxWinMultiple`, in exact rational
comparison. For the shipped reference: `191/200 * 4^3 = 1528/25 = 61.12 < 100`.

**4.7 Elimination is exactly zero.** A failed entity's claim value is set to
`rational(0n)`, and its belief weight is the BigInt `0n`. `weightVector` accepts
zero weights and rejects an all-zero vector, so "the field is empty" is modelled
as a terminal outcome slot of its own rather than as an impossible vector.

**4.8 A definition the arithmetic cannot carry is refused at define time.**
Exact rationals are unbounded in principle and bounded in practice:
`ENGINE_LIMITS.maxBigIntBits` is 4096, and `rational()` checks its arguments
_before_ reducing them. The declared fields are each bounded on their own, but
the derived ones grow as powers of them — the field survivor law carries
`den(c)^entities`, and the maximum round return carries `mu^stages` — so a
declaration can satisfy every field-level bound, satisfy `p * mu == 1` exactly,
and still be one this module cannot price.

`assertSurvivalDefinition` therefore bounds the two derived widths and refuses
with `INVALID_ADAPTER`. Writing `W(x)` for binary width, `W(r)` for the wider
half of a rational, `h = 1 - q`, `m = 1 - c`, `w = laneWidth`, `n = entities`,
`S = stages`:

```
laneBits    = W(den h) + W(den q) + w * max(W(den c), W(den m)) + w
fieldBits   = 2 * ceil(n / w) * laneBits + W(n) + W(mu) + 2
pricingBits = 2 * (W(entryReturn) + S * W(mu) + W(maxWinMultiple))
            + maxStakeBits + W(n) + 1
```

and both must fit in `maxBigIntBits`. The trailing `+ w` in `laneBits` covers the
binomial (`C(s, j) <= 2^w`); every numerator is bounded by its denominator
because `h`, `c` and `m` all lie in `[0, 1]`; the convolution's running
denominators divide the product of the lanes processed so far; and the factor of
two covers `add()`, which forms `a.den * b.den` before reduction — the path taken
both by accumulating a convolution and by summing claim values across entities.
The mean's factor of `n` and the fairness identity's factor of `mu` are applied
once, after the convolution, so they are not doubled.

**The stake is inside the pricing bound, and that is what makes the money path
total.** A claim value is `stake * entryReturn * prod(mu)`, and the stake is the
one input to it that is a runtime argument rather than a declaration.
`SURVIVAL_LIMITS.maxStakeBits` is 64 — `1.8 x 10^19` minor units, beyond any real
stake — and reserving that width at define time is what lets `enter()` refuse a
wider one with a typed `CLAIM_REJECTED` **before** it mutates anything. That
ordering matters: `fundStake()` has already moved the cap basis and the entry list
by the time the claim value is constructed, so an overflow there left an inflated
basis, an entry with no claim, and no receipt — a book `restore()` could not even
parse. `restore()` holds a restored entry stake to the same width, because the
snapshot codec's own bound is the engine limit and that is far wider than
anything this module accepts.

These bounds are **sufficient, not tight**. They bound the widest unreduced
integer each derivation can construct, and reduction usually makes the real value
far smaller, so a declaration refused here might have worked. The refusal fails
closed deliberately: the alternative is an adapter defect surfacing as
`INVALID_RATIONAL` from inside the rational primitives at the first derivation,
which reads as an engine arithmetic failure and aborts a conformance run part way
through its checks. The slack is calibrated rather than assumed — a test pins that
the whole 32-entity field in one lane at 60-bit denominators still defines and
still derives a law summing to exactly `1`. Both shipped references clear the
bounds by more than an order of magnitude: the widest of the five contracts is
`wide`, at 110 of 4096 bits for the survivor law and 128 for the pricing chain.

**4.9 The exported derivation surface validates its own arguments.** Everything
in §4.8 is a define-time refusal, and it protects the round. It does not protect
a helper a host calls directly, and this module exports several: the lane
geometry, the per-lane and field survivor laws, the closed-form mean, the stage
resolver, the pricing prefix. Each is reachable with whatever a caller holds, so
each is held to the module's own limits rather than to the assumption that some
earlier call validated a definition. Three distinct reasons, and all three are
checked:

- **Arithmetic width.** `laneSurvivorDistribution()` takes a lane size and `c^j`
  under it is a power, so a size outside `[0, laneWidth]` is refused with
  `INVALID_CHOICE`; a validated contract with a wide denominator would otherwise
  overflow the engine limit and surface as `INVALID_RATIONAL` from the rational
  primitives rather than as a rejected argument.
- **Allocation.** `laneSizes()` builds one element per lane, so its `liveCount`
  is the length of the array it is asked to build, and its `laneWidth` is the
  loop's decrement. Only the width was bounded, so `laneSizes(narrow, 3e7)`
  allocated thirty million elements and `1e9` spent seconds before dying with a
  bare `RangeError` — an unbounded allocation and an untyped throw out of a
  public export. Both ends are now bounded by `SURVIVAL_LIMITS.maxEntities`,
  which no legitimate field can exceed. `lanePartition()` and
  `expectedSurvivors()` inherit the same bound; `liveAfter()` bounds the entity
  count for the same reason, since the "no steps yet" branch builds a field.
- **Meaning.** `survivorDistribution()` takes a definition _and_ a contract, and
  it now requires the contract to be one that definition declares. A foreign
  contract has a law, but not a law any round of this game could realise — its
  denominators need not divide `drawModulus`, so no threshold this definition can
  build corresponds to the probabilities being convolved. Identity is the test
  because every accessor a host reaches a contract through hands back the
  declared object.

**Nothing on the exported surface throws an untyped error.** That claim was
unqualified and checkably false: a systematic sweep found 47 places where a
malformed argument escaped as a `TypeError` or a `RangeError` — the probability
helpers dereferencing `profile.laneFailure` after validating only `laneWidth`,
`resolveStage()` calling a draw source it never checked was callable, the log
comparators and the wire encoder reading `.length` off `null`. None was reachable
from an untrusted path — `verify()`, `deserializeTranscript()` and `restore()`
were and are total — but the claim was the thing under test, so the helpers moved
rather than the claim. The sweep is kept as a test, over every exported entry
point and a matrix of junk arguments, and it asserts the taxonomy rather than any
particular code. One subtlety it pins: every one of these validators iterates by
index, because `forEach`, `map`, `every` and `reduce` all **skip holes**, and a
sparse array is exactly the shape that would otherwise walk past the check that
exists for it.

---

## 5. The money model

```
value_0(e)            = stake_e * entryReturn                       (margin, once)
value_{t+1}(e)        = value_t(e) * mu(C_t)      if e survives stage t
                      = 0                          if e fails
credit(bank B at t)   = payableWithinCap(sum_{e in B} value_t(e), basis, cap, liquid)
credit(settle)        = payableWithinCap(sum_{e live} value(e),   basis, cap, liquid)
basis                 = sum of every externally funded entry
```

**The cap basis is the round's accumulated external stake.** Every `enter` calls
`fundStake(stake, 'external')`, so a round holding five funded entities has a
ceiling proportional to all five — which is what the player actually risked.
Nothing a player wins inside the round ever grows the basis, so the ceiling cannot
compound.

**Every credit goes through `creditClaim()`.** Banking happens repeatedly inside
one round, which is exactly the shape that punishes a forgotten `applyCredit`:
`creditWithinCap` is a pure query and a book that performs it without the
matching mutation would credit its full ceiling once per bank, with
`capped: false` on every receipt. `creditClaim` cannot be half-performed, so each
banked subset is measured against the balance the last one left behind, and the
invariant `liquidBalance <= basis * maxWinMultiple` holds across the whole chain.
`tests/staged-survival-oracle.test.ts` enumerates it.

**Both money-bearing commands close entries.** `choose()` and `bank()` each
require the whole field to be funded — `claims.size == entities` — before they
will run. For `choose()` that is the field the step derivation starts from. For
`bank()` it is the reconnect invariant: a bank credits, so once one succeeds the
round holds a credited receipt, and `restore()` refuses an `enter` receipt that
follows a `bank` one. Without the guard, `enter(0) -> bank([0]) -> enter(1..4)`
was accepted by the live path and produced a book `restore()` then rejected for
the rest of the round's life — a round holding real credit that no reconnect
could reconstitute. No value leaked (the basis only grows, so an early bank is
measured against a strictly smaller ceiling), but availability did. An entry
after a bank is now impossible as a _consequence_ rather than as a second guard:
by the time a bank can run, every entity id is taken.

**`bank()` credits before anything has been proved, and that is inherent.** The
book deliberately holds no seed — it is the live command surface, and the seed is
not revealed until settlement — so at the moment a bank credits, the step it
credits against has been checked for _shape_ and not for _truth_.
`assertStepGeometry()` establishes everything that does not need the seed: that
the step resolves exactly the running field, that its lanes are the partition the
chosen contract produces, and that a collapsed lane took every entity in it. What
it cannot establish is the only thing left — which of the entities in a lane that
_held_ actually cleared. Those are committed draw bits, and reading them needs the
seed.

So a host that feeds `resolve()` a step it did not get from `deriveSteps()` can
be credited on it. Driven end to end on the five-runner reference at a stake of
`1000` each: the honest step loses one runner and a full bank credits `4547`; the
same round fed a fabricated all-survive step — correct lanes, correct field, only
the survivor bits changed — credits `5684`. `settle()` then fails
`TRANSCRIPT_MISMATCH` with the `5684` already standing and the round left
non-terminal.

Nothing here is exploitable by a **player**: the step comes from the operator's
own derivation, and settlement is exactly the check that catches an operator that
lied to itself. But the ordering is real, it is the commit-reveal trade this
module makes on purpose, and §9 lists it as a residual risk rather than leaving
it to be discovered. `tests/security/staged-survival-hostile-input.test.ts` pins
both halves — that the forged credit lands, and that settlement refuses it — so
the backstop is a checked property and not a promise. The integration obligation
is the short one: pass `resolve()` the step `deriveSteps()` returned, never a
reconstructed one.

### 5.1 The invariance theorem

> Under `p * mu = 1` for every contract, the expected total claim value of a
> round is `sum_e stake_e * entryReturn` for **every** policy: every contract
> path, every banking decision, every stopping point.

_Proof._ Fix an entity `e` running stage `t` under contract `C`. Its value after
the stage is `value_t(e) * mu(C)` with probability `p(C)` and `0` otherwise, so
`E[value_{t+1}(e)] = value_t(e) * p(C) * mu(C) = value_t(e)`. Claim value is
therefore a martingale in the stage index, and it is a martingale _per entity_,
so correlation between entities inside a lane changes the variance of the round
total and never its mean. Banking removes an entity's value from the at-risk pool
and credits exactly that amount, so it is value-neutral. The total is a finite sum
of per-entity martingales stopped at policy-chosen times, and optional stopping
over a bounded horizon gives the claim. Only `entryReturn`, charged once at entry,
separates the expectation from the stake. ∎

The oracle test proves it by enumeration rather than by citing the proof: it
enumerates every elementary event of a three-entity, two-stage instance, and
checks `sum_k P(k) * k * mu == n` for every contract and every reachable field,
plus the round total for every `(contract, contract, banking policy)` triple.

---

## 6. The round pair and the two-phase commitment

A choice-timed round's body does not exist until the round is over, so one
commitment cannot cover both "the seed predates every decision" and "this
settlement is the settlement of that decision log". The scheme is two-phase and
both phases are mandatory.

| Phase                   | Published                             | Binds                                                                                                                                       |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — seed pre-commitment | before the round opens                | seed, module id, definition id **and fingerprint**, the operator round id, proof version                                                    |
| 2 — body commitment     | at settlement, with the revealed seed | the definition identity, the round **pair**, the tape digest, every logged decision (contract _and_ banked subset), and every resolved step |

**A round is identified by a pair**: the operator's round id and the player's
entropy. Its canonical form is `<roundId>|<clientEntropy>`, and that is what
`truth.derive` and `RoundIdentity.roundId` carry. Both halves reach the sampler
scope, so both are inside every draw.

Phase 1 binds **only the operator half**, and that omission is the mechanism: the
entropy does not exist yet. The operator seals a seed against a round it has
already named; the player then contributes 32 bytes the operator could not have
predicted; every draw is a function of both. An operator grinding seeds before
publication is grinding against an unknown, so the grind buys nothing.
`SEED_PRECOMMITMENT_BROKEN` asserts the pre-commitment does not move when the
entropy does — a commitment that moved with it could not have been published
first.

[`../adr/0008-round-entropy-without-a-core-change.md`](../adr/0008-round-entropy-without-a-core-change.md)
records why the pair rides inside the contract's `roundId: string` rather than
through a widened core signature, and what that costs.

---

## 7. Wire formats and verification

### 7.1 `staged-survival/transcript-v1`

```jsonc
{
  "schema": "staged-survival/transcript-v1",
  "definitionId": "...",
  "definitionVersion": "...",
  "definitionFingerprint": "<64 hex>",
  "roundId": "...", // operator half
  "clientEntropy": "<64 hex>", // player half
  "seedCommitment": "<64 hex>",
  "tapeDigest": "<64 hex>",
  "choices": [{ "contractId": "wide", "banked": [0] }],
  "steps": [
    {
      "index": 0,
      "contractId": "wide",
      "banked": [0],
      "lanes": [{ "entities": [1, 2, 3], "collapsed": false }],
      "survivors": [1, 2],
      "failed": [3],
    },
  ],
  "commitment": "<64 hex>",
}
```

`banked` is part of the **decision**, not a separate log, because withdrawing an
entity changes which entities are at risk and therefore the step. A transcript
that omitted it would replay a different round from the one that was played.

A step binds its lane geometry and its failure list as well as its survivors: a
body that bound only the survivors would let a lane be re-cut, or a failure
re-attributed, under an unchanged commitment.

### 7.2 Verification, in the contract's required phase order

1. decode the wire form (`deserializeTranscript` — exact key sets, bounded
   lengths, no coercion, unknown schema fails `UNSUPPORTED_VERSION`);
2. check the definition id, version **and fingerprint**;
3. re-derive the seed pre-commitment from the revealed seed and compare in
   constant time;
4. re-derive the tape and compare its digest in constant time;
5. re-derive the steps from the transcript's **own** logged choices and compare;
6. re-seal the commitment body and compare in constant time.

Every failure is one of `INVALID_TRANSCRIPT`, `UNSUPPORTED_VERSION`,
`DEFINITION_MISMATCH`, `DERIVATION_FAILED`, `TRANSCRIPT_MISMATCH`,
`COMMITMENT_MISMATCH`. Nothing throws; an incidental exception is routed through
`classifyVerificationError`. A choice log naming a contract the menu never
offered is `INVALID_TRANSCRIPT` — it is not a disagreement about randomness, it
is a transcript that could not have been played.

### 7.3 `staged-survival/book-v2`

`restore()` re-validates rather than trusting, and **nothing money-bearing is
read out of the snapshot**:

- every claim's value and liveness are re-derived from the entry stakes and the
  replayed steps;
- every credited figure is recomputed with the same `payableWithinCap` the live
  path used, in ledger order, and compared against its receipt — including the
  `capped` flag;
- every receipt's `commandFingerprint` is recomputed from the restored state, so
  a rewritten entry, decision, or bank subset cannot survive its own ledger;
- the withdrawn set is recorded twice — in the decision log and in the bank
  command log — and the two must agree as a **disjoint** union, so an entity
  named in two places is a contradiction rather than a set element that collapses
  into one;
- a snapshot carrying both an unresolved decision and an uncommitted banked
  subset is refused: `choose()` folds the subset into its own decision and clears
  it, and `bank()` is closed while a decision is pending, so the live path cannot
  produce that state. Restored, it would re-fold the stale entity into the _next_
  decision and the round could never produce a valid transcript or be settled;
- a logged decision or a bank record implies a fully funded entry list, because
  both commands refuse until the field is complete;
- each step is checked against the field it must have run, the lane partition
  that field produces under the chosen contract, and the rule that a collapsed
  lane takes every entity in it;
- the **trailing** decision — logged by `choose()` and not yet resolved — runs
  the admission test `choose()` runs, from the same call: its banked subset must
  be entities that were running, and `contractFor()` must offer its contract to
  the field that is left. Every other decision is re-validated as a side effect
  of the step it resolves; this one has no step, so it arrived through nothing
  but the structural wire parse. A snapshot naming an unknown contract there, or
  one the menu does not offer at that field, restored with its credit already
  standing and no legal move left — `resolve()` fails on the contract, `settle()`
  refuses an unresolved decision, `bank()` refuses a pending one. No value is
  created and the cap is untouched; the loss is availability on a round holding
  money, which is the same shape as the two entries above it.

The last three are there because `restore()` is advertised as re-validating
rather than trusting, and a state the live path cannot produce is exactly the
kind a forged snapshot store would supply. They cost availability rather than
value, and they are refusals for that reason and not for an arithmetic one.

**The live path runs the same step admission test, from the same function.** The
last bullet is not a reconnect-only concern. `resolve()` and `restore()` both
call `assertStepGeometry()`, so the set equality, the lane partition and the
collapsed-lane rule are checked identically on the way in and on the way back.
This was a real defect and not a hypothetical one: `resolve()` once checked only
the resolved set, so a step reporting a geometry the chosen contract does not
produce — re-cut lanes, empty lanes, an entity in two lanes, a collapsed lane
reporting survivors — was accepted live and refused by every later `restore()`.
The book could take a `bank()` credit in that state and then never reconnect,
which is the same availability defect §5 records for `enter -> bank -> enter`,
one field over. The two paths now share one function precisely so they cannot
drift again; `tests/security/staged-survival-hostile-input.test.ts` asserts each
shape is refused **and** carries the metamorphic form of the law — nothing
`resolve()` accepts may be something `restore()` refuses.

The checksum is not the control. It detects corruption, not tampering: anyone who
can rewrite a field can recompute the hash over it. Every tamper case in
`tests/security/staged-survival-hostile-input.test.ts` and in the
`SNAPSHOT_NOT_REVALIDATED` conformance check therefore **re-seals** its mutation
before restoring it, so what is under test is the semantic validation. One case
deliberately does not re-seal, and says so on the line above it.

What `restore()` cannot check is stated rather than implied: it holds no seed, so
it cannot verify a step against the tape. A step rewrite that changes no credited
figure is caught at settlement instead, where the revealed seed exists and the
transcript must match the book's own log.

### 7.4 Versioning

| Change                                      | Required                                   |
| ------------------------------------------- | ------------------------------------------ |
| Any replay-visible declarative field        | new `version`, new fingerprint             |
| Any change to tape addressing or resolution | new transcript schema + a frozen fixture   |
| Any change to the transcript fields         | new transcript schema + a frozen fixture   |
| Any change to the commitment body layout    | new commitment version, old verify-only    |
| Any change to snapshot fields               | new snapshot schema; unknown ones rejected |

`tests/fixtures/staged-survival-transcript-v1.json` and
`staged-survival-book-v2.json` are committed files compared field for field, not
round trips generated at run time. The retained book-v1 is a negative fixture:
it predates the published seed commitment and cannot be migrated by inventing
one. Regenerate current fixtures with `npm run fixtures:update`, deliberately.

That command formats its output with **prettier**, using the repo's own
configuration, and is idempotent against the repo's own gate: regenerating an
unchanged fixture leaves the tree clean. It wrote raw `JSON.stringify(…, 2)`
before, which disagrees with prettier over short arrays, so following the
documented path left every fixture dirty with a pure-whitespace diff and
`npm run verify` then failed at `format:check`. A regeneration path that breaks
the build is not a path.

**The fingerprint enumerates lane sizes, not only the width that generates
them.** The width names the geometry; the sizes are what determine the survivor
distribution. Binding only the width would leave a hole: keep `laneWidth` and
redefine how the remainder lane is cut, and every correlated price in the round
moves under an unchanged fingerprint. Cosmetic `label` fields stay out, so a
rename cannot change the identity of the game being played.

---

## 8. The reference adapter

`fiveRunnerReference` — five runners, three stages, three contracts. A toy, and
deliberately the _shape_ the two real consumers need rather than either of them.

| contract | lane width | `q`    | `c`   | marginal `p` | `mu`    | offered from |
| -------- | ---------- | ------ | ----- | ------------ | ------- | ------------ |
| `wide`   | 3          | `1/25` | `7/8` | `21/25`      | `25/21` | 3 runners    |
| `split`  | 2          | `0`    | `3/4` | `3/4`        | `4/3`   | 2 runners    |
| `narrow` | 1          | `1/2`  | `1/2` | `1/4`        | `4/1`   | 1 runner     |

- `wide` is the safest per entity and the most correlated: three runners share
  one collapse draw.
- `split` cuts the field into pairs with `q` **exactly zero**, so its entities
  are exactly independent and its joint law is a clean product.
- `narrow` is one runner per lane: correlation is structurally absent, the
  marginal is lowest, and the multiplier is largest.

`drawModulus = 1,200,000`, divisible by every reduced denominator on the menu
(25, 8, 4, 2, 1). `entryReturn = 191/200`; `continuationReturn = 1`. Exact
maximum round return `191/200 * 4^3 = 1528/25 = 61.12`, so `maxWinMultiple: 100`
is declared unreachable and the arithmetic says so. Tape size `3 * 3 * 5 * 2 = 90`
draws.

`oracleTrialReference` — three entities, two stages, `pair` (width 2, `q = 1/3`,
`c = 3/4`, `mu = 2`) and `solo` (width 1, `q = 0`, `c = 2/3`, `mu = 3/2`),
`drawModulus = 12`, `entryReturn = 9/10`, `maxWinMultiple: 4` against an exact
maximum of `18/5`. It is small enough that the whole elementary-event space is
enumerable, which is what the oracle test does.

---

## 9. Conformance and evidence

Twelve declared checks, all synchronous, all run by `reveal-conformance` and
therefore by CI over both references:

| Code                         | Scope      | What it establishes                                                               |
| ---------------------------- | ---------- | --------------------------------------------------------------------------------- |
| `NOT_DEEP_FROZEN`            | definition | the declarative graph is frozen                                                   |
| `CONTINUATION_NOT_FAIR`      | definition | `p * mu == 1` per entity **and** `sum_k P(k)(k/n) mu == 1` over the joint law     |
| `DISTRIBUTION_NOT_EXACT`     | definition | `sum_k P(k) == 1` exactly and the mean matches `n(1-q)c`                          |
| `LANE_GEOMETRY_UNSTABLE`     | definition | lane sizes tile the field, are stable, and never exceed the width                 |
| `CAP_REACHABLE`              | definition | a cap declared unreachable strictly exceeds the exact maximum return              |
| `TAPE_NOT_DETERMINISTIC`     | round      | the tape is fixed by the seed and moves with **either** half of the round pair    |
| `CHOICES_DO_NOT_DRIVE_STEPS` | round      | steps are a pure function of (tape, choices) and move when the choices do         |
| `COMMITMENT_IGNORES_CHOICES` | round      | the body binds the contract **and** the banked subset of every decision           |
| `SEED_PRECOMMITMENT_BROKEN`  | round      | the pre-commitment re-derives, is seed-specific, and is **entropy-independent**   |
| `TRANSCRIPT_ROUND_TRIP`      | round      | a built transcript verifies; a rewritten survivor list is a `TRANSCRIPT_MISMATCH` |
| `SNAPSHOT_NOT_REVALIDATED`   | round      | `restore()` accepts a re-derived staked snapshot and rejects re-sealed rewrites   |
| `BANKING_LOSES_VALUE`        | round      | exact value is conserved across every prefix/suffix split, with floor loss <= 1   |

`stakedSnapshotFor()` re-derives a staked mid-round snapshot from the module's own
primitives, because checks are synchronous and the book's command API is not. A
contract test pins it field for field against a genuinely driven round, so the
re-derivation cannot drift into something `restore()` would reject for the wrong
reason.

### Bounded load and throughput

`scripts/stress.ts` and `scripts/benchmark.ts` both run this module alongside
`progressive-market`, and each module carries its **own** replay anchor in
`moduleDigests` — which is why the artifacts moved to `reveal-engine/stress-v3`
and `benchmark-v3`. A single digest over the whole run would have moved the
moment a second module joined the workload, making a new workload
indistinguishable from drift in an existing one; per-module anchors keep
`progressive-market`'s 0.2 value byte-identical while giving this module one of
its own. The stress run compares every anchor the baseline carries and fails on a
mismatch **or** on a module the baseline anchors and the run no longer produces.

The survival workload funds the whole field, walks the stage ladder choosing from
the live menu before each stage resolves, banks subsets at some boundaries,
reconnects through a snapshot, refuses a replayed step, rejects a tampered
commitment, settles against the revealed seed, and asserts
`liquidBalance <= basis * maxWinMultiple` on every round.

### Residual risks this module does not close

- **Publication ordering.** The entropy control depends on the seed
  pre-commitment being durably published _before_ the entropy is collected.
  Wall-clock ordering is not a property of the arguments and no library can check
  it. See [`../threat-model.md`](../threat-model.md).
- **Entropy that is not the player's.** If the client echoes a value the server
  suggested, the control is gone and nothing in the transcript shows it.
- **Selective non-reveal.** Nothing in commit-reveal forces an operator to
  settle. This module has no expiry or reconciliation path; closing an abandoned
  round is an operator concern and is not modelled here.
- **Credit precedes proof.** `bank()` credits against a step that has been
  checked for shape but not against the tape, because the book holds no seed;
  `settle()` is the only call that verifies, and it runs afterwards (§5). An
  operator that resolves a round with a step it did not derive can credit a
  figure its own settlement will then refuse, leaving the credit standing and the
  round unsettleable. Fixing the lane-geometry gap narrowed this — a forged
  geometry is now refused at `resolve()` — but it cannot close it: the survivor
  bits inside a lane that held are exactly the part that needs the seed.
- **Seed custody and grinding before publication.** Outside this library.

---

## 10. Compatibility with the two build-ready consumers

Both `branchfall/docs/ENGINE.md` and `swarm/docs/ENGINE.md` were written against
an imagined engine before this contract existed. What they need and what this
module provides, stated plainly in both directions.

### Provided

| Requirement                                                                | Where                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------- |
| Choice-timed lifecycle, decision before the stage resolves                 | `choiceTiming: 'before-step'`, `choose()`          |
| Two-phase commitment, mandatory                                            | `seedCommitment()` + `commitmentBody()`            |
| Player entropy in every draw, chosen after phase 1                         | `RoundRef.clientEntropy` (§6, ADR 0008)            |
| Counterfactually complete hazard table                                     | the tape (§3)                                      |
| Explicit correlation: shared lane collapse + independent per-entity checks | `LaneProfile` (§2)                                 |
| Lane geometry fingerprinted **by size**                                    | `definitionFields()` (§7.4) — closes BRANCHFALL §8 |
| `continuationRtp` pinned to exactly 1                                      | `pricing.continuationReturn`, a refusal            |
| Margin charged once per ticket                                             | `pricing.entryReturn`                              |
| `SHELTER` / `HARVEST`: credit part of the claim mid-round                  | `bank(subset)` (§5)                                |
| Mechanical fairness identity checked at define time                        | `assertSurvivalDefinition` (§4.5)                  |
| Mechanical risk-headroom check, cap unreachable                            | `assertCapIsUnreachable` (§4.6)                    |
| Multiplier derived from the declaration, never hand-entered                | `p * mu == 1` refusal makes a typo undefinable     |
| Exact rational money, floor only at a credit boundary                      | §4.4                                               |
| Frame fence, idempotency, receipts, re-validating restore                  | `SurvivalBook` (§7.3)                              |
| Stable machine-branchable failure codes                                    | §7.2                                               |
| Cap accounting                                                             | **round basis only** — diverges, see §10.2         |

### 10.1 SWARM's §6 conformance list, item by item

This section previously said "everything else in SWARM's §6 conformance list is
covered here". That was checkably false for several of the eighteen items, and
this is the section a consuming team is entitled to trust as a gap analysis, so
here is every item with a verdict. **Analogue** means the property holds in this
module's own vocabulary and is checked; it does not mean SWARM's literal check
would run.

| #   | SWARM §6 requirement                                     | Verdict          | Where, or why not                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Draw bands tile `[0, drawModulus)` exactly               | **Analogue**     | No band table. `threshold()` refuses unless `drawModulus % denominator == 0`, so each declared probability is an exact integer count of residues (§4.2).                                                                                                                                                                        |
| 2   | `maxUnits === maxChildren * (settle - 1)`                | **N/A**          | Cohort sizing. No offspring here.                                                                                                                                                                                                                                                                                               |
| 3   | `assertLadderIsFair`, exactly                            | **Analogue**     | `p * mu == 1` per contract and `entryReturn` as the whole edge, refused at define time (§4.5).                                                                                                                                                                                                                                  |
| 4   | Grid moves with round, game, entropy **and fingerprint** | **Provided**     | All four. The sampler domain **is** the fingerprint (§3); `TAPE_NOT_DETERMINISTIC` checks it structurally and the module suite checks it behaviourally on twins. This was the round-2 gap and it is closed.                                                                                                                     |
| 5   | Unbiased sampler; assert the rejection bound             | **Inherited**    | Core's `uniformBigInt` does exact rejection against `2^256 - (2^256 mod modulus)` and never uses floats. It is core's property with core's tests; no staged-survival check re-asserts it, and this row does not claim one does.                                                                                                 |
| 6   | Exhaustive value check over the state space              | **Analogue**     | The oracle test enumerates a three-entity, two-stage instance exhaustively against an independently coded model; `distributionIsExact` covers every reachable field size on both references (§9).                                                                                                                               |
| 7   | `assertRiskIsHeadroom`, no reachable cap                 | **Partial**      | The round cap is covered by `assertCapIsUnreachable` (§4.6). Side-bet caps and the operator exposure limit are not modelled.                                                                                                                                                                                                    |
| 8   | Side bets priced at exactly `targetRtp`                  | **Not provided** | No side bets. See "Not provided" below.                                                                                                                                                                                                                                                                                         |
| 9   | Two-phase commitment, mandatory                          | **Provided**     | `seedCommitment()` + `commitmentBody()`, both re-derived on the verify path (§6, §7.2).                                                                                                                                                                                                                                         |
| 10  | The body binds the log                                   | **Provided**     | `COMMITMENT_IGNORES_CHOICES` seals two logs under one seed and requires two bodies, for the contract **and** for the banked subset.                                                                                                                                                                                             |
| 11  | The chain binds the frames                               | **Not provided** | There is no action chain in this module at all. Nothing returns a `chain(i)`, so there is no prefix relation to bind into the body. A consumer that needs mid-round frames to be provably prefixes of the terminal state does not get it here.                                                                                  |
| 12  | Client entropy is live                                   | **Provided**     | `RoundRef.clientEntropy`, exactly 32 bytes, in every draw; a round cannot open without it (§6, ADR 0008).                                                                                                                                                                                                                       |
| 13  | Wild-line / side-bet disclosure                          | **Partial**      | The side-bet half is N/A. The disclosure half holds by construction and is stronger than a check: `SurvivalBook` holds no seed and no tape, so it has nothing to leak about an unresolved stage.                                                                                                                                |
| 14  | Harvest quantum: every `k` in `[0, units]`               | **Analogue**     | `bank(subset)` takes any **non-empty** subset of the running field, credits exactly the summed claim value floored once, and a full bank still requires `settle()`. `k = 0` is expressed as _not calling_ `bank()`; `bank([])` is `CLAIM_REJECTED`, because a zero credit is a receipt and an idempotency key spent on nothing. |
| 15  | One commitment per stage                                 | **Analogue**     | `choose()` refuses a second decision for the same stage and mutates nothing; `bank()` is closed while a decision is pending; the log carries at most `stages` decisions and derivation refuses more (§7.3).                                                                                                                     |
| 16  | `reconcile()` on a timeout                               | **Not provided** | No reconciliation path. Operator protocol, see "Not provided" below.                                                                                                                                                                                                                                                            |
| 17  | Abandonment covers every unsettled state                 | **Not provided** | No expiry or abandonment model. Named in §9 as a residual risk, not implied to be handled.                                                                                                                                                                                                                                      |
| 18  | Snapshot round-trips and re-derives                      | **Partial**      | Everything except the two clauses that presuppose SWARM's own shape: there is no action chain to validate the log against (item 11), and cap accounting is one line, not per-line (§10.2). All else holds (§7.3).                                                                                                               |

### Partly provided: BRANCHFALL's player-chosen lane balance

BRANCHFALL's `RouteContract` carries a fixed `laneCount` plus a per-field menu of
balances: `SPLIT` is always two lanes, and `laneSplits(n) = ceil(n/2) .. n-1`
names the sizes of the leading lane. This module has no per-contract balance
menu; it has `laneWidth`, and the field is cut into consecutive lanes of that
width with the remainder **last** and never larger than the width.

One balance at one field size is expressible as one contract: `laneWidth: 3` at
five runners gives `[3, 2]`, `laneWidth: 4` gives `[4, 1]`, which is exactly
BRANCHFALL's `laneSplits(5) = [3, 4]`. What is **not** expressible is the menu as
a whole:

- **The lane count is a function of the field, not of the contract.** A
  `laneWidth: 2` contract yields `[2, 2]` at four runners and `[2, 2, 1]` at
  five — a three-lane geometry BRANCHFALL's two-lane `SPLIT` never offers, with a
  different joint law.
- **A later lane can never be larger than an earlier one.** The remainder goes
  last, so `[2, 3]` is inexpressible at any width. BRANCHFALL does not offer it
  either (its `k >= ceil(n/2)` puts the larger lane first), but the restriction is
  ours and is worth stating: it is a property of the partition, not a coincidence.
- **There is no `maxEntities`.** `contractMenu()` and `contractFor()` gate on
  `minEntities <= liveCount` only, so a contract designed for one field size stays
  on the menu for every larger field. An adapter reproducing BRANCHFALL's menu
  therefore also exposes geometries BRANCHFALL does not offer, and cannot be
  restricted to the field sizes each balance was designed for.

So the menu is adapter-defined, which is the right shape; the _geometry function_
is not adapter-defined, which is the gap. Closing it means letting a contract
supply its own `laneSizes(n)` — a widened `StageContract` with its own
fingerprint enumeration and its own conformance obligation — and this module does
not do that today. What it does do is fingerprint the enumerated lane **sizes**
of every reachable field rather than only the widths, so whatever geometry a
definition declares is bound to its identity.

### 10.2 Diverges: BRANCHFALL declares a per-ticket cap basis

BRANCHFALL's main route ticket declares `risk.capBasis: 'per-ticket'`, and its
`docs/ENGINE.md` §6 states it in bold — "The cap basis is the ticket, not the
round. The route ticket accumulates against the route stake" — with `MATH.md` §9
proving unreachability on **that** basis. This module refuses any other basis
outright: `assertSurvivalDefinition` fails `INVALID_ADAPTER` with "The only cap
basis this module proves is round-external-stake". A BRANCHFALL declaration
therefore does not build here without changing that field, and the change is not
cosmetic.

**Under `capMustBeUnreachable: true` the difference cannot bind, and that is
provable rather than hopeful.** `assertCapIsUnreachable` refuses the definition
unless `maxRoundReturn = entryReturn * max(mu)^stages` is **strictly** below
`maxWinMultiple`, and total round credit is at most `basis * maxRoundReturn`.
The shared ceiling is `basis * maxWinMultiple`, so the ceiling is unreachable by
a strict margin no matter how the credit is split across banks. Both shipped
references clear it comfortably (`1528/25` and `18/5` against a multiple of 100
and 1000).

**Under a `false` declaration the two bases genuinely differ.** A round ceiling
is one accumulator shared by every credit event, so an early bank consumes
headroom that a per-ticket accumulator would have kept separate: the same
sequence of credits can be capped here and uncapped under BRANCHFALL's rule. A
consumer that wants a reachable cap — a design choice this module permits but
does not recommend — is not getting BRANCHFALL's accounting, and must re-do the
unreachability proof against the round basis rather than porting `MATH.md` §9.

### Not provided, and named rather than implied

- **Side bets** (`SideBetSpec`, `SideBetDefinition`). Both games want per-arena
  or per-line tickets priced from the committed geometry, each with its **own**
  cap basis. This module has one cap basis per round — `round-external-stake` —
  and declares it. Per-line caps and side-bet pricing are a separate concern and
  would need either a second module or an extension with its own proof. This is
  SWARM §6.8 and half of §6.7.
- **An action chain.** SWARM §6.11 wants every mid-round `chain(i)` to be a
  prefix of the terminal chain bound into the settlement body. There is no chain
  here: mid-round state is exposed as receipts and a snapshot, and what binds the
  round is the commitment body over (tape, choices, steps). A consumer that needs
  the prefix property has to build it above this module or ask for it in one.
- **SWARM's branching population.** SWARM's organisms _split_: its population
  grows, and its draw consumption per stage is the population. This module
  resolves a shrinking subset of a fixed entity set and cannot express offspring.
  The cohort model is the largest single gap, and a `branching-population` module
  is the honest answer. The rest of SWARM's §6 list is accounted for item by item
  in §10.1 — several rows there are analogues or partials rather than matches,
  and none of them is a blanket claim.
- **Speed of play, expiry, seed chains** (`minGameCycleMs`, `expire()`,
  `buildSeedChain`). These are operator-protocol concerns that sit above a
  lifecycle module. Nothing here prevents them; nothing here implements them.

---

## 11. Certification boundary

This is a specification and an implementation of a derivation and replay path. It
is not a fairness certificate, an RNG certificate, a mathematical certification,
regulatory approval, or proof of a deployed game's RTP. The conformance suite
produces **evidence**, not certification: it establishes the mechanical
properties listed in §9 over the seeds it swept, and nothing beyond them. See
[`../certification-boundary.md`](../certification-boundary.md).
