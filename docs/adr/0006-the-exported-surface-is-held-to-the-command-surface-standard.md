# ADR 0006 — The exported derivation surface is held to the command surface's standard

- **Status:** accepted
- **Date:** 2026-07-29
- **Context branch:** `platform/staged-survival`
- **Relates to:** `docs/modules/staged-survival.md` §4.9 and §7.3

## Context

`staged-survival` exports two kinds of function, and they were held to two
different standards.

The **command surface** — `SurvivalBook.enter/choose/resolve/bank/settle`,
`restore()`, `verify()`, `deserializeTranscript()` — is written against a hostile
caller. Every argument is validated before anything mutates, every failure is a
`RevealEngineError` with a code and a path, and an independent sweep confirms
those entry points are total: no payload makes them throw anything else, and no
payload pollutes a prototype.

The **derivation surface** — `laneSizes()`, `lanePartition()`,
`laneSurvivorDistribution()`, `survivorDistribution()`, `marginalSurvival()`,
`expectedSurvivors()`, `distributionTotal()`,
`expectedSurvivorsFromDistribution()`, `resolveStage()`, `threshold()`,
`liveAfter()`, `belief()`, `price()`, `stepsEqual()`, `choicesEqual()`,
`transcriptToWire()`, `serializeTranscript()`, `SurvivalBook.bankableAmount()` —
is exported at `./modules/staged-survival` for hosts to price and render from,
and it was written as if its arguments came from inside the module. Three
consequences, all found by re-derivation rather than by review:

1. **An unbounded allocation.** `laneSizes(contract, liveCount)` validated the
   width because the width is the loop's decrement, and validated only the sign
   of `liveCount` — which is the _length of the array the loop builds_. Measured:
   `3e7` allocated thirty million elements and returned; `1e9` spent five seconds
   and died with `RangeError: Invalid array length`.
2. **A wrong answer instead of a refusal.** `liveAfter()` read
   `steps[steps.length - 1]` and treated `undefined` as "no steps yet", so a
   one-element prefix holding a hole returned the full entity field and
   `price()` answered with a live entity's marginal for a corrupt prefix. A
   nullish element dereferenced null outright.
3. **47 untyped escapes.** A systematic sweep of every export against a matrix of
   malformed arguments found 47 `TypeError`s and `RangeError`s. None was
   reachable from an untrusted path. All 47 contradicted the module's own
   unqualified taxonomy claim.

## Decision

**One standard. Every exported function validates its own arguments, in the
module's taxonomy, before it reads them.**

Concretely, and these are the parts a consumer can observe:

- Every field size argument is bounded by `SURVIVAL_LIMITS.maxEntities`, not only
  by its sign — `laneSizes()`, `lanePartition()` (through it), `liveAfter()`'s
  entity count, `expectedSurvivors()`. The bound is an allocation bound: it is
  the largest field any definition can declare, so nothing legitimate is refused.
- Every helper that reads a `LaneProfile` runs `assertLaneProfile()` first: the
  structural subset those helpers need, held to the same ranges a _declared_
  contract is held to (`q` in `[0, 1)`, `c` in `(0, 1]`).
- `survivorDistribution(definition, contract, liveCount)` requires `contract` to
  be one `definition` declares, **by identity**.
- `resolveStage()` requires its draw sources to be callable and wraps whatever
  they throw in `DERIVATION_FAILED`, passing a `RevealEngineError` raised inside
  a source through unchanged.
- A malformed step prefix is `DERIVATION_FAILED`, and a hole in a prefix is a
  malformed prefix rather than an empty one.
- Every validator iterates **by index**. `forEach`, `map`, `every` and `reduce`
  skip holes, so a sparse array would otherwise pass the check written for it.

The two behaviour changes a consumer could notice are the field-size bound and
the contract-identity requirement. Both are refusals of arguments that had no
correct answer to begin with: a thirty-million-entity field is not a field this
module can run, and a foreign contract's law is not a law any round of the given
definition could realise — its denominators need not divide that definition's
`drawModulus`, so no threshold it can build corresponds to the probabilities
being convolved. Identity rather than structural equality is the test because
every accessor a host reaches a contract through — `definition.contracts`,
`contractMenu()`, `contractFor()` — hands back the declared object.

**The same standard closes the trailing decision in `restore()`.** Every choice
with a resolved step was re-validated through `assertStepGeometry()` ->
`contractFor()`; the pending one had no step, so it arrived through nothing but
the structural wire parse. `restore()` now runs the call `choose()` runs, on the
field the decision faces. This is the third instance of one failure shape in this
module — after `enter -> bank -> enter` and the lane-geometry drift between
`resolve()` and `restore()` — and it is the same fix each time: the reconnect
path and the live path admit exactly the same states, from the same code.

## Consequences

- A host that passed a structural _clone_ of a declared contract to
  `survivorDistribution()` now gets `INVALID_CHOICE`. No shipped caller does; the
  conformance checks, the oracle test and the module suite all pass the declared
  object. `marginalSurvival()`, `laneSurvivorDistribution()` and
  `expectedSurvivors()` deliberately keep taking a bare contract, because they do
  not take a definition and have nothing to check membership against — they check
  the profile instead.
- The validation is not free, but it is bounded and small: the widest path is
  `assertLaneProfile()` on every `marginalSurvival()` call, which is two
  `rational()` constructions and two comparisons. Conformance and the benchmark
  are unchanged within run-to-run noise.
- A partial-validation _policy_ is now the thing under test rather than a
  particular list of arguments: the sweep runs every exported entry point against
  a shared junk matrix and asserts only that nothing untyped escapes, so a new
  export that forgets its guards fails it without anyone remembering to add a
  case.
- What this does **not** change: no core file, no wire format, no fingerprint, no
  commitment body, no derived value. Every frozen fixture is byte-identical and
  both stress replay anchors are unmoved.

## Alternatives considered

- **Qualify the claim instead of moving the helpers** — document that the
  taxonomy covers the command surface and that helpers are "trusted-caller". It
  is honest, it is cheaper, and it was rejected: the helpers are exported for
  hosts, an exported function that throws `TypeError` on a bad argument is a
  worse integration experience than one that names the argument, and the
  allocation and wrong-price defects above are not ergonomic issues at all.
- **Validate by structural equality rather than identity** in
  `survivorDistribution()` — accept any contract deep-equal to a declared one. It
  admits the same set of _correct_ calls and costs a deep comparison on every
  call, so it buys nothing except tolerance for a caller that cloned an object it
  did not need to clone.
- **Bound `laneSizes()` by `laneWidth * maxEntities` rather than
  `maxEntities`** — marginally more permissive, and there is no caller that wants
  it: a field is a set of entities and `SURVIVAL_LIMITS.maxEntities` is how many
  there can be.
