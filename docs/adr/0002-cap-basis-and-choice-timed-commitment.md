# ADR 0002 — The cap basis is per-round funding, and choice-timed rounds commit twice

- **Status:** accepted
- **Date:** 2026-07-29
- **Context branch:** `platform/core`
- **Supersedes:** the single-basis cap chain described in 0.2's `round-book.ts`

## Context

Extracting a game-agnostic core from BLACK SIGNAL's engine meant deciding which
of the progressive market's assumptions were _engine_ rules and which were
_that game's_ rules. Two of them turned out to be the second kind, and both had
to change before the next three modules could be built on the contract.

### 1. The cap basis was pinned to the round's first stake

`adoptCapBasis(stake)` returned `capBasisStake ?? stake`: the first stake of a
round fixed the ceiling forever, and `creditWithinCap()` and `restoreBalances()`
both enforced it. That is exactly right for the progressive market, where a
round holds one position at a time and every re-entry is financed out of
liquidated winnings — there is only ever one lot of external money.

It is wrong for any book with several simultaneous positions. Staking 1 on a
loser and then 10,000 on a winner under a 10x cap produced a legitimate claim of
38,800 and credited 10, because the ceiling had been fixed at `1 * 10`. Both of
the next two modules need multiple positions per round.

### 2. A choice-timed round had no commitment scheme at all

`sealCommitment(seed, body)` requires the finished transcript. A module whose
steps depend on decisions made during the round does not have one until the
round ends — but the first decision must already be covered by something
published, or the operator can pick the seed after seeing it. The contract
pointed at `RandomTape` for interleaving, which proves determinism and says
nothing about _when_ the seed was chosen. `staged-survival` is unbuildable
without an answer.

## Decisions

### The cap basis accumulates externally funded stakes only

`CommandLedger.fundStake(amount, funding)` replaces `adoptCapBasis` and
`applyDebit`. The only distinction that matters is where the money came from:

- `external` — new money from the player's wallet. It accumulates into the
  basis, because the ceiling is a multiple of what the player actually risked.
- `recycled` — value already won inside this round, put back at risk. Debited
  from the liquid balance, and it never grows the basis.

The invariant is unchanged and now stated in `docs/architecture.md`:
`liquidBalance <= capBasisStake * maxWinMultiple`. Because every credit is
bounded by `ceiling - liquidBalance`, and a recycled stake only decreases
`liquidBalance` without moving the ceiling, the round's total payout is still
bounded by `maxWinMultiple` times the money the player brought in.

Rejected alternatives:

- **Per-position `CommandLedger` instances.** Each ledger has its own command
  queue and its own dense revision chain, so this would fork the serialization
  order and the single monotonic ledger revision the snapshot format depends on.
  One ledger per round is now stated as a rule, not an accident.
- **Letting every stake grow the basis.** A win could then finance a larger
  ceiling and the round's maximum exposure would be unbounded.
- **Leaving it and telling module authors to bypass the ledger.** The contract
  documents core as owning the cap chain; a module reimplementing it is exactly
  the failure the extraction was meant to prevent.

Consequence for the progressive market: none that is replay-visible. Its first
open is `external` and every re-entry is `recycled`, which is byte-for-byte the
old behaviour — the seeded stress workload's `correctnessDigest`
(`fdb9e9b8…baef1`) is unchanged.

### Choice-timed rounds publish a seed commitment first

`sealSeedCommitment(seed, binding)` seals the seed alone, under a different
domain tag from the body commitment, binding the module id, the definition id,
the **definition fingerprint** (so the economics are frozen too), the round id,
and the proof version. `TranscriptModel.seedCommitment` is required whenever
`choiceTiming` is not `none`, and `defineLifecycleModule()` enforces that.

`TranscriptModel.commitmentBody` now takes the logged choices and must bind
them. Without that, an operator holding one published commitment could settle
the same round twice under different decision logs and both settlements would
verify.

Rejected alternatives:

- **Smuggling each choice inside the module's own `step` type.** It works, but
  the contract neither states it nor checks it, so it is a trap rather than a
  design.
- **Committing to the choice space up front.** That constrains the game rather
  than proving the seed, and it does not survive a variable-length decision log.

What this does **not** fix: seed grinding before publication. Both phases are
about ordering _within_ a round. Grinding is a custody and publication-ordering
control and stays out of scope, stated as such in the threat model.

## Consequences

- `ENGINE_LIMITS.maxLoggedChoices` and `maxRoundClaims` became enforceable and
  are now enforced at the contract boundary rather than published and ignored.
- Both decisions are proved by test-only modules under `tests/support/` rather
  than by the progressive market, which exercises neither.
- The public `/core` surface gains `fundStake`'s type, `sealSeedCommitment`,
  and the counting primitives, and loses three duplicate validators left over
  from the extraction.
