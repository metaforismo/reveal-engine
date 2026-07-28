# Repository threat model

## Overview

Reveal Engine™ is a private library and reference protocol for progressive-reveal instant games. Its primary runtime surfaces are adapter validation, exact pricing, deterministic outcome/evidence generation, commit-reveal verification, frame/action handling, receipt accounting, and snapshot restoration. CLIs, tests, benchmarks, and examples are supporting surfaces.

## Threat Model, Trust Boundaries, and Assumptions

Protected assets are the unrevealed seed, one precommitted truth/evidence transcript, adapter/config identity, exact price frame, original cap basis, money-movement receipts, terminal state, and replayable audit history.

- Player clients, network payloads, transcript files, action keys, expected revisions, and reconnect snapshots are attacker-controlled.
- Seeds, adapter selection, commitment publication timing, key custody, durable transactions, player authorization, balances, and callback ordering are operator/RGS-controlled.
- Adapter code, versions, CI/release artifacts, and dependency changes are developer-controlled.

The library assumes a cryptographically random 32-byte seed committed before actionable player information. Deterministic weighted truth derivation prevents post-seed truth selection but does **not** prevent an operator from grinding many seeds before publishing one. Production designs need auditable seed generation, publication ordering, retention, and preferably external/client entropy or an independently verifiable RNG source.

## Attack Surface, Mitigations, and Attacker Stories

| Attack story                                                         | Control / residual boundary                                                                                                            |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Delimiter or cross-field commitment collision                        | v2 length-prefixed typed fields; frozen collision vectors; v1 verification-only                                                        |
| Seed spelling, wrong purpose, modulus, game, round, or version reuse | canonical seed bytes and domain-separated HMAC payloads containing every domain field                                                  |
| Operator substitutes truth, evidence, or economics after commitment  | deterministic prior-weighted truth, deterministic evidence, and adapter fingerprint bound into v2 proof                                |
| Malicious/buggy adapter leaks truth through likelihood strength      | conformance compares schedule structure across every truth; adapter code remains trusted and must be reviewed/versioned                |
| Oversized transcript/BigInt/event/key denial of service              | public byte/count/bit limits and validation before derivation/hashing where possible                                                   |
| Stale or out-of-order price/callback                                 | monotonic frame fence and proof-bound settlement                                                                                       |
| Duplicate, re-entrant, or cross-action retry                         | serialized action queue plus command-bound idempotency fingerprint                                                                     |
| Sell/re-entry cap bypass                                             | first-entry cap basis persists; self-financing re-entry; already-liquid value reduces remaining credit cap                             |
| Exception opens an FSM terminal hole                                 | validate and compute receipt before state mutation; atomicity regressions                                                              |
| Reconnect state or receipt tampering                                 | snapshot checksum, adapter binding, evidence replay, receipt/accounting/cap validation; production still needs authenticated storage   |
| Shadow corpus deletes or relabels an economic delta                  | strict keys/reason taxonomy, canonical digest, frozen target replay, per-case signed deltas, and separate `ok`/`activationReady` flags |
| Recomputed corpus hash disguises changed engine targets              | current target truth/evidence/commitment/economics are independently replayed; mismatch is `target-drift`                              |
| Corpus digest is mistaken for publisher authenticity                 | SHA-256 detects mutation only; provenance/release signing and trusted artifact distribution remain adopter responsibilities            |
| Malicious CLI adapter module executes code                           | modules load only through explicit `--adapter-module`; corpus data cannot choose a path; local module is trusted executable code       |
| Tone/compliance logic changes math                                   | no presentation, content, jurisdiction, or compliance API exists in core                                                               |

Out of scope: player authentication/authorization, database isolation, seed vault/HSM, network TLS, operator insolvency, jurisdictional rules, front-end security, signed release/provenance infrastructure, and formal certification. Those can dominate deployment risk even if this library is correct.

## Severity Calibration (Critical, High, Medium, Low)

- **Critical:** remote or operator-reachable control that enables undetected outcome substitution, arbitrary payout/cap bypass, seed disclosure before commitment, or cross-player durable balance corruption.
- **High:** canonical proof collision, accepted forged settlement, deterministic cross-adapter state confusion, or replay race producing duplicate credits under realistic integration assumptions.
- **Medium:** bounded denial of service, misleading verifier taxonomy, corrupt reconnect state rejected only late, or adapter footgun requiring trusted developer error.
- **Low:** developer-only CLI ergonomics, documentation drift with no runtime effect, or performance regression below production relevance.

No vulnerability severity implies a certification conclusion; exploitability depends on the adopter's RGS, storage, authorization, and key-management boundaries.
