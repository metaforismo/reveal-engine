# Architecture

Reveal Engine is a game-agnostic core plus lifecycle modules as siblings. Core
never learns what a game is; a module never reimplements arithmetic, sampling,
sealing, or accounting.

## Layers

| Layer                  | Responsibility                                                              | Deliberate boundary                        |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| `src/api`              | versions, limits, typed errors                                              | no algorithms                              |
| `src/core`             | exact math, weights, seeded RNG, commitments, payments, ledger, wire safety | no adapter, posterior, transcript, or book |
| `src/core/module.ts`   | the lifecycle-module contract                                               | types and validation only                  |
| `src/modules/<id>`     | one game lifecycle: truth, steps, book, transcript, verifier, checks        | owns its own schemas and versions          |
| `src/modules/index.ts` | static module registry                                                      | in-tree modules only                       |
| `src/conformance`      | module-agnostic conformance runner and report                               | evidence, not certification                |
| `src/integration`      | illustrative RGS boundary                                                   | not production persistence                 |
| `src/cli`              | independent verifier and conformance tools                                  | revealed seeds only                        |
| `src/internal`         | canonical encoding                                                          | not exported on any package subpath        |

`src/protocol`, `src/serialization`, and `src/reference` remain as deprecated
one-line aliases into `src/modules/progressive-market/`. They exist so an
existing import keeps working; new code should use
`./modules/progressive-market`.

## Core primitives a module builds on

- `rational.ts` — reduced BigInt rationals; the only numeric type in a money path.
- `weights.ts` — exact non-negative belief weights. Zero is legal, so a reveal
  can eliminate an outcome to _exactly_ zero rather than to an epsilon; the
  total must stay positive.
- `random.ts` — `uniformBigInt` (rejection sampling, domain separated by
  definition id, round id, proof version, label, and counter),
  `uniformPermutation` (seeded Fisher-Yates for deck shuffles and ordering
  truths), and `RandomTape` (a recorded, replayable expansion of one seed, for
  lifecycles whose randomness interleaves with logged player choices).
- `commitment.ts` — `sealCommitment(seed, body)`. A module supplies canonical
  bytes; core decides how a seed binds them.
- `payments.ts` — floor rounding and the chain cap.
- `ledger.ts` — `CommandLedger`: one command at a time, an idempotency key bound
  to its exact payload fingerprint, a receipt minted before state mutates, and a
  cap basis fixed by the round's first stake.
- `snapshot.ts` — strict, fail-closed reconnect wire helpers.
- `verification.ts` — the six-code verification taxonomy and the classifier that
  keeps incidental exceptions from leaking.

## Money and state invariants

Exact values stay reduced rational BigInts. A claim holds a rational contingent
payout; only liquidation or settlement calls payable rounding and the cap.

The step (frame) revision and the ledger revision are separate monotonic
counters, so a duplicate command cannot create a stale price and a new step
cannot impersonate a money movement. Each successful command is bound to its
idempotency key by a canonical fingerprint: an exact retry replays its receipt, a
changed payload or action fails with `IDEMPOTENCY_CONFLICT`, and a failed
operation does not mutate state.

Snapshot restoration replays steps, validates definition identity, receipt
ordering and accounting, cap state, and a deterministic snapshot checksum. That
checksum detects corruption and supports deterministic replay; it is **not** an
operator signature. Production storage still needs authenticated records and a
transaction around idempotency, debit/credit, state transition, and receipt
append.

## Adding a module

See [`lifecycle-modules.md`](lifecycle-modules.md). In short: implement the six
contracts, reuse core, freeze a wire fixture, declare conformance checks,
register the module, and extend the export map and the public-API snapshot test.
