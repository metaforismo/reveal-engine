# ADR 0010 — The game's engine contract is normative, so the module grew to meet it

- **Status:** accepted
- **Date:** 2026-07-29
- **Context branch:** `platform/permutation`
- **Relates to:** 0001 (branch adoption), 0004 (guard rails are part of the contract)

## Context

`src/modules/permutation/` shipped as a **platform-shaped** permutation lifecycle:
a `truth`/`steps`/`price`/`book` module that fits `docs/lifecycle-modules.md`,
owns a five-family bet catalogue, and derives from `(seed, definition, roundId)`.
It also shipped `aetherOrderClassicReference` and `aetherOrderSevenReference` as
conformance subjects and package-smoke assertions.

`aether-order/docs/ENGINE.md` is the consuming game's engine contract. It opens
by declaring itself normative — "the TypeScript module inside Reveal Engine must
produce **byte-identical** commitments, ticket digests, receipt digests and
signatures" — and its §10 porting checklist ends "if a single commitment digest
differs, the port is wrong". It ships a runnable reference implementation under
`tools/lib/` and freezes eight complete rounds in
`tests/fixtures/transcripts.json`.

An independent review found that **the module could not drive AETHER ORDER
although it shipped AETHER ORDER references**. Everything the contract requires
byte-for-byte differed, and seven things were simply absent:

1. six of eleven priced families — `before`, `early`, `late`, `neighbours`,
   `opening`, `podium` — and, worse, the module **owned** its catalogue rather
   than accepting ENGINE.md §4's adapter-supplied `BetFamily`
   `(enumerateInstances, resolve)` pairs, so an adapter could not add them;
2. `clientSeed`, so the player contributed nothing to the draw — removing the
   half of ENGINE.md §5's fairness model that says "the only degree of freedom
   left after publication belongs to the player";
3. `nonce`, `variantId`, `gameId`, `adapterVersion` and `previousCommitment`
   chaining, absent from both the derivation and the commitment body;
4. `seedCommitment` (§7.2) — the pre-round publication that makes the round
   non-grindable;
5. a different sampler label and payload (`'order'` under
   `reveal-engine/commit-v2` versus `'shuffle'` under
   `reveal-engine/permutation-v1` with the full round context);
6. `PERMUTATION_TICKET_SCHEMA`, `PERMUTATION_RECEIPT_SCHEMA` and
   `PERMUTATION_SNAPSHOT_SCHEMA`, named as constants with no structure behind
   them — no Ed25519 receipt, no derived idempotency keys, no play-policy digest;
7. `assertPermutationAdapterConforms(game)` (§8).

`docs/modules/permutation.md` §11.1 disclosed nearly all of this in an unusually
candid table, which is why the review graded it major rather than blocking. But
§11's opening sentence — "this module is compatible with the part of it that
concerns the draw" — was the loose claim: the draw is semantically compatible and
byte-incompatible, and a reader stops at the first sentence.

The governing rule for this kind of mismatch is that **a game repo's
`docs/ENGINE.md` is normative by default**: the module extends to satisfy it, and
only a requirement that is genuinely wrong or unimplementable at the exactness
bar justifies patching the game's document instead.

## Decision

**Nothing in ENGINE.md is wrong or unimplementable, so nothing in it was
patched.** `aether-order` is byte-unchanged by this round. The module grew.

### 1. The AETHER ORDER contract lands as `src/modules/permutation/aether/`

A new subtree implementing ENGINE.md §2, §4, §6, §7, §8 and §9, exported on its
own package subpath `@axiom-games/reveal-engine/modules/permutation/aether`. It
sits **beside** the platform module and changes none of its behaviour: every
existing proof byte, frozen fixture and conformance report is untouched.

Two surfaces, one repository, and that is deliberate rather than transitional:

|                               | `src/modules/permutation/`                         | `src/modules/permutation/aether/`                               |
| ----------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| Fits                          | `docs/lifecycle-modules.md`, the platform contract | `aether-order/docs/ENGINE.md`, the game contract                |
| Catalogue                     | owned by the module, five families                 | supplied by the adapter, eleven shipped as a reference          |
| Derivation                    | `(seed, definition, roundId)`                      | `(seed, game, {gameId, variantId, roundId, clientSeed, nonce})` |
| Registered in `listModules()` | yes                                                | no — it is not a lifecycle module                               |
| Money artefact                | `PermutationBook` claims + core receipts           | `Ticket`, `Settlement`, Ed25519 `PermutationReceipt`            |

Collapsing them into one was considered and rejected. The platform module's value
is that it landed inside a contract designed against four shapes without a core
change (ADR 0004, `docs/lifecycle-modules.md`); ENGINE.md's value is that it is a
game's byte-exact wire specification with an independent reference implementation
and frozen vectors. Forcing either into the other's shape would destroy the
property that makes it worth having. What was not acceptable was shipping AETHER
ORDER _references_ against a surface that could not drive AETHER ORDER.

### 2. The catalogue is adapter-supplied, per ENGINE.md §3 and §4

`BetFamily` carries `enumerateInstances(n)` and a pure
`resolve(instance, view)`. The eleven AETHER ORDER families live in
`aether/catalogue.ts` as a **reference adapter**, not as module-owned semantics,
so an integrator can supply a different catalogue and `definePermutationGame`
will price, digest and fingerprint it.

This changes what the fingerprint must bind. The platform module binds
`PERMUTATION_MODULE_VERSION` and argues (correctly, for it) that owning the
catalogue makes that equivalent to digesting behaviour at `O(1)`. Once the
adapter owns the predicates that argument dies: reversing one would change how an
open liability settles while leaving a declarative fingerprint untouched. So the
aether layer digests the catalogue **behaviourally** — every instance's label,
canonical parameter rendering and complete win/lose bitmap over all `n!`
permutations — exactly as ENGINE.md §4 requires, memoised at construction so the
cost is paid once per process (277 ms cold at `n = 7`, 27.6M predicate
evaluations) and never on a round path.

Pricing an arbitrary adapter family is exact by construction: probability is the
counting measure `wins / n!` as a BigInt `Rational`. The six families the
platform module could not price — because they are not disjunctions of pairwise
exclusive position pins — are priced here by enumeration, which is exact and is
what ENGINE.md specifies.

### 3. `ENGINE_LIMITS` is untouched; the error taxonomy grows by one array

ENGINE.md §9 requires eight codes the engine taxonomy does not have:
`INVALID_TICKET`, `UNKNOWN_BET`, `UNKNOWN_INSTANCE`, `DUPLICATE_LINE`,
`INEXACT_PAYOUT`, `SIGNATURE_UNCHECKED`, `CYCLE_FLOOR`, `BETTING_CLOSED`.

`src/api/errors.ts` gains `PERMUTATION_ERROR_CODES` as a **separate exported
array** merged into `ERROR_CODES`, plus a `PermutationErrorCode` type. It is the
only **source** file outside the new subtree that changed; the other three edits
are wiring — the `package.json` export subpath, its `scripts/package-smoke.mjs`
assertion, and a `.prettierignore` entry for the frozen fixture. Nothing under
`src/core/`, `src/internal/`, `src/protocol/`, `src/serialization/`,
`src/conformance/`, `src/integration/`, `src/reference/`, `src/cli/` or the
existing `src/modules/permutation/*.ts` files was touched, and the stress and
benchmark correctness digests are byte-unchanged, which is the mechanical
evidence for that claim.

`docs/modules/permutation.md` §10 previously argued against adding
`INEXACT_PAYOUT` to `CORE_ERROR_CODES`, on the grounds that it would widen a
public enum every host branches on for a case that is already a refused claim.
That argument stands and is why the codes are a _separate_ group rather than
appended to `CORE_ERROR_CODES`: a protocol reader can still see which public
contract introduced each wire code, and the platform module still reports its own
inexact payout as `CLAIM_REJECTED` at `$.stake`. What changed is that ENGINE.md
is a normative contract requiring these codes on the wire, which the earlier
argument was not weighing.

`PERMUTATION_LIMITS` (§9) is a module constant in `aether/identity.ts`, not an
addition to `ENGINE_LIMITS`.

### 4. Byte identity is proved against the game's own frozen vectors

`aether-order/tests/fixtures/transcripts.json` is copied verbatim into
`tests/fixtures/aether-order-transcripts.json` and
`tests/aether-frozen-fixtures.test.ts` re-derives all eight rounds from
`serverSeed` and context, re-opens each ticket, re-settles it, re-makes and
re-signs each receipt, and requires **every** digest and the deterministic
Ed25519 signature to match: `seedCommitment`, `commitment`, `ticketDigest`,
`settlementDigest`, receipt `digest`, `signature`, `idempotencyKey` and both
variants' `adapterFingerprint`.

The fixture is a **frozen cross-repository wire contract**, not a generated
artefact: `npm run fixtures:update` does not write it, and a change to it is a
protocol change in the game repo that must be copied deliberately.

## Consequences

- No platform proof bytes moved. `permutation-transcript-v1`,
  `permutation-book-v2`, `transcript-v1/v2`, `receipt-v1`, `round-book-v1` and
  the `commit-v2` known-answer vector are unchanged, and the pre-existing suite,
  conformance run and package smoke are unchanged in content.
- `ERROR_CODES` grows by eight members. `CORE_ERROR_CODES` and
  `MODULE_ERROR_CODES` are unchanged, so a host branching on either is
  unaffected; a host exhaustively switching on `RevealEngineErrorCode` sees new
  members and needs a default arm, which is the intended blast radius for a new
  public wire vocabulary.
- `package.json` gains the `./modules/permutation/aether` subpath, asserted by
  `scripts/package-smoke.mjs`.
- The aether layer is **not** registered in `listModules()`. It is a game
  contract implementation, not a lifecycle module, and registering it would put
  a second `permutation`-shaped entry in a registry whose whole purpose is
  polymorphic dispatch over the platform contract.
- `docs/modules/permutation.md` §11 is rewritten. Its "compatible with the part
  of it that concerns the draw" opening is gone, and the divergence table now
  separates what the platform module does not have from what the aether layer
  now supplies.
- Two things ENGINE.md specifies remain unimplemented here and are named as
  such: the **round-cycle floor and rolling ceiling** (§5, `CYCLE_FLOOR`) and the
  **shared-chamber betting window** (`BETTING_CLOSED`) are RGS and session state,
  which this repository has none of — the same "specified only" status the game's
  own §10 reference map gives them. The codes exist so a host raises the right
  one; the enforcement is the host's.
