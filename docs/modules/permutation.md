# The permutation lifecycle module

A round draws one **permutation of `n` labeled items** — which item settles into
which position — and settles a ticket of independent bets against a published
paytable. Every probability on the settlement path is an exact rational computed
by factorial enumeration. Nothing is simulated, nothing is sampled, and no IEEE
float appears on any money or probability path.

This document is the module's math. `docs/lifecycle-modules.md` is the platform
contract it implements; `src/modules/permutation/` is the implementation;
`tests/permutation-oracle.test.ts` is the independent oracle that checks every
number below.

| Contract slot  | This module                                                |
| -------------- | ---------------------------------------------------------- |
| `truth.kind`   | `permutation`                                              |
| `steps`        | ordering reveals, `n - 1` of them                          |
| `choiceTiming` | `none` — the ticket is not an input to the derivation      |
| `beliefSpace`  | `marginal`; `price()` counts, `belief()` is a display view |
| `book`         | `multi` position, `paytable` settlement                    |

## 1. Identity

```
moduleId          permutation
moduleVersion     1.0.0
transcript schema reveal-engine/permutation-transcript-v1
snapshot schema   reveal-engine/permutation-book-v1
receipt actions   place, settle
```

Supported draw sizes are `3 <= n <= 8`. The floor is 3 because at `n = 2` the
catalogue degenerates — `first`, `last` and `stack` all describe the same two
outcomes — and a one-bit truth is the progressive market's shape, not this one.
The ceiling is 8 because **every proof this module ships is exhaustive**:
conformance enumerates all `n!` truths and all `n!` Fisher-Yates draw vectors,
and `8! = 40,320` is the largest space that stays enumerable inside a CI step. A
larger draw could only be sampled, and a sampled proof reported as an exhaustive
one is the overclaim this repository exists to refuse.

## 2. The truth, and why it is uniform

`truth.derive(seed, definition, roundId)` returns
`uniformPermutation(seed, scope, 'order', n)` — core's seeded Fisher-Yates over
core's rejection sampler, used unmodified. The sampler scope is
`(definitionId, roundId, proofVersion)`, so two games and two rounds never share
a draw.

Uniformity rests on two lemmas and one stated assumption.

**Lemma A — the shuffle is a bijection.** Descending Fisher-Yates draws
`j_t` uniformly from `[0, n - t)` for `t = 0 .. n-2` and swaps index `n-1-t` with
index `j_t`. There are `n * (n-1) * ... * 2 = n!` draw vectors and `n!`
permutations, and the map between them is a bijection. This is **proved by
enumeration, not cited**: the `SHUFFLE_NOT_BIJECTIVE` conformance check walks
every draw vector, applies the schedule with its own independent implementation
of the swap loop, and requires every permutation to be produced exactly once.
The check runs for every shipped reference and its `drawVectors` counter is
asserted to equal `n!`, so a run that quietly covered less would fail.

**Lemma B — the sampler is unbiased.** `uniformBigInt` rejects any 256-bit draw
at or above `L = 2^256 - (2^256 mod M)`. `L` is divisible by `M`, so every
residue owns exactly `L / M` accepted values and there is no modulo bias, for
every modulus. That is core's property and core's test; this module does not
restate it and does not reimplement it.

**Assumption, stated rather than proved.** Lemma B gives uniformity _given_ that
the HMAC-SHA256 outputs are uniform and independent across `(label, counter,
rejection)`. That is the standard PRF assumption on HMAC-SHA256 keyed by a
uniformly drawn 32-byte seed. It is a cryptographic assumption, not a theorem,
and this repository does not attempt to prove it. Seed generation and custody
are the operator's, exactly as `docs/certification-boundary.md` states.

## 3. The steps: `n - 1` reveals, not `n`

`steps.derive` returns one reveal per position in settle order — position 0
first — and stops one short of the draw:

```
reveals[k] = { position: k, item: order[k] }        for k = 0 .. n-2
```

The final position carries **no information**: exactly one item remains and it
has one place to go. Emitting it would also drive the marginal belief vector to
all zeros, a state `weightVector` correctly refuses as an impossible round. The
settled order in full is the _truth_, which is bound into the commitment body
and carried on the wire, so a presentation layer renders the last slot from it.

The schedule is a pure function of the truth, and its **structure** — the
position sequence and the reveal count — is identical for every truth. Only the
items differ. `STEP_STRUCTURE_LEAKS_TRUTH` sweeps all `n!` truths and checks
exactly that, because a schedule whose shape varied with the answer would let a
player read the answer off the shape.

`belief()` is the per-item elimination view: weight `1n` for an unsettled item,
exactly `0n` for a settled one — never an epsilon. It is a display and
elimination view and **not** the pricing space; `price()` is.

## 4. The bet catalogue

Five families, matching the `full` / `slot` / `first` / `last` / `stack` codes of
the AETHER ORDER catalogue in `aether-order/docs/MATH.md` §3.

| Code    | Player picks              | Wins when                                                        | Parameters           |
| ------- | ------------------------- | ---------------------------------------------------------------- | -------------------- |
| `full`  | the complete order        | every item settles into exactly the chosen slot                  | `{ order }`          |
| `slot`  | one item and one position | that item settles into exactly that position                     | `{ item, position }` |
| `first` | one item                  | that item settles first                                          | `{ item }`           |
| `last`  | one item                  | that item settles last                                           | `{ item }`           |
| `stack` | two items, in order       | `before` settles into the position immediately preceding `after` | `{ before, after }`  |

Positions are 0-indexed and parameters are item indices — the same indices the
transcript's `order` array carries.

### 4.1 One representation for all five

Every family reduces to a **disjunction of partial assignments**, where an
assignment pins a set of positions to specific items and a permutation satisfies
it when every pin holds:

| Code                    | Assignments                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `full {order}`          | one, pinning every position                                  |
| `slot {item, position}` | one, pinning `position -> item`                              |
| `first {item}`          | one, pinning `0 -> item`                                     |
| `last {item}`           | one, pinning `n-1 -> item`                                   |
| `stack {before, after}` | `n - 1`, the `k`-th pinning `k -> before` and `k+1 -> after` |

That single representation is what makes the rest exact. Settlement is "does some
assignment hold in the settled order". Pricing is "how many completions of the
revealed prefix satisfy some assignment". Claim identity is the canonical form of
the assignment list.

**Exclusivity lemma.** The assignments a family emits are pairwise mutually
exclusive. Four of the five emit exactly one, so there is nothing to overlap. The
`stack` family emits `n - 1`, and assignment `k` pins `before` to position `k`:
no permutation places one item in two positions, so at most one of them can hold.

This lemma is not decoration — it is precisely what licenses the plain sum in
§5 with no inclusion-exclusion correction. It is checked from the other side
too: the oracle counts `stack` wins with `indexOf` on both items, knowing nothing
about assignments, and the two agree exactly over the whole order space at
`n = 5` and `n = 7`.

## 5. Exact pricing

**Setup.** After `m` positions have settled, the revealed prefix `P` is fixed and
the `n - m` unsettled items may complete the order in exactly `(n - m)!` ways.
Conditioning a uniform distribution on `S_n` by a prefix leaves a uniform
distribution over those completions, so every price is a counting measure

```
p = favourable / (n - m)!
```

and the only work is counting `favourable` exactly.

**Counting one assignment.** Let assignment `A` pin positions to items. Then:

- a pin on a **settled** position is already decided: if it disagrees with the
  reveal, `A` is impossible and contributes `0`; if it agrees, it consumes
  nothing;
- a pin on an **open** position must name an item that has not settled
  elsewhere — otherwise `A` is impossible — and consumes one open position.

With `f` pins landing on open positions, the remaining `n - m - f` items fill the
remaining `n - m - f` open positions freely:

```
count(A) = (n - m - f)!     if A is consistent with P
count(A) = 0                otherwise
```

**Counting a bet.** By the exclusivity lemma, no completion satisfies two
assignments of the same family, so

```
favourable(bet) = SUM over A in assignments(bet) of count(A)
```

with no correction term. `price()` is that sum over `countingProbability`, which
is `core/combinatorics.ts` and therefore BigInt throughout;
`ENGINE_LIMITS.maxBigIntBits` bounds any count a `Rational` could not carry, and
`8!` is nowhere near it.

### 5.1 Fresh prices, closed form

At `m = 0` the formula collapses to closed forms, derived here and checked
against the implementation instance by instance:

| Code    | Favourable                | Probability |
| ------- | ------------------------- | ----------- |
| `full`  | `1`                       | `1 / n!`    |
| `slot`  | `(n-1)!`                  | `1 / n`     |
| `first` | `(n-1)!`                  | `1 / n`     |
| `last`  | `(n-1)!`                  | `1 / n`     |
| `stack` | `(n-1) * (n-2)! = (n-1)!` | `1 / n`     |

`stack` reads as a block argument: glue the ordered pair into one unit, there are
`n - 1` positions the block can start at, and the other `n - 2` items fill the
rest freely. It comes out to `(n-1)!` — an ordered adjacent pair is exactly as
likely as a named item landing in a named position.

### 5.2 What the oracle establishes

`tests/permutation-oracle.test.ts` imports none of the module's counting
machinery. It generates permutations with Heap's algorithm rather than the
module's lexicographic walk, computes factorials in its own loop, and resolves
bets from the rules in prose. It runs four sweeps:

1. **Closed-form, `n = 5` and `n = 7`** — every instance of every family
   (175 and 5,145 respectively) priced against `favourable / n!`, compared as
   reduced fractions field for field.
2. **Exhaustive enumeration** — every non-`full` instance counted win by win
   over the whole order space (120 and 5,040 orders), assuming no closed form.
   `full` is handled by the statement that actually matters and is checked for
   every instance: the map from a full-order bet to the single order it wins on
   is a bijection onto `S_n`.
3. **Exhaustive conditional, `n = 5`** — all 206 reachable settle prefixes
   against all 175 instances, each compared to a brute-force count over the
   completions of that prefix. 36,050 comparisons. Repeated exhaustively at
   `n = 3`. This is the sweep that exercises the counting under partial
   information, which is where a wrong implementation would otherwise survive.
4. **Realised RTP** — the mean gross of complete tickets summed exactly over
   every outcome, required to equal `rho` exactly.

## 6. The paytable

A definition publishes one **total-return** multiplier per code. A winning line
returns `stake x multiplier`; a 1.00-credit line at `4.80x` returns 4.80, of
which 3.80 is profit.

**Pricing identity.** `m_b = rho / p_b` for every code, so
`E[return per unit staked] = p_b * m_b = rho` for every bet. This is enforced,
not documented: `definePermutationGame()` refuses to construct a definition whose
multiplier misses the identity by any amount, and `PRICING_IDENTITY_BROKEN`
re-establishes it independently for anything that reached the module without
going through the factory. Uniform RTP is a player-protection property, not a
marketing one — the rarest chip and the most frequent one carry the identical
edge, so chasing a big multiplier buys variance and never a worse deal.

The shipped references, all at `rho = 24/25` exactly (house edge `1/25` = 4.000%
of turnover, flat):

| Definition             | `n` | `n!`  | `full`    | `slot` / `first` / `last` / `stack` |
| ---------------------- | --- | ----- | --------- | ----------------------------------- |
| `triad`                | 3   | 6     | `144/25`  | `72/25`                             |
| `aether-order-classic` | 5   | 120   | `576/5`   | `24/5`                              |
| `aether-order-seven`   | 7   | 5,040 | `24192/5` | `168/25`                            |

The `n = 5` and `n = 7` rows are the AETHER ORDER CLASSIC and SEVEN figures,
transcribed from `aether-order/docs/paytable.json` and re-proved here.

**Theorem (zero rounding drift).** Every published multiplier has a denominator
dividing `stakeQuantum`, and every legal stake is a positive multiple of
`stakeQuantum`. Therefore `stake x multiplier` is an exact integer number of
minor units for every legal line, and the floor applied at the credit boundary is
a no-op.

This is stronger than the usual "a floor loses at most one minor unit per
payout": there is nothing to lose, so the realised RTP equals the theoretical RTP
with no truncation deficit at all. Both halves are enforced —
`definePermutationGame()` rejects a multiplier whose denominator does not divide
the quantum, `linePayout()` refuses a stake whose product is not an integer
rather than rounding it, and the oracle checks the whole legal stake ladder
against every multiplier.

**Cap headroom.** The round credit ceiling is `capBasisStake * maxWinMultiple`
and it is meant to be a liability guard, not a pricing lever.
`PRICING_IDENTITY_BROKEN` fails a definition whose largest multiplier can reach
the cap, because a cap a single winning line can touch means the advertised RTP
is not the RTP. On the shipped references the headroom is wide: `576/5 = 115.20`
and `24192/5 = 4838.40` against a `5000` cap.

## 7. Claim identity is behavioural

A ticket may not carry the same claim twice, and identity has to be
**behavioural** rather than nominal. `first {item}` and `slot {item, 0}` win on
the identical orders; so do `last {item}` and `slot {item, n-1}`. Admitting both
spellings would hand the per-line stake ceiling straight back — the whole budget
goes onto copies of the best line, spelled differently — and the round's maximum
credit would stop being a maximum.

`claimSignature()` digests the **canonical assignment form** (assignments sorted,
pins sorted by position, deduplicated, with `n` bound in), which is `O(n)` rather
than the `O(n!)` of a win-set bitmap. That the cheap identity agrees with
behaviour is not assumed: `CLAIM_IDENTITY_NOT_BEHAVIOURAL` enumerates the whole
order space, groups every non-`full` instance by win set and by signature, and
requires the two groupings to be _identical_ — so an alias the book would miss
and a collision the book would invent both fail. `full` is handled by an argument
that is itself checked: each instance wins on exactly the order it names, the map
is a bijection onto `S_n`, and every other family wins on `(n-1)! > 1` orders for
every supported `n`, so no `full` claim can alias anything.

The measured alias structure, emitted rather than described:

| Definition             | Instances | Distinct claims | Alias groups                                  |
| ---------------------- | --------- | --------------- | --------------------------------------------- |
| `triad`                | 27        | 21              | 6 (3 x `first = slot@0`, 3 x `last = slot@2`) |
| `aether-order-classic` | 175       | 165             | 10 (5 + 5)                                    |
| `aether-order-seven`   | 5,145     | 5,131           | 14 (7 + 7)                                    |

Every group has size exactly 2, which matches `aether-order/docs/MATH.md` §3.3
for the families both catalogues share.

## 8. The commitment

`commitmentBody` returns, through `encodeFields` (uint32 field count, then a
uint32 byte length and the bytes per field):

```
'Axiom Games Reveal Engine permutation commitment'
COMMITMENT_VERSION
moduleId
<definitionFields>            # module id and version, definition id and version,
                              # item count and items, rtp, every multiplier,
                              # cap, quantum, stake bounds, open-bet budget
fingerprint(definition)
roundId
proofVersion
n, order[0..n-1]              # truth.encode
reveals.length
position, item, ...           # steps.encode, per reveal
```

Two properties are load-bearing.

**The declared encoders are the proof-bearing ones.** `truth.encode` and
`steps.encode` are the same functions the body composes, not a second
description of the layout. `tests/permutation-module.test.ts` rebuilds the sealed
body out of nothing but the module's public declarations and shows that dropping
a field from either encoder makes the rebuild diverge — so declaration and proof
cannot drift apart while both look correct.

**`moduleVersion` is inside the fingerprint.** AETHER ORDER's reference
implementation lets the _game_ supply the bet catalogue as `(enumerate, resolve)`
pairs, so its fingerprint has to digest the catalogue's behaviour: reversing a
predicate would change how an open liability settles while leaving a declarative
fingerprint untouched. This module owns the catalogue instead — the five families
and their resolve semantics live in `bets.ts` and move only with
`PERMUTATION_MODULE_VERSION` — so binding that version is the exact equivalent,
at `O(1)` instead of `O(instances x n!)`. A module version bump moves every
fingerprint by construction, which is the correct blast radius for a behaviour
change.

There is no seed **pre**-commitment, and that is a consequence of
`choiceTiming: 'none'` rather than an omission: the contract requires one only
for a module whose steps depend on logged decisions. Here the ticket is not an
input to the derivation at all, so sealing the finished round already predates
every decision a player can make.

### 8.1 Verification

`verify(seed, definition, input)` runs the contract's required phase order:

1. decode the wire form (`fromWire`) — exact key sets, bounded strings,
   `order` validated as a genuine permutation, `reveals` as a well-formed settle
   prefix, no coercion anywhere;
2. compare definition id, version, and fingerprint, the last in constant time;
3. re-derive the order from the seed and compare;
4. re-derive the reveals and compare;
5. re-seal the commitment body and compare in **constant time**.

Every failure is one of the public codes — `INVALID_TRANSCRIPT`,
`UNSUPPORTED_VERSION`, `DEFINITION_MISMATCH`, `TRANSCRIPT_MISMATCH`,
`COMMITMENT_MISMATCH` — and every unexpected throw goes through
`classifyVerificationError`. A verifier answers "is this proof valid?" and never
leaks a parser stack trace to do it.

The codec deliberately does **not** cross-check the reveals against the order.
That is a re-derivation question, answered in phase 4 against the seed, and
answering it by comparing a document with itself would report a forged proof as
merely malformed.

## 9. The book

Several independent bets on one draw, settled together, from **one ledger**.

- **`place`** validates the bet, the per-line stake (quantum and bounds), the
  ticket ceiling, the open-bet budget, and behavioural distinctness; funds the
  stake as `external`, so **every bet raises the round's cap basis**. Pinning the
  ceiling to the first stake would crush a legitimate ticket: at a `10x` cap,
  1 quantum on a loser followed by the maximum on a winner would pay 10 against a
  real claim of tens of thousands. The per-line checks run before the ledger gate
  and the cumulative ticket ceiling runs inside it, so an idempotent retry is
  replayed rather than charged against the ceiling twice.
- **`settle`** takes the revealed seed and re-verifies the transcript through the
  module's own verifier before a single claim is scored, then credits
  `SUM of stake x multiplier` over the winning claims through
  `ledger.creditClaim()` — which prices, mints and credits as one step and
  therefore cannot half-perform the cap chain.

`restore()` re-validates rather than trusts, and every money-bearing field is
re-derived:

- each claim's **bet and stake** are pinned by the `place` receipt's own command
  fingerprint, so a rewritten ticket cannot survive its own log;
- each claim's **payout** is recomputed from `(code, stake)` and the published
  paytable, and is not in the snapshot at all — a money-bearing field a snapshot
  does not carry is one nobody can rewrite;
- the **settled order** is re-derived. A terminal snapshot carries the round id
  and the **revealed seed**, restore re-expands them through the module's own
  derivation, and the result must match the recorded order and commitment
  exactly — the commitment in constant time. The settle receipt's command
  fingerprint is then recomputed from that rebuilt transcript, so the
  money-bearing receipt is bound to a proof rather than to a claim about one;
- the **settled credit** is recomputed by scoring the restored claims against
  that re-derived order and re-applying the cap, then compared against the settle
  receipt;
- the **balances** are reconstructed from the receipt log and reconciled before
  `restoreBalances()` installs them.

Carrying the seed is what turns the snapshot from an assertion into something
checkable, and it costs nothing: revealing the seed is what closes the round, so
a terminal snapshot that carries it is exactly as disclosing as the transcript
the player already holds. **Reconciling the credit alone would not have been
enough.** Two different orders can pay a ticket the same amount — trivially, any
two under which every line loses — so a snapshot naming the wrong order would
have restored cleanly under a recomputed checksum, and a host would then have
shown a settled column that never happened. That gap is closed by re-derivation,
not by the hash.

The checksum is not the control. Anyone able to rewrite a field can recompute a
hash over it, so every tamper case in this module's tests and conformance
**re-seals** its mutation with a freshly computed `snapshotHash` and is judged on
the validation underneath. Two cases deliberately do not re-seal, and each says
so on the line above it: they exist to prove the checksum still catches plain
corruption, and neither stands in for a merits-based rejection.

## 10. No core was modified

This module is `src/modules/permutation/` and nothing else. No file under
`src/core/`, `src/api/`, or `src/internal/` was changed, and no `ENGINE_LIMITS`
value was added or moved. There is therefore no ADR here — the contract expressed
the shape as it stands.

Two places came close enough to be worth recording, because "we changed core to
make our module fit" is a claim that should never pass silently:

1. **The all-zero belief vector.** `weightVector` admits `2..maxOutcomes`
   entries with a strictly positive total, and a round that revealed all `n`
   positions would hand it a vector of zeros. Rather than relax core's bound —
   which exists because "every outcome is eliminated" is genuinely an impossible
   round — the module emits `n - 1` reveals, which is also the honest information
   content: the last position is forced. Core's rule turned out to be pointing at
   a modelling question, and answering it was the fix.
2. **No `INEXACT_PAYOUT` code.** The core taxonomy has no code for "this stake
   and multiplier do not produce an integer", which AETHER ORDER's game-specific
   reference does have. Adding one to `CORE_ERROR_CODES` would widen a public
   enum every host branches on, for a case that is already a refused claim. The
   module reports `CLAIM_REJECTED` with the path `$.stake` and a message that
   says what happened.

## 11. Relationship to AETHER ORDER

`aether-order/docs/ENGINE.md` specifies the adapter surface the game expects, and
this module is compatible with the part of it that concerns the draw and the
five families it ships. Shared and re-proved here: the item-index parameter
convention, the 0-indexed positions, the `full` bet parameterised by the **order**
rather than by a lexicographic rank, the `24/25` target RTP, the 25-chip stake
quantum, the behavioural distinct-claim rule, and the exact multipliers for both
variants. `tests/permutation-module.test.ts` carries that compatibility statement
as executable assertions rather than prose, so it cannot drift into a claim
nobody checks.

**What is not here, stated rather than implied by silence.** AETHER ORDER's
catalogue has eleven families; this module ships five. The other six — `before`,
`early`, `late`, `neighbours`, `opening`, `podium` — are not expressible as a
disjunction of _pairwise exclusive_ position pins the way these five are.
`before {a, b}` alone wins on `n!/2` orders and `early {c}` on a union of two
overlapping pin sets, so pricing them exactly needs a counting argument this
version does not implement. They are out of scope for `1.0.0`.

The engine-side surface also differs from the game's reference implementation in
shape, deliberately: this module has no `SeedContext` with a client seed or a
nonce, no chained `previousCommitment`, and no signed receipt. Those are round
_protocol_ concerns that the platform's `RoundIdentity`, `CommandLedger` and host
integration already own or that a host layers on top; reproducing them inside the
lifecycle module would fork the platform contract for one game. A port that needs
byte-identical AETHER ORDER commitments must use that repository's layout, which
is a different domain tag and a different field order; this module's commitment
is `reveal-engine/commit-v2` and is frozen in
`tests/fixtures/permutation-transcript-v1.json`.

## 12. What this document does not claim

It is engineering evidence: a specification, an exhaustive enumeration, a
re-derivable proof format, and deterministic frozen fixtures. It is **not** an
RNG certificate, a mathematical certification, a laboratory report, a regulatory
approval, or a certified RTP for any deployed game. The uniformity result in §2
is conditional on the stated PRF assumption and on the operator drawing server
seeds from a properly seeded CSPRNG under reviewed custody, neither of which this
repository can establish.

Commit-reveal proves the **draw**, not the **bet**. A transcript plus a revealed
seed lets anyone confirm the order was honest and lets nobody confirm who was on
it or for how much. The receipts this module's ledger mints are an internal
accounting record, not a signed non-repudiation artefact; binding a ticket to a
round under an operator key is a host-layer concern and this module does not
implement it. See `docs/certification-boundary.md`.
