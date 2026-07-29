# Repository threat model

## Overview

Reveal Engine is a library and reference protocol for provably-fair instant games: a game-agnostic core plus lifecycle modules. Core's runtime surfaces are seeded rejection sampling, commit-reveal sealing, exact rational arithmetic, payable/cap arithmetic, the command ledger, and the wire-safety helpers. A lifecycle module adds definition validation, truth and step derivation, its own transcript codec and verifier, and its round book. CLIs, tests, benchmarks, and examples are supporting surfaces.

## Threat Model, Trust Boundaries, and Assumptions

Protected assets are the unrevealed seed, one precommitted truth/step transcript, module and definition identity, the exact price frame, the original cap basis, money-movement receipts, terminal state, and replayable audit history.

- Player clients, network payloads, transcript files, action keys, expected revisions, and reconnect snapshots are attacker-controlled.
- Seeds, module and definition selection, commitment publication timing, key custody, durable transactions, player authorization, balances, and callback ordering are operator/RGS-controlled.
- Module code, definition code, versions, CI/release artifacts, and dependency changes are developer-controlled.
- A lifecycle module runs **inside** the settlement path. Module code is trusted code: it is reviewed, versioned, and in-tree, and the contract in `lifecycle-modules.md` is a design discipline, not a sandbox.

The library assumes a cryptographically random 32-byte seed committed before actionable player information. Deterministic weighted truth derivation prevents post-seed truth selection but does **not** prevent an operator from grinding many seeds before publishing one. Production designs need auditable seed generation, publication ordering, retention, and preferably external/client entropy or an independently verifiable RNG source.

## Attack Surface, Mitigations, and Attacker Stories

| Attack story                                                         | Control / residual boundary                                                                                                         |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Delimiter or cross-field commitment collision                        | v2 length-prefixed typed fields; frozen collision vectors; v1 verification-only                                                     |
| Seed spelling, wrong purpose, modulus, game, round, or version reuse | canonical seed bytes and domain-separated HMAC payloads containing every domain field                                               |
| Operator substitutes truth, evidence, or economics after commitment  | deterministic prior-weighted truth, deterministic evidence, and adapter fingerprint bound into v2 proof                             |
| Malicious/buggy definition leaks truth through likelihood strength   | conformance compares schedule structure across every truth; definition code remains trusted and must be reviewed/versioned          |
| A new lifecycle module reimplements sampling, sealing, or cap math   | core owns all four; a module that bypasses them is a review failure, not a runtime-detectable condition                             |
| A module accepts an unknown transcript or snapshot schema            | `acceptedSchemas` is declared and unknown versions fail closed with `UNSUPPORTED_VERSION`                                           |
| Oversized transcript/BigInt/event/key denial of service              | public byte/count/bit limits and validation before derivation/hashing where possible                                                |
| Stale or out-of-order price/callback                                 | monotonic frame fence and proof-bound settlement                                                                                    |
| Duplicate, re-entrant, or cross-action retry                         | serialized action queue plus command-bound idempotency fingerprint                                                                  |
| Sell/re-entry cap bypass                                             | first-entry cap basis persists; self-financing re-entry; already-liquid value reduces remaining credit cap                          |
| Exception opens an FSM terminal hole                                 | validate and compute receipt before state mutation; atomicity regressions                                                           |
| Reconnect state or receipt tampering                                 | snapshot checksum, definition binding, step replay, receipt/accounting/cap validation; production still needs authenticated storage |
| Tone/compliance logic changes math                                   | no presentation, content, jurisdiction, or compliance API exists in core                                                            |

Out of scope: player authentication/authorization, database isolation, seed vault/HSM, network TLS, operator insolvency, jurisdictional rules, front-end security, and formal certification. Those can dominate deployment risk even if this library is correct.

## Severity Calibration (Critical, High, Medium, Low)

- **Critical:** remote or operator-reachable control that enables undetected outcome substitution, arbitrary payout/cap bypass, seed disclosure before commitment, or cross-player durable balance corruption.
- **High:** canonical proof collision, accepted forged settlement, deterministic cross-module or cross-definition state confusion, or a replay race producing duplicate credits under realistic integration assumptions.
- **Medium:** bounded denial of service, misleading verifier taxonomy, corrupt reconnect state rejected only late, or a module/definition footgun requiring trusted developer error.
- **Low:** developer-only CLI ergonomics, documentation drift with no runtime effect, or performance regression below production relevance.

No vulnerability severity implies a certification conclusion; exploitability depends on the adopter's RGS, storage, authorization, and key-management boundaries.
