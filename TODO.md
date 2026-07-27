# Reveal Engine 0.2 hardening checklist

- [x] Record the pre-implementation gaps and risks in `docs/upgrade-gap-audit.md`.
- [x] Freeze a versioned public API, adapter fingerprint, and typed failure taxonomy.
- [x] Add strict wire codecs, legacy transcript migration, deterministic replay, and frozen fixtures.
- [x] Bind commit/reveal to canonical fields, deterministic truth, adapter economics, and model version.
- [x] Harden stale-frame, idempotency, race, settlement, snapshot, accounting, and chain-cap behavior.
- [x] Prove generality with four-outcome, three-outcome, and two-outcome adapters plus conformance tooling.
- [x] Add independent mathematical oracles, deterministic property seeds, adversarial tests, and real-path stress.
- [x] Add export/package smoke checks, a Node compatibility matrix, coverage gates, security checks, and bounded load CI.
- [x] Record final local evidence and prepare scoped implementation/evidence commits.
- [ ] Hosted Actions execution (externally blocked by the account billing/spending limit; no runner steps execute).

## Non-negotiable boundaries

- This repository is proprietary and private. No publishing, announcement, or certification claim is authorized.
- `BLACK SIGNAL` is a reference integration only. Its art, UI, narrative, and source content do not belong here.
- Engine math never receives tone, compliance copy, or player-facing presentation decisions.
