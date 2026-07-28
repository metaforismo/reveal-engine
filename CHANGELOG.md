# Changelog

## 0.3.1 — 2026-07-28

- Moved the single authoritative BLACK SIGNAL compatibility corpus to `compatibility-corpora/black-signal-v1.json` and exported its unchanged bytes as `@axiom-games/reveal-engine/compatibility/corpora/black-signal-v1.json`.
- Strengthened package smoke to install the generated tarball, resolve every supported code subpath plus the corpus export, verify corpus SHA-256, and replay all 64 vectors / 4,096 economic cases with zero unexplained or target-drift findings.
- The packaged corpus remains pinned to engine behavior 0.3.0 and reports `activationReady: false`; 0.3.1 does not claim title adoption, migration, or certification.

## 0.3.0 — 2026-07-28

- Added strict `compatibility-corpus-v1` parsing, canonical integrity, typed failures, deterministic shadow comparison, `compatibility-report-v1`, and `reveal-compatibility` CLI/package export.
- Added a provenance-locked BLACK SIGNAL fixture with 64 derivation vectors, 256 posterior checkpoints, 4,096 economic cases, explicit legacy/proof/rounding classifications, and cap vectors generated from the read-only title revision.
- Corrected the BLACK SIGNAL reference to derive two continuations at 95.5% RTP/85% floor, bumped its adapter version to 1.1.0, and covered the full 97.0/96.5/95.5/94.5 ladder.
- Added tamper, malformed-schema, target-drift, unexplained-money, deterministic replay, adapter-isolation, cap, and idempotency regressions.
- The package remains private, UNLICENSED, and unpublished; no title adoption or certification is claimed.

## 0.2.0 — 2026-07-27

- Added the stable `api-v1` adapter/public contract, deep runtime validation, typed errors, adapter fingerprints, and mechanical conformance.
- Replaced ambiguous proof encoding with `commit-v2`, deterministic prior-weighted truth, bounded canonical transcript codecs, detailed failure taxonomy, and frozen v1/v2 fixtures.
- Rebuilt protocol frames, exact claims, command-bound idempotency, proof-bound settlement, cap-chain accounting, receipts, snapshots, and deterministic reconnect replay.
- Expanded independent oracle, exhaustive, deterministic property, malformed-input, adversarial race, serialization, package, stress, benchmark, and security evidence.
- Legacy `commit-v1` remains verification-only.

## 0.1.0 — 2026-07-27

- Initial private Axiom Games Reveal Engine™ foundation with two reference adapters and basic verification tooling.
