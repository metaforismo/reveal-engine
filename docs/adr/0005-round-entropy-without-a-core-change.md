# ADR 0005 — Player entropy rides in the round id, and core does not change

- **Status:** accepted
- **Date:** 2026-07-29
- **Context branch:** `platform/staged-survival`
- **Relates to:** the lifecycle-module contract (`docs/lifecycle-modules.md` §2, §4)

## Context

Both build-ready games that consume `staged-survival` name the same threat as
their highest-severity failure, and both close it the same way.

BRANCHFALL (`branchfall/docs/ENGINE.md` §10.1) measures it: with a server-only
seed, an operator that draws a seed, derives the whole hazard table, and only
then publishes a commitment can keep the worst-for-player candidate out of `B`
draws for the cost of ~120 HMAC evaluations. Realised return against the
published policy goes from 0.955 at `B = 1` to ~0.00 at `B = 64`, and **every one
of those rounds verifies**. SWARM (`swarm/docs/ENGINE.md` §4.5) reaches the same
conclusion from a different direction: a single grind target — three draws in the
DIE band, about 16 attempts — simultaneously zeroes the colony line and three of
four side bets.

The control both specify is publication ordering plus player-contributed
entropy: the operator seals a seed against a named round **before** the entropy
exists, the player then contributes entropy the operator could not have
predicted, and every draw is a function of both. Grinding before publication is
grinding against an unknown.

The platform contract has no place to put that second value. `TruthModel.derive`
is `(seedHex, definition, roundId)`; `definition` is the frozen, fingerprinted
game configuration and cannot carry a per-round value; and core's `SamplerScope`
is `{domain, roundId, proofVersion}`. Two of those three fields are fixed by the
module's identity. So the entropy has exactly one carrier available to it: the
round id.

## Decision

**A `staged-survival` round is identified by a pair, and its canonical string
form is the module's round id.**

```ts
interface RoundRef {
  readonly roundId: string; // operator round id, no '|', <= 63 bytes
  readonly clientEntropy: string; // exactly 32 bytes, lowercase hex
}

roundRefId({ roundId, clientEntropy }) === `${roundId}|${clientEntropy}`;
```

`roundRefId()` builds it, `parseRoundRefId()` is the untrusted-input boundary
that splits it back, and the separator is illegal inside an operator round id so
the split is unambiguous. Both halves reach `SamplerScope.roundId`, so both are
inside every draw. The transcript carries them as two separate wire fields and
the verifier recomputes the canonical form from them.

**The seed pre-commitment binds only the operator half.** `seedCommitment()`
parses the pair and seals `ref.roundId`, never `ref.clientEntropy`. That omission
is the mechanism, not an oversight: a commitment that moved with the entropy
could not have been published before the entropy was chosen, and a conformance
check (`SEED_PRECOMMITMENT_BROKEN`) asserts it does not move.

**Core is not modified.**

## Alternatives considered

1. **Widen `TruthModel.derive` to take an optional entropy argument.** This is
   the honest signature, and it is not one change but three: `derive`,
   `transcript.build` and `transcript.seedCommitment` all have to thread the same
   value, every existing module's declaration has to be re-typed, and
   `MODULE_API_VERSION` becomes a question. The contract went through an
   audit-and-closure cycle immediately before this module was written; widening
   three of its signatures for one module's need is not the smallest possible
   change.

2. **Add `entropy` to `SamplerScope` and fold it into the sampler payload.**
   Smaller in surface, larger in blast radius: it edits `uniformBigInt`, which is
   the one function every draw in every game goes through, and it would still not
   solve the problem — the value has no way to reach `truth.derive` in the first
   place.

3. **Put the entropy in the definition.** The definition is fingerprinted and
   frozen; a per-round value there would change the game's identity every round
   and make every transcript unverifiable against the adapter it was played on.

4. **Ship without entropy.** This is what the two consuming specs call an
   integration defect of the highest severity, with numbers attached. Declining
   to model the control at all, in a module written specifically for those two
   games, is worse than carrying it in a string.

## Consequences

**What this costs.** The module's `roundId` is not the host's round id, and a
caller that passes a bare identifier gets `INVALID_CONTEXT` rather than a round.
That is a real ergonomic cost and it is deliberate: the failure is loud, at the
first call, and it fails closed. A host that could silently omit the entropy
would be a host that silently loses the control.

The 128-byte identifier budget is split 63 / 1 / 64, so an operator round id
longer than 63 bytes is rejected. `MAX_ROUND_ID_BYTES` is exported so a host can
check it rather than discover it.

**What this does not do.** It does not enforce the publication ordering. Nothing
in a library can: wall-clock ordering is not a property of the arguments. The
module enforces what it can — the pre-commitment is independent of the entropy,
the entropy is inside every draw, and both are re-derived at verification — and
`docs/modules/staged-survival.md` §9 states the residual plainly, as
`docs/threat-model.md` does for the engine as a whole. It also does not help if
the "client" entropy is generated by the operator's own server and never changed;
that is the residual BRANCHFALL §10.1 and SWARM §8 both record, and this module
inherits it rather than quietly dropping it.

**What would change this decision.** If a second module needs a per-round player
contribution, the string carrier stops being a local convention and becomes a
pattern — and at that point the right move is alternative 1, done once, for the
contract rather than for one module.
