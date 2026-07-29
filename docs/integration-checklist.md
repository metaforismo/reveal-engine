# Integration checklist

- [ ] Commitment is durably published before entries and any seed-dependent information.
- [ ] For a module whose steps consume player decisions, the **seed pre-commitment** is published before the round accepts its first decision, and the settlement transcript's choice log is the one the round actually played.
- [ ] Seed generation/grinding controls, key custody, rotation, reveal timing, and retention are documented.
- [ ] Module ID/version, definition ID/version/fingerprint, and all wire schema versions are persisted per round.
- [ ] The definition passes `reveal-conformance` with retained machine-readable output.
- [ ] Player/tenant authorization and wallet transaction are outside but atomic with the engine receipt.
- [ ] Every claim command uses the authoritative current belief state and the exact expected step revision.
- [ ] Every applied step is **derived by the host from the sealed truth** — for `sequential-cards`, by `deriveRevealSteps()` against the sealed deal — and never taken from a client or reconstructed by hand. A book holds no seed, so it validates a step as public record and cannot establish that it came from the committed deal; a fabricated but well-formed step is applied, and a mid-round liquidation credits against it before settlement can refuse the round.
- [ ] Idempotency key is scoped by player and round in durable storage; payload mismatch is a conflict.
- [ ] Settlement accepts only a verified seed and transcript and cannot run before every step is applied.
- [ ] Snapshot storage is authenticated; restore failures quarantine rather than repair balances silently.
- [ ] Cap basis and liquid value reconcile against wallet history after every action, and every stake is classified as external or recycled at the wallet boundary — a recycled stake that is recorded as external raises the round's ceiling.
- [ ] Ride/continuation has a separately reviewed state machine and economics model.
- [ ] Load, reserve, RNG, game math, jurisdiction, responsible-play, and certification reviews cover the deployed configuration.
